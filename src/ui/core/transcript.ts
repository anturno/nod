/** The transcript model: items built from agent events, tool call views, grouping, and plain-text renderings. */
import type { AgentEvent } from "../../core/agent/loop.ts";
import type { HistoryTurn, ToolCall, Usage } from "../../core/agent/types.ts";
import type { ToolResult } from "../../core/tools/spec.ts";
import { formatElapsed, formatTokens } from "./activity.ts";

export type ToolStatus = "running" | "done" | "failed" | "denied" | "cancelled";
export type ToolCategory = "read" | "list" | "write" | "edit" | "command" | "other";
export type ToolCallView = {
  toolId: string;
  name: string;
  /** Present-tense verb while running, past tense after: "Running" / "Ran". */
  action: string;
  target: string;
  status: ToolStatus;
  category: ToolCategory;
  /** Output lines shown under the call (already extracted from the tool result). */
  output?: string;
  exitCode?: number | null;
  rawOutput?: string;
};

export type NoticeTone = "success" | "error" | "info" | "warning" | "denied";
export type TranscriptItem =
  | { id: number; type: "user"; text: string; queued?: boolean; images?: number }
  | { id: number; type: "text"; text: string; streaming: boolean }
  | { id: number; type: "reasoning"; text: string; streaming: boolean }
  | { id: number; type: "tool"; call: ToolCallView }
  | { id: number; type: "notice"; tone: NoticeTone; topic?: string; text: string }
  | { id: number; type: "done"; turn: number; elapsedMs: number; usage: Usage; outcome: string };

export const NOTICE_GLYPH: Record<NoticeTone, string> = {
  success: "✓",
  error: "✗",
  info: "i",
  warning: "!",
  denied: "⊘",
};

export const CANCELLED_NOTICE = "Cancelled · What can nod do differently?";
/** Reasoning kept on screen while it streams. */
export const REASONING_TAIL = 400;
export const FOLDED_OUTPUT_LINES = 3;

let nextId = 1;
export const newId = () => nextId++;

// ---- tool views --------------------------------------------------------------------------------

const VERBS: Record<string, [string, string, ToolCategory]> = {
  shell: ["Running", "Ran", "command"],
  read_file: ["Reading", "Read", "read"],
  read_tool_result: ["Reading", "Read", "read"],
  vision: ["Reading", "Read", "read"],
  edit_file: ["Editing", "Edited", "edit"],
  write_file: ["Writing", "Wrote", "write"],
  glob_files: ["Searching", "Searched", "list"],
  grep_files: ["Searching", "Searched", "read"],
  web_search: ["Searching", "Searched", "read"],
  capability_search: ["Searching", "Searched", "read"],
  web_fetch: ["Fetching", "Fetched", "read"],
  skill: ["Loading", "Loaded", "read"],
  install_skill: ["Installing", "Installed", "write"],
  ask_user_question: ["Asking", "Asked", "other"],
  subagent: ["Delegating", "Delegated", "other"],
};

/** Strips the tool-name prefix the label carries: "shell.run bun test" → "bun test". */
function targetOf(name: string, label: string): string {
  const prefix = label.match(/^(\S+)\s*/);
  if (prefix && (prefix[1] === name || prefix[1]?.startsWith(`${name}.`))) return label.slice(prefix[0].length);
  return label;
}

export function toolView(call: ToolCall, label: string): ToolCallView {
  const [running, , category] = VERBS[call.name] ?? [
    "Running",
    "Ran",
    call.name.startsWith("mcp_") ? "other" : "other",
  ];
  const target = call.name.startsWith("mcp_") ? call.name : targetOf(call.name, label);
  return { toolId: call.id, name: call.name, action: running, target, status: "running", category };
}

const isDenied = (output: string) => /"tool_permission_denied"|"tool_review_held"/.test(output);

/** The lines to fold under a finished call: shell output text, or a short preview of anything else. */
export function extractOutput(name: string, output: string): { text: string; exitCode?: number | null } {
  if (name === "shell") {
    try {
      const parsed = JSON.parse(output) as { output_delta?: string; exit_code?: number | null; error?: string | null };
      const text = (parsed.output_delta ?? parsed.error ?? "").replace(/\s+$/, "");
      return { text, exitCode: parsed.exit_code };
    } catch {
      return { text: output };
    }
  }
  try {
    const parsed = JSON.parse(output) as { error?: { message?: string } };
    if (parsed?.error?.message) return { text: parsed.error.message };
  } catch {
    // plain text output
  }
  return { text: output.replace(/\s+$/, "") };
}

export function finishView(view: ToolCallView, result: ToolResult, label: string): ToolCallView {
  const [, done] = VERBS[view.name] ?? ["Running", "Ran"];
  const denied = result.status === "failure" && isDenied(result.output);
  const { text, exitCode } = extractOutput(view.name, result.output);
  const cancelled = result.status === "failure" && /cancel/i.test(text) && view.name === "ask_user_question";
  const status: ToolStatus = denied
    ? "denied"
    : cancelled
      ? "cancelled"
      : result.status === "failure"
        ? "failed"
        : "done";
  return {
    ...view,
    action: status === "done" ? done : status === "failed" ? "Failed" : status === "denied" ? "Denied" : "Cancelled",
    target: view.name.startsWith("mcp_") ? view.name : targetOf(view.name, label),
    status,
    output: text,
    exitCode,
    rawOutput: result.output,
  };
}

/** `● Ran bun test`, `■ Failed bun test · exit 1`, `⊘ Denied rm -rf /`. */
export function toolHeadline(v: ToolCallView): string {
  const glyph = v.status === "failed" || v.status === "cancelled" ? "■" : v.status === "denied" ? "⊘" : "●";
  const exit =
    v.status === "failed" && typeof v.exitCode === "number" && v.exitCode !== 0 ? ` · exit ${v.exitCode}` : "";
  return `${glyph} ${v.action} ${v.target}`.trimEnd() + exit;
}

export function foldedOutput(v: ToolCallView): { lines: string[]; hidden: number } {
  if (!v.output) return { lines: [], hidden: 0 };
  const all = v.output.split("\n");
  const lines = all.slice(0, FOLDED_OUTPUT_LINES);
  return { lines, hidden: all.length - lines.length };
}

// ---- events → items -----------------------------------------------------------------------------

type DistributiveOmit<T, K extends keyof T> = T extends unknown ? Omit<T, K> : never;
export type ItemInput = DistributiveOmit<TranscriptItem, "id">;

export function pushItem(items: TranscriptItem[], item: ItemInput): TranscriptItem[] {
  return [...items, { ...item, id: newId() } as TranscriptItem];
}

function finishStreaming(items: TranscriptItem[]): TranscriptItem[] {
  return items.map((i) =>
    (i.type === "text" || i.type === "reasoning") && i.streaming ? { ...i, streaming: false } : i,
  );
}

export function applyEvent(items: TranscriptItem[], event: AgentEvent): TranscriptItem[] {
  switch (event.type) {
    case "text":
    case "reasoning": {
      const last = items.at(-1);
      if (last && last.type === event.type && last.streaming)
        return [...items.slice(0, -1), { ...last, text: last.text + event.text }];
      return pushItem(finishStreaming(items), { type: event.type, text: event.text, streaming: true });
    }
    case "step":
      return finishStreaming(items);
    case "tool_started":
      return pushItem(finishStreaming(items), { type: "tool", call: toolView(event.call, event.label) });
    case "tool_finished": {
      const index = items.findIndex((i) => i.type === "tool" && i.call.toolId === event.call.id);
      if (index === -1)
        return pushItem(items, {
          type: "tool",
          call: finishView(toolView(event.call, event.label), event.result, event.label),
        });
      const item = items[index] as Extract<TranscriptItem, { type: "tool" }>;
      const next = [...items];
      next[index] = { ...item, call: finishView(item.call, event.result, event.label) };
      return next;
    }
    case "notice":
      return pushItem(items, { type: "notice", tone: event.tone, text: event.text });
    case "compaction":
      return pushItem(items, {
        type: "notice",
        tone: "info",
        topic: "compaction",
        text: `compacted ${event.removedTurns} turns`,
      });
    case "steering": {
      const index = items.findIndex((i) => i.type === "user" && i.queued);
      if (index === -1) return items;
      const next = [...items];
      next[index] = { ...(items[index] as Extract<TranscriptItem, { type: "user" }>), queued: false };
      return next;
    }
    case "provider_tool":
    case "permission":
    case "recovery":
      return items;
  }
}

/** Marks running tools cancelled and closes streams when a turn is aborted. */
export function cancelRunning(items: TranscriptItem[]): TranscriptItem[] {
  return finishStreaming(items).map((i) =>
    i.type === "tool" && i.call.status === "running"
      ? { ...i, call: { ...i.call, status: "cancelled", action: "Cancelled" } }
      : i,
  );
}

/** The saved history as transcript items, for a resumed session. */
export function itemsFromHistory(history: HistoryTurn[]): TranscriptItem[] {
  let items: TranscriptItem[] = [];
  let turn = 0;
  for (const t of history) {
    if (t.kind === "compacted_summary") {
      items = pushItem(items, {
        type: "notice",
        tone: "info",
        topic: "compaction",
        text: `compacted ${t.removedTurns} turns`,
      });
      continue;
    }
    turn++;
    items = pushItem(items, { type: "user", text: t.user.text, images: t.user.images?.length || undefined });
    for (const step of t.execution.steps) {
      if (step.assistant) items = pushItem(items, { type: "text", text: step.assistant, streaming: false });
      for (const call of step.toolCalls) {
        const result = step.results.find((r) => r.toolCallId === call.id);
        const view = toolView(call, `${call.name} ${describeArgs(call.arguments)}`);
        items = pushItem(items, {
          type: "tool",
          call: result
            ? finishView(
                view,
                { status: result.status ?? "success", output: result.content },
                `${call.name} ${describeArgs(call.arguments)}`,
              )
            : { ...view, status: "cancelled", action: "Cancelled" },
        });
      }
    }
    if (t.kind === "assistant") items = pushItem(items, { type: "text", text: t.assistant, streaming: false });
    else {
      if (t.assistant) items = pushItem(items, { type: "text", text: t.assistant, streaming: false });
      items = pushItem(items, {
        type: "notice",
        tone: "warning",
        text: t.reason === "cancelled" ? CANCELLED_NOTICE : "The turn failed",
      });
    }
    items = pushItem(items, { type: "done", turn, elapsedMs: 0, usage: {}, outcome: t.kind });
  }
  return items;
}

function describeArgs(json: string): string {
  try {
    const a = JSON.parse(json) as Record<string, unknown>;
    const v = a.command ?? a.path ?? a.pattern ?? a.url ?? a.name ?? a.query ?? "";
    return typeof v === "string" ? v : "";
  } catch {
    return "";
  }
}

// ---- grouping -----------------------------------------------------------------------------------

export type ToolGroup = { type: "group"; id: number; calls: ToolCallView[] };
export type DisplayItem = TranscriptItem | ToolGroup;

const CATEGORY_ORDER: ToolCategory[] = ["read", "list", "write", "edit", "command"];

/** `● 2 tool calls · 1 read · 1 edit`, categories by descending count, then failed/denied/cancelled. */
export function groupSummary(calls: ToolCallView[]): string {
  const counts = new Map<ToolCategory, number>();
  for (const c of calls) counts.set(c.category, (counts.get(c.category) ?? 0) + 1);
  let out = `● ${calls.length} tool call${calls.length === 1 ? "" : "s"}`;
  const ordered = CATEGORY_ORDER.filter((c) => counts.has(c)).sort(
    (a, b) => (counts.get(b) ?? 0) - (counts.get(a) ?? 0) || CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b),
  );
  for (const c of ordered) {
    const n = counts.get(c) ?? 0;
    out += ` · ${n} ${c === "command" && n !== 1 ? "commands" : c}`;
  }
  const failed = calls.filter((c) => c.status === "failed").length;
  const denied = calls.filter((c) => c.status === "denied").length;
  const cancelled = calls.filter((c) => c.status === "cancelled").length;
  if (failed) out += ` · ${failed} failed`;
  if (denied) out += ` · ${denied} denied`;
  if (cancelled) out += ` · ${cancelled} cancelled`;
  return out;
}

/** Consecutive finished tool calls (two or more) collapse into one group; ask_user_question never joins one. */
export function groupItems(items: TranscriptItem[], collapse: boolean): DisplayItem[] {
  if (!collapse) return items;
  const out: DisplayItem[] = [];
  let run: Extract<TranscriptItem, { type: "tool" }>[] = [];
  const flush = () => {
    if (run.length >= 2) out.push({ type: "group", id: run[0]?.id ?? 0, calls: run.map((r) => r.call) });
    else out.push(...run);
    run = [];
  };
  for (const item of items) {
    const groupable = item.type === "tool" && item.call.status !== "running" && item.call.name !== "ask_user_question";
    if (groupable) run.push(item as Extract<TranscriptItem, { type: "tool" }>);
    else {
      flush();
      out.push(item);
    }
  }
  flush();
  return out;
}

// ---- plain text ---------------------------------------------------------------------------------

export type Depth = "review" | "full";

/** Lines for the ctrl+o screen: review = text + tools with full output + notices; full = everything, raw. */
export function transcriptLines(items: TranscriptItem[], depth: Depth): string[] {
  const lines: string[] = [];
  for (const item of items) {
    switch (item.type) {
      case "user":
        lines.push(`> ${item.text}${item.queued ? "  (queued)" : ""}`, "");
        break;
      case "text":
        lines.push(...item.text.split("\n"), "");
        break;
      case "reasoning":
        if (depth === "full") lines.push(...item.text.split("\n").map((l) => `  ${l}`), "");
        break;
      case "tool":
        lines.push(toolHeadline(item.call));
        if (depth === "full" && item.call.rawOutput !== undefined) {
          lines.push(`exit_code=${item.call.exitCode ?? ""} <stdout>`);
          lines.push(...item.call.rawOutput.split("\n"));
          lines.push("</stdout>");
        } else if (item.call.output) lines.push(...item.call.output.split("\n").map((l) => `│ ${l}`));
        lines.push("");
        break;
      case "notice":
        lines.push(`${NOTICE_GLYPH[item.tone]} ${item.topic ? `${item.topic}: ` : ""}${item.text}`, "");
        break;
      case "done":
        if (depth === "full")
          lines.push(
            `✓ turn ${item.turn} · ${formatElapsed(item.elapsedMs)} · ↑${formatTokens(item.usage.inputTokens ?? 0)} ↓${formatTokens(item.usage.outputTokens ?? 0)}`,
            "",
          );
        break;
    }
  }
  return lines;
}

/** What startup_scrollback prints on the main screen at exit. */
export const plainTranscript = (items: TranscriptItem[]) => transcriptLines(items, "review").join("\n");
