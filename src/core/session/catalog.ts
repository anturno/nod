/** Listing, "last", pagination cursors, and the exact text/JSON of `nod sessions` / `nod session <id>`. */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { ExecutionMemory, HistoryTurn, UserTurn } from "../agent/types.ts";
import { FALLBACK_TITLE } from "./events.ts";
import { SessionError, validateSessionId } from "./id.ts";
import { type SessionDeps, sessionsDir, workspaceRoot } from "./layout.ts";
import { type Manifest, readManifest } from "./manifest.ts";
import type { MigrationResult, RecoveryResult, SessionDetail } from "./store.ts";

export type SessionSummary = Pick<
  Manifest,
  | "id"
  | "title"
  | "preview"
  | "workspace_root"
  | "origin_workspace_root"
  | "created_at_ms"
  | "updated_at_ms"
  | "history_len"
  | "conversation_language"
  | "has_checkpoint"
>;

export type ListScope = "workspace" | "all";
export type ListOptions = { scope?: ListScope; limit?: number; cursor?: string };
export type SessionPage = {
  sessions: SessionSummary[];
  has_more: boolean;
  next_cursor?: string;
  skipped_invalid: number;
  all_workspaces: boolean;
};

export const SESSION_LIST_MAX_LIMIT = 100;
export type Cursor = { updated_at_ms: number; id: string };

export const formatCursor = (s: Pick<SessionSummary, "updated_at_ms" | "id">) => `v1:${s.updated_at_ms}:${s.id}`;

/** Only the canonical spelling is accepted, so a cursor round-trips byte-for-byte. */
export function parseCursor(raw: string): Cursor {
  const bad = () => new SessionError("invalid_cursor", `invalid session cursor ${JSON.stringify(raw)}`);
  if (raw.length === 0 || raw.length > 320) throw bad();
  const parts = raw.split(":");
  if (parts.length !== 3 || parts[0] !== "v1") throw bad();
  const updated_at_ms = Number(parts[1]);
  if (!/^-?\d+$/.test(parts[1]!) || !Number.isSafeInteger(updated_at_ms)) throw bad();
  try {
    validateSessionId(parts[2]!);
  } catch {
    throw bad();
  }
  const cursor = { updated_at_ms, id: parts[2]! };
  if (formatCursor(cursor) !== raw) throw bad();
  return cursor;
}

/** Every readable session.json under sessions/, newest first; unreadable ones are counted. */
export function scanSessions(deps: Pick<SessionDeps, "home">): {
  summaries: SessionSummary[];
  skipped_invalid: number;
} {
  let entries: string[];
  try {
    entries = readdirSync(sessionsDir(deps));
  } catch {
    return { summaries: [], skipped_invalid: 0 };
  }
  const summaries: SessionSummary[] = [];
  let skipped_invalid = 0;
  for (const id of entries) {
    try {
      validateSessionId(id);
      summaries.push(readManifest(join(sessionsDir(deps), id), id));
    } catch {
      skipped_invalid++;
    }
  }
  summaries.sort((a, b) =>
    a.updated_at_ms !== b.updated_at_ms ? b.updated_at_ms - a.updated_at_ms : a.id < b.id ? 1 : -1,
  );
  return { summaries, skipped_invalid };
}

export function listSessions(deps: SessionDeps, opts: ListOptions = {}): SessionPage {
  const limit = opts.limit ?? SESSION_LIST_MAX_LIMIT;
  if (!Number.isInteger(limit) || limit < 1 || limit > SESSION_LIST_MAX_LIMIT)
    throw new SessionError("invalid_limit", `--limit must be between 1 and ${SESSION_LIST_MAX_LIMIT}`);
  const cursor = opts.cursor === undefined ? undefined : parseCursor(opts.cursor);
  const scope = opts.scope ?? "workspace";
  const root = workspaceRoot(deps.cwd);
  const scan = scanSessions(deps);
  const page: SessionPage = {
    sessions: [],
    has_more: false,
    skipped_invalid: scan.skipped_invalid,
    all_workspaces: scope === "all",
  };
  for (const s of scan.summaries) {
    if (scope === "workspace" && s.workspace_root !== root) continue;
    if (
      cursor &&
      !(s.updated_at_ms < cursor.updated_at_ms || (s.updated_at_ms === cursor.updated_at_ms && s.id < cursor.id))
    )
      continue;
    if (page.sessions.length === limit) {
      page.has_more = true;
      page.next_cursor = formatCursor(page.sessions[page.sessions.length - 1]!);
      break;
    }
    page.sessions.push(s);
  }
  return page;
}

/** Newest session with something to resume (a turn or a checkpoint). */
export function findLastSession(deps: SessionDeps, scope: ListScope = "workspace"): SessionSummary | undefined {
  const root = workspaceRoot(deps.cwd);
  return scanSessions(deps).summaries.find(
    (s) => (scope === "all" || s.workspace_root === root) && (s.history_len > 0 || s.has_checkpoint),
  );
}

// ---- rendering (fx output_contracts.zig, verbatim) ---------------------------------------------

export type OutputFormat = "text" | "json";

export function renderSessions(page: SessionPage, fmt: OutputFormat): string {
  if (fmt === "json") {
    if (page.sessions.length === 0 && page.skipped_invalid === 0) return '{"kind":"sessions","count":0,"sessions":[]}';
    let out = `{"kind":"sessions","count":${page.sessions.length}`;
    if (page.skipped_invalid > 0) out += `,"skipped_invalid":${page.skipped_invalid}`;
    if (page.has_more) out += `,"has_more":true,"next_cursor":${JSON.stringify(page.next_cursor ?? "")}`;
    out += `,"sessions":[${page.sessions.map(summaryJson).join(",")}]}`;
    return out;
  }
  if (page.sessions.length === 0 && page.skipped_invalid === 0) return "[sessions] no saved sessions\n";
  let out = "";
  if (page.sessions.length === 0) out += "[sessions] no readable saved sessions\n";
  else {
    out += `[sessions] ${page.sessions.length} saved\n`;
    for (const s of page.sessions) {
      out += ` - ${terminalSafe(s.title ?? FALLBACK_TITLE)}\n`;
      out += `   id=${s.id} | ${s.history_len} turn${s.history_len === 1 ? "" : "s"}`;
      const label = languageLabel(s.conversation_language);
      if (label !== undefined) out += ` | ${terminalSafe(label)}`;
      out += ` | updated ${utcTimestamp(s.updated_at_ms)}\n`;
    }
  }
  if (page.has_more)
    out += `[sessions] more saved sessions; continue with \`nod sessions ${page.all_workspaces ? "--all " : ""}--cursor ${page.next_cursor ?? ""}\`\n`;
  if (page.skipped_invalid > 0)
    out += `[sessions] warning: skipped ${page.skipped_invalid} unreadable saved session${page.skipped_invalid === 1 ? "" : "s"}; run \`nod doctor\` for recovery guidance\n`;
  return out;
}

const summaryJson = (s: SessionSummary) =>
  `{"id":${JSON.stringify(s.id)},"title":${JSON.stringify(s.title ?? FALLBACK_TITLE)},"preview":${JSON.stringify(s.preview)},"workspace_root":${JSON.stringify(s.workspace_root)},"origin_workspace_root":${JSON.stringify(s.origin_workspace_root)},"created_at_ms":${s.created_at_ms},"updated_at_ms":${s.updated_at_ms},"history_len":${s.history_len},"conversation_language":${JSON.stringify(s.conversation_language)}}`;

export function renderSessionDetail(d: SessionDetail, fmt: OutputFormat): string {
  if (fmt === "json")
    return `{"kind":"session_detail","id":${JSON.stringify(d.id)},"created_at_ms":${d.created_at_ms},"updated_at_ms":${d.updated_at_ms},"history_len":${d.history.length},"conversation_language":${JSON.stringify(d.conversation_language)},"history":[${d.history.map(turnJson).join(",")}]}`;
  let out = `[session] ${d.id}\ncreated_at_ms: ${d.created_at_ms}\nupdated_at_ms: ${d.updated_at_ms}\nlanguage: ${d.conversation_language}\nhistory_len: ${d.history.length}\n`;
  if (d.history.length === 0) return `${out}\n(no history yet)\n`;
  d.history.forEach((turn, i) => {
    out += `\n[turn ${i + 1}]\n${turnText(turn)}`;
  });
  return out;
}

export function renderMigration(r: MigrationResult, fmt: OutputFormat): string {
  if (fmt === "json")
    return `{"kind":"session_migration","id":${JSON.stringify(r.id)},"status":${JSON.stringify(r.status)},"source_schema_version":${r.source_schema_version},"source_bytes":${r.source_bytes}}`;
  return `[session migration] ${r.id}\nstatus: ${r.status}\nsource_schema_version: ${r.source_schema_version}\nsource_bytes: ${r.source_bytes}\n`;
}

export function renderRecovery(r: RecoveryResult, fmt: OutputFormat): string {
  if (fmt === "json")
    return `{"kind":"session_recovery","source_id":${JSON.stringify(r.source_id)},"recovered_id":${JSON.stringify(r.recovered_id)},"status":${JSON.stringify(r.status)},"history_turns":${r.history_turns}}`;
  return `[session recovery] copied ${r.source_id} to ${r.recovered_id}\nhistory_turns: ${r.history_turns}\nresume: nod --resume ${r.recovered_id}\n`;
}

// ---- history turn text / json ---------------------------------------------------------------

const block = (text: string) => (text.length === 0 ? "(empty)\n" : text.endsWith("\n") ? text : `${text}\n`);
const isEmptyExecution = (e: ExecutionMemory) => e.steps.length === 0 && e.steering.length === 0;

function userText(user: UserTurn): string {
  let out = `[user]\n${block(user.text)}`;
  if (user.images?.length) {
    out += `[images] ${user.images.length}\n`;
    for (const image of user.images) out += ` - ${image.path ?? ""} (${image.mime})\n`;
  }
  return out;
}

function executionText(e: ExecutionMemory): string {
  if (isEmptyExecution(e)) return "";
  let out = "[execution]\n";
  for (const step of e.steps) {
    if (step.assistant) out += `assistant:\n${block(step.assistant)}`;
    for (const call of step.toolCalls)
      out += `tool_call: ${call.id} ${call.name}\narguments:\n${block(call.arguments)}`;
    for (const r of step.results)
      out += `tool_result: ${r.toolCallId} ${r.name} ${r.status ?? "success"}\noutput:\n${block(r.content)}`;
  }
  return out;
}

function turnText(turn: HistoryTurn): string {
  switch (turn.kind) {
    case "compacted_summary":
      return `[compacted] removed_turns=${turn.removedTurns} compactions=1\n${block(turn.handoff)}`;
    case "assistant":
      return `${userText(turn.user)}${executionText(turn.execution)}[assistant]\n${block(turn.assistant)}`;
    case "interrupted": {
      let out = userText(turn.user) + executionText(turn.execution);
      if (turn.assistant !== undefined) out += `[assistant]\n${block(turn.assistant)}`;
      out += "[interrupted]\n";
      out += turn.activeToolCall
        ? `tool_call_id: ${turn.activeToolCall.id}\ntool_name: ${turn.activeToolCall.name}\n`
        : "tool: (none)\n";
      if (turn.completedToolNames.length > 0) out += `completed_tools: ${turn.completedToolNames.join(", ")}\n`;
      return out;
    }
  }
}

const userJson = (user: UserTurn) =>
  `{"text":${JSON.stringify(user.text)},"images":[${(user.images ?? [])
    .map((i) => `{"path":${JSON.stringify(i.path ?? "")},"media_type":${JSON.stringify(i.mime)}}`)
    .join(",")}]}`;

export function executionJson(e: ExecutionMemory): string {
  const steps = e.steps.map(
    (step) =>
      `{"assistant":${JSON.stringify(step.assistant || null)},"tool_calls":[${step.toolCalls
        .map(
          (c) =>
            `{"id":${JSON.stringify(c.id)},"name":${JSON.stringify(c.name)},"arguments_json":${JSON.stringify(c.arguments)},"provider_result":null}`,
        )
        .join(",")}],"tool_results":[${step.results
        .map((r) => {
          let out = `{"tool_call_id":${JSON.stringify(r.toolCallId)},"tool_name":${JSON.stringify(r.name)},"status":${JSON.stringify(r.status ?? "success")},"output":${JSON.stringify(r.content)}`;
          if (r.memory?.outputHandle) out += `,"output_handle":${JSON.stringify(r.memory.outputHandle)}`;
          if (r.memory?.preview !== undefined) out += `,"preview":${JSON.stringify(r.memory.preview)}`;
          const bytes = r.memory?.outputBytes ?? Buffer.byteLength(r.content);
          const stored = r.memory?.storedBytes ?? bytes;
          out += `,"output_bytes":${bytes},"stored_output_bytes":${stored},"truncated":${r.memory?.truncated ?? false},"provider_native":false,"created_at_ms":0`;
          const feedback = (step.feedback ?? []).filter((f) => f.toolCallId === r.toolCallId).map((f) => f.content);
          return `${out},"permission_feedback":[${feedback.map((f) => JSON.stringify(f)).join(",")}]}`;
        })
        .join(",")}]}`,
  );
  const steering = e.steering.map(
    (s) => `{"text":${JSON.stringify(s.text)},"assistant_prefix":null,"after_tool_step_count":${s.afterStep}}`,
  );
  return `{"schema_version":3,"tool_steps":[${steps.join(",")}],"files":[],"steering":[${steering.join(",")}]}`;
}

function turnJson(turn: HistoryTurn): string {
  switch (turn.kind) {
    case "compacted_summary":
      return `{"kind":"compacted_summary","summary":${JSON.stringify(turn.handoff)},"removed_turn_count":${turn.removedTurns},"compaction_count":1}`;
    case "assistant":
      return `{"kind":"assistant","user":${userJson(turn.user)},"assistant":${JSON.stringify(turn.assistant)},"execution":${executionJson(turn.execution)}}`;
    case "interrupted": {
      const call = turn.activeToolCall
        ? `{"id":${JSON.stringify(turn.activeToolCall.id)},"name":${JSON.stringify(turn.activeToolCall.name)},"arguments_json":${JSON.stringify(turn.activeToolCall.arguments)}}`
        : "null";
      let out = `{"kind":"interrupted","user":${userJson(turn.user)},"assistant":${JSON.stringify(turn.assistant ?? null)},"tool_call":${call},"completed_tool_names":[${turn.completedToolNames.map((n) => JSON.stringify(n)).join(",")}]`;
      if (!isEmptyExecution(turn.execution)) out += `,"execution":${executionJson(turn.execution)}`;
      return `${out}}`;
    }
  }
}

// ---- helpers ---------------------------------------------------------------------------------

/** Escapes control characters and invisible code points the way fx's terminal-safe encoder does. */
export function terminalSafe(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const cp = ch.codePointAt(0)!;
    if (cp < 0x20 || cp === 0x7f) out += `\\x${cp.toString(16).padStart(2, "0")}`;
    else if (
      (cp >= 0x80 && cp <= 0x9f) ||
      (cp >= 0x200b && cp <= 0x200f) ||
      (cp >= 0x2028 && cp <= 0x202e) ||
      (cp >= 0x2060 && cp <= 0x206f) ||
      cp === 0xfeff
    )
      out += `\\u{${cp.toString(16)}}`;
    else out += ch;
  }
  return out;
}

export function utcTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0 || ms > 253_402_300_799_999) return "unknown";
  return `${new Date(ms).toISOString().replace("T", " ").replace("Z", "")} UTC`;
}

const LANGUAGES: Record<string, string> = {
  en: "English",
  es: "Spanish",
  fr: "French",
  de: "German",
  it: "Italian",
  pt: "Portuguese",
  ja: "Japanese",
  ko: "Korean",
  zh: "Chinese",
  ar: "Arabic",
  he: "Hebrew",
  ru: "Russian",
  el: "Greek",
  hi: "Hindi",
  th: "Thai",
};
const SCRIPTS: Record<string, string> = {
  latn: "Latin script",
  hani: "Han script",
  arab: "Arabic script",
  hebr: "Hebrew script",
  cyrl: "Cyrillic script",
  grek: "Greek script",
  deva: "Devanagari script",
  thai: "Thai script",
};

/** undefined for "und" (no label); otherwise a name for the primary subtag or the raw tag. */
export function languageLabel(tag: string): string | undefined {
  const lower = tag.toLowerCase();
  if (lower === "und") return undefined;
  if (lower.startsWith("und-") && lower.length > 4) return SCRIPTS[lower.slice(4)] ?? tag;
  return LANGUAGES[lower.split("-")[0]!] ?? tag;
}
