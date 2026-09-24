/**
 * events.jsonl: the append-only conversation log, and its projection into HistoryTurn[].
 * Frame: {"schema_version":1,"seq":N,"timestamp_ms":T,"event":{...}}. A partial trailing line is
 * tolerated (crash mid-write); a corrupt line anywhere else makes the session unreadable.
 */
import { appendFileSync, readFileSync, statSync, truncateSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionMemory, HistoryTurn, ImageRef, Message, ToolCall, ToolStatus } from "../agent/types.ts";
import { SessionError } from "./id.ts";
import { EVENTS_FILE } from "./layout.ts";

export type ToolResultEvent = {
  type: "tool_result";
  call_id: string;
  tool_name: string;
  status: ToolStatus;
  inline_output?: string;
  /** Relative to the session dir, e.g. "results/<call_id>.txt". Set when the output exceeded 16 KiB. */
  artifact_ref?: string;
  output_bytes: number;
  stored_bytes: number;
  completeness: "complete" | "partial" | "unknown";
  preview?: string;
  /** Permission feedback the user typed while this call was pending. */
  feedback?: string[];
  command_output_handle?: string;
};

export type SessionEvent =
  | { type: "user"; text: string; images: ImageRef[] }
  | { type: "assistant"; text: string }
  | { type: "tool_call"; call_id: string; tool_name: string; arguments_json: string }
  | ToolResultEvent
  | { type: "steering"; text: string }
  | { type: "turn_completed" }
  | { type: "interrupted"; reason: "cancelled" | "failed"; partial_text: string | null; origin?: "turn" | "compaction" }
  | { type: "context_checkpoint"; covers_through_seq: number; summary: string };

export type EventFrame = { schema_version: 1; seq: number; timestamp_ms: number; event: SessionEvent };

export const eventsPath = (dir: string) => join(dir, EVENTS_FILE);

/** Appends one frame; `seq` is 1-based and the caller tracks it (single writer per session). */
export function appendEvent(dir: string, seq: number, timestamp_ms: number, event: SessionEvent): EventFrame {
  const frame: EventFrame = { schema_version: 1, seq, timestamp_ms, event };
  appendFileSync(eventsPath(dir), `${JSON.stringify(frame)}\n`, { mode: 0o600 });
  return frame;
}

export type ReadEvents = { frames: EventFrame[]; readable_bytes: number; total_bytes: number };

/** Reads every complete frame. Stops at a corrupt line: `partial` is thrown unless it is the unterminated tail. */
export function readEvents(dir: string): ReadEvents {
  let raw: string;
  try {
    raw = readFileSync(eventsPath(dir), "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { frames: [], readable_bytes: 0, total_bytes: 0 };
    throw err;
  }
  const total_bytes = Buffer.byteLength(raw);
  const frames: EventFrame[] = [];
  let offset = 0;
  while (offset < raw.length) {
    const end = raw.indexOf("\n", offset);
    if (end === -1) break; // unterminated tail: tolerated
    const line = raw.slice(offset, end);
    const frame = parseFrame(line, frames.length + 1);
    if (!frame)
      throw new SessionError("unreadable", `corrupt event at line ${frames.length + 1} of ${eventsPath(dir)}`);
    frames.push(frame);
    offset = end + 1;
  }
  return { frames, readable_bytes: Buffer.byteLength(raw.slice(0, offset)), total_bytes };
}

/** The frames before the first corrupt line, for `session recover`. */
export function readReadablePrefix(dir: string): ReadEvents {
  try {
    return readEvents(dir);
  } catch (err) {
    if (!(err instanceof SessionError && err.code === "unreadable")) throw err;
  }
  const raw = readFileSync(eventsPath(dir), "utf8");
  const frames: EventFrame[] = [];
  let offset = 0;
  for (;;) {
    const end = raw.indexOf("\n", offset);
    if (end === -1) break;
    const frame = parseFrame(raw.slice(offset, end), frames.length + 1);
    if (!frame) break;
    frames.push(frame);
    offset = end + 1;
  }
  return { frames, readable_bytes: Buffer.byteLength(raw.slice(0, offset)), total_bytes: Buffer.byteLength(raw) };
}

function parseFrame(line: string, expectedSeq: number): EventFrame | undefined {
  let f: EventFrame;
  try {
    f = JSON.parse(line);
  } catch {
    return undefined;
  }
  if (f?.schema_version !== 1 || f.seq !== expectedSeq || typeof f.timestamp_ms !== "number") return undefined;
  if (!f.event || typeof f.event.type !== "string") return undefined;
  return f;
}

/** Drops the unterminated tail so the next append starts on a fresh line. */
export function truncateToReadable(dir: string, read: ReadEvents) {
  if (read.readable_bytes === read.total_bytes) return;
  truncateSync(eventsPath(dir), read.readable_bytes);
}

export const eventsBytes = (dir: string) => {
  try {
    return statSync(eventsPath(dir)).size;
  } catch {
    return 0;
  }
};

// ---- projection -------------------------------------------------------------------------------

export type Projection = { turns: HistoryTurn[]; closeSeqs: number[]; lastSeq: number };

type Open = {
  user: { text: string; images?: ImageRef[] };
  steps: ExecutionMemory["steps"];
  steering: ExecutionMemory["steering"];
  assistant: string | null;
  calls: ToolCall[];
  results: Extract<Message, { role: "tool" }>[];
  feedback: Extract<Message, { role: "user" }>[];
};

/** Replays the log into committed turns. An unclosed turn at the end is in flight and belongs to recovery.json. */
export function projectHistory(frames: EventFrame[]): HistoryTurn[] {
  return project(frames).turns;
}

export function project(frames: EventFrame[]): Projection {
  const turns: HistoryTurn[] = [];
  const closeSeqs: number[] = [];
  let open: Open | undefined;

  const flushStep = () => {
    if (!open) return;
    if (open.assistant === null && open.calls.length === 0) return;
    open.steps.push({
      assistant: open.assistant ?? "",
      toolCalls: open.calls,
      results: open.results,
      ...(open.feedback.length ? { feedback: open.feedback } : {}),
    });
    open.assistant = null;
    open.calls = [];
    open.results = [];
    open.feedback = [];
  };
  const execution = (o: Open): ExecutionMemory => ({ steps: o.steps, steering: o.steering });
  const close = (turn: HistoryTurn, seq: number) => {
    turns.push(turn);
    closeSeqs.push(seq);
    open = undefined;
  };
  const interrupt = (o: Open, seq: number, reason: "cancelled" | "failed", partial: string | null, origin?: string) => {
    const assistant = partial ?? o.assistant ?? undefined;
    const answered = new Set(o.results.map((r) => r.toolCallId));
    const activeToolCall = o.calls.find((c) => !answered.has(c.id));
    o.calls = o.calls.filter((c) => c !== activeToolCall);
    flushStep();
    const completedToolNames = o.steps.flatMap((s) => s.results.map((r) => r.name));
    close(
      {
        kind: "interrupted",
        user: o.user,
        ...(assistant ? { assistant } : {}),
        ...(activeToolCall ? { activeToolCall } : {}),
        completedToolNames,
        execution: execution(o),
        reason,
        origin: origin === "compaction" ? "compaction" : "turn",
      },
      seq,
    );
  };

  for (const { seq, event } of frames) {
    switch (event.type) {
      case "user":
        if (open) interrupt(open, seq, "failed", null); // a new prompt without a close: the previous turn died
        open = {
          user: { text: event.text, ...(event.images.length ? { images: event.images } : {}) },
          steps: [],
          steering: [],
          assistant: null,
          calls: [],
          results: [],
          feedback: [],
        };
        break;
      case "assistant":
        if (!open) break;
        flushStep();
        open.assistant = event.text;
        break;
      case "tool_call":
        open?.calls.push({ id: event.call_id, name: event.tool_name, arguments: event.arguments_json });
        break;
      case "tool_result":
        if (!open) break;
        open.results.push({
          role: "tool",
          toolCallId: event.call_id,
          name: event.tool_name,
          content: event.inline_output ?? event.preview ?? "",
          status: event.status,
          memory: {
            ...(event.artifact_ref ? { outputHandle: event.artifact_ref } : {}),
            ...(event.preview !== undefined ? { preview: event.preview } : {}),
            outputBytes: event.output_bytes,
            storedBytes: event.stored_bytes,
            truncated: event.completeness !== "complete" || event.stored_bytes < event.output_bytes,
            ...(event.command_output_handle ? { commandOutputHandle: event.command_output_handle } : {}),
          },
        });
        for (const text of event.feedback ?? [])
          open.feedback.push({ role: "user", content: text, permissionFeedback: true, toolCallId: event.call_id });
        break;
      case "steering":
        if (!open) break;
        flushStep();
        open.steering.push({ text: event.text, afterStep: open.steps.length });
        break;
      case "turn_completed": {
        if (!open) break;
        const o = open;
        const final = o.calls.length === 0 ? (o.assistant ?? "") : "";
        if (o.calls.length > 0) flushStep();
        else o.assistant = null;
        close({ kind: "assistant", user: o.user, assistant: final, execution: execution(o) }, seq);
        break;
      }
      case "interrupted":
        if (open) interrupt(open, seq, event.reason, event.partial_text, event.origin);
        break;
      case "context_checkpoint": {
        let removed = 0;
        while (removed < turns.length && closeSeqs[removed]! <= event.covers_through_seq) removed++;
        turns.splice(0, removed);
        closeSeqs.splice(0, removed);
        turns.unshift({ kind: "compacted_summary", handoff: event.summary, removedTurns: removed });
        closeSeqs.unshift(seq);
        break;
      }
    }
  }
  return { turns, closeSeqs, lastSeq: frames.length ? frames[frames.length - 1]!.seq : 0 };
}

// ---- display metadata -------------------------------------------------------------------------

export const FALLBACK_TITLE = "Untitled session";
export const IMAGE_TITLE = "Image session";
const MAX_TITLE_WORDS = 8;
export const MAX_TITLE_BYTES = 240;
const MAX_PREVIEW_LINES = 2;
const MAX_PREVIEW_BYTES = 240;

export type Display = { title: string; preview: string | null };

/** Title = first line of the first real prompt (≤8 words/240 bytes); preview = its first 2 lines (≤240 bytes). */
export function deriveDisplay(history: HistoryTurn[]): Display {
  for (const turn of history) {
    if (turn.kind === "compacted_summary") continue;
    const { text, images = [] } = turn.user;
    const trimmed = text.trim();
    if (isCanonicalImageOnly(text, images)) return { title: IMAGE_TITLE, preview: null };
    if (trimmed.length > 0 && !isSlashCommandOnly(trimmed)) {
      const firstLine = text
        .split("\n")
        .map((l) => l.trim())
        .find((l) => l.length > 0);
      if (!firstLine) return { title: FALLBACK_TITLE, preview: null };
      return { title: cappedTitle(firstLine), preview: boundedPreview(text) };
    }
    if (images.length > 0) return { title: IMAGE_TITLE, preview: null };
  }
  return { title: FALLBACK_TITLE, preview: null };
}

const isSlashCommandOnly = (trimmed: string) => trimmed.startsWith("/") && !trimmed.includes("\n");

function isCanonicalImageOnly(text: string, images: ImageRef[]): boolean {
  if (images.length === 0) return false;
  return text === images.map((i) => `[Image #${i.id}]`).join("\n");
}

function cappedTitle(line: string): string {
  const out: string[] = [];
  let bytes = 0;
  for (const word of line.split(/\s+/).filter(Boolean).slice(0, MAX_TITLE_WORDS)) {
    const sep = out.length ? 1 : 0;
    const take = capUtf8(word, MAX_TITLE_BYTES - Math.min(MAX_TITLE_BYTES, bytes + sep));
    if (take.length === 0) break;
    out.push(take);
    bytes += sep + Buffer.byteLength(take);
  }
  return out.length ? out.join(" ") : FALLBACK_TITLE;
}

function boundedPreview(text: string): string | null {
  let out = "";
  let lines = 0;
  for (const raw of text.split("\n")) {
    if (lines === MAX_PREVIEW_LINES) break;
    const line = raw.trim();
    if (!line) continue;
    if (out) out += "\n";
    const remaining = MAX_PREVIEW_BYTES - Math.min(MAX_PREVIEW_BYTES, Buffer.byteLength(out));
    if (remaining === 0) break;
    const take = capUtf8(line, remaining);
    out += take;
    lines++;
    if (take.length < line.length || Buffer.byteLength(out) >= MAX_PREVIEW_BYTES) break;
  }
  return out || null;
}

/** Longest prefix of `text` that fits in `maxBytes` of UTF-8 without splitting a code point. */
export function capUtf8(text: string, maxBytes: number): string {
  if (Buffer.byteLength(text) <= maxBytes) return text;
  let bytes = 0;
  let end = 0;
  for (const ch of text) {
    const len = Buffer.byteLength(ch);
    if (bytes + len > maxBytes) break;
    bytes += len;
    end += ch.length;
  }
  return text.slice(0, end);
}
