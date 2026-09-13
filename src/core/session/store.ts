/** Session lifecycle: create/open (with the pid lock), save turns, rename, delete, detail, migrate, recover. */
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Effort, HistoryTurn, Provider, Usage } from "../agent/types.ts";
import {
  appendEvent,
  deriveDisplay,
  type EventFrame,
  eventsBytes,
  project,
  readEvents,
  readReadablePrefix,
  type SessionEvent,
  truncateToReadable,
} from "./events.ts";
import { generateSessionId, SessionError, validateSessionId } from "./id.ts";
import { ensurePrivateDir, LOCK_FILE, RESULTS_DIR, type SessionDeps, sessionDir, workspaceRoot } from "./layout.ts";
import { emptyUsage, type Manifest, readManifest, writeManifest } from "./manifest.ts";
import { storeToolResult } from "./results.ts";

export type Session = {
  deps: SessionDeps;
  id: string;
  dir: string;
  manifest: Manifest;
  /** Committed turns, replayed from the log at open and kept current by saveTurn. */
  history: HistoryTurn[];
  /** Releases the lock. Safe to call twice. */
  close(): void;
};

export type SessionInit = {
  provider?: Provider | null;
  model?: string | null;
  effort?: Effort | null;
  fast_mode?: boolean;
  conversation_language?: string;
  id?: string;
};

export function createSession(deps: SessionDeps, init: SessionInit = {}): Session {
  const id = init.id ?? generateSessionId();
  const dir = sessionDir(deps, id);
  if (existsSync(dir)) throw new SessionError("exists", `session ${id} already exists`);
  ensurePrivateDir(dir);
  const now = deps.now();
  const root = workspaceRoot(deps.cwd);
  const manifest: Manifest = {
    schema_version: 1,
    id,
    created_at_ms: now,
    updated_at_ms: now,
    origin_workspace_root: root,
    workspace_root: root,
    conversation_language: init.conversation_language ?? "und",
    provider: init.provider ?? null,
    model: init.model ?? null,
    effort: init.effort ?? null,
    fast_mode: init.fast_mode ?? false,
    title: null,
    title_generated: false,
    preview: null,
    history_len: 0,
    context_history_start: 0,
    usage: emptyUsage(),
    permission_grants: [],
    has_checkpoint: false,
  };
  writeManifest(dir, manifest);
  writeFileSync(join(dir, "events.jsonl"), "", { mode: 0o600 });
  acquireLock(dir);
  return handle(deps, dir, manifest, { turns: [], closeSeqs: [], lastSeq: 0 });
}

/** Opens for writing. `rebindWorkspace` moves the session to the current cwd instead of failing on a mismatch. */
export function openSession(deps: SessionDeps, id: string, opts: { rebindWorkspace?: boolean } = {}): Session {
  const dir = sessionDir(deps, id);
  if (!existsSync(dir)) throw new SessionError("not_found", `no saved session ${id}`);
  const manifest = readManifest(dir, id);
  const root = workspaceRoot(deps.cwd);
  const rebind = manifest.workspace_root !== root;
  if (rebind && !opts.rebindWorkspace)
    throw new SessionError(
      "workspace_mismatch",
      `session ${id} belongs to ${manifest.workspace_root}; resume from that directory or rebind it`,
    );
  acquireLock(dir);
  try {
    const read = readEvents(dir);
    truncateToReadable(dir, read);
    const projection = project(read.frames);
    if (rebind) {
      manifest.workspace_root = root;
      writeManifest(dir, manifest);
    }
    return handle(deps, dir, manifest, projection);
  } catch (err) {
    releaseLock(dir);
    throw err;
  }
}

function handle(deps: SessionDeps, dir: string, manifest: Manifest, p: ReturnType<typeof project>): Session {
  let closed = false;
  const session: Session = {
    deps,
    id: manifest.id,
    dir,
    manifest,
    history: p.turns,
    close() {
      if (closed) return;
      closed = true;
      releaseLock(dir);
    },
  };
  seqs.set(session, { lastSeq: p.lastSeq, closeSeqs: p.closeSeqs });
  return session;
}

const seqs = new WeakMap<Session, { lastSeq: number; closeSeqs: number[] }>();
const seqState = (s: Session) => seqs.get(s) ?? { lastSeq: 0, closeSeqs: [] };

// ---- lock ------------------------------------------------------------------------------------

// ponytail: pid lock file, not flock(); good enough for one user on one machine. Upgrade to fx's
// authority files if concurrent writers ever appear.
function acquireLock(dir: string) {
  const path = join(dir, LOCK_FILE);
  const owner = lockOwner(path);
  if (owner !== undefined && owner !== process.pid && pidAlive(owner))
    throw new SessionError("open_elsewhere", `session is open in another nod process (pid ${owner})`);
  rmSync(path, { force: true });
  try {
    writeFileSync(path, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
  } catch {
    throw new SessionError("open_elsewhere", "session is open in another nod process");
  }
}

function releaseLock(dir: string) {
  const path = join(dir, LOCK_FILE);
  if (lockOwner(path) === process.pid) rmSync(path, { force: true });
}

function lockOwner(path: string): number | undefined {
  try {
    const pid = Number.parseInt(readFileSync(path, "utf8").trim(), 10);
    return Number.isInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
}

export function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** Whether another live process holds this session's lock (read-only callers use this without opening). */
export function lockedElsewhere(deps: Pick<SessionDeps, "home">, id: string): boolean {
  const owner = lockOwner(join(sessionDir(deps, id), LOCK_FILE));
  return owner !== undefined && owner !== process.pid && pidAlive(owner);
}

// ---- writes ----------------------------------------------------------------------------------

export function updateManifest(session: Session, patch: Partial<Manifest>) {
  Object.assign(session.manifest, patch, { updated_at_ms: session.deps.now() });
  writeManifest(session.dir, session.manifest);
}

/** Appends a raw event; prefer saveTurn for whole turns. */
export function append(session: Session, event: SessionEvent): EventFrame {
  const state = seqState(session);
  state.lastSeq += 1;
  seqs.set(session, state);
  return appendEvent(session.dir, state.lastSeq, session.deps.now(), event);
}

/** Convenience for the agent loop: writes the events of one finished turn and refreshes the manifest. */
export function saveTurn(session: Session, turn: HistoryTurn, usage?: Usage & { requestCount?: number }) {
  const state = seqState(session);
  if (turn.kind === "compacted_summary") {
    const removed = Math.min(turn.removedTurns, session.history.length);
    const covers = removed > 0 ? state.closeSeqs[removed - 1]! : 0;
    const frame = append(session, { type: "context_checkpoint", covers_through_seq: covers, summary: turn.handoff });
    session.history.splice(0, removed);
    state.closeSeqs.splice(0, removed);
    session.history.unshift({ kind: "compacted_summary", handoff: turn.handoff, removedTurns: removed });
    state.closeSeqs.unshift(frame.seq);
    session.manifest.has_checkpoint = true;
    session.manifest.context_history_start = 0;
  } else {
    append(session, { type: "user", text: turn.user.text, images: turn.user.images ?? [] });
    for (const [i, step] of turn.execution.steps.entries()) {
      for (const s of turn.execution.steering.filter((s) => s.afterStep === i))
        append(session, { type: "steering", text: s.text });
      if (step.assistant || step.toolCalls.length) append(session, { type: "assistant", text: step.assistant });
      for (const call of step.toolCalls)
        append(session, { type: "tool_call", call_id: call.id, tool_name: call.name, arguments_json: call.arguments });
      for (const result of step.results) {
        const stored = result.memory?.outputHandle
          ? {
              artifact_ref: result.memory.outputHandle,
              output_bytes: result.memory.outputBytes,
              stored_bytes: result.memory.storedBytes,
            }
          : storeToolResult(session.dir, result.toolCallId, result.content);
        const feedback = step.feedback?.filter((f) => f.toolCallId === result.toolCallId).map((f) => f.content) ?? [];
        append(session, {
          type: "tool_result",
          call_id: result.toolCallId,
          tool_name: result.name,
          status: result.status ?? "success",
          ...stored,
          completeness: result.memory?.truncated ? "partial" : "complete",
          ...(result.memory?.preview !== undefined ? { preview: result.memory.preview } : {}),
          ...(feedback.length ? { feedback } : {}),
          ...(result.memory?.commandOutputHandle ? { command_output_handle: result.memory.commandOutputHandle } : {}),
        });
      }
    }
    for (const s of turn.execution.steering.filter((s) => s.afterStep >= turn.execution.steps.length))
      append(session, { type: "steering", text: s.text });
    let frame: EventFrame;
    if (turn.kind === "assistant") {
      append(session, { type: "assistant", text: turn.assistant });
      frame = append(session, { type: "turn_completed" });
    } else {
      if (turn.activeToolCall)
        append(session, {
          type: "tool_call",
          call_id: turn.activeToolCall.id,
          tool_name: turn.activeToolCall.name,
          arguments_json: turn.activeToolCall.arguments,
        });
      frame = append(session, {
        type: "interrupted",
        reason: turn.reason,
        partial_text: turn.assistant ?? null,
        origin: turn.origin,
      });
    }
    session.history.push(turn);
    state.closeSeqs.push(frame.seq);
  }
  const m = session.manifest;
  m.history_len = session.history.length;
  if (usage) {
    m.usage.input_tokens += usage.inputTokens ?? 0;
    m.usage.output_tokens += usage.outputTokens ?? 0;
    m.usage.cache_read_tokens += usage.cacheReadTokens ?? 0;
    m.usage.reasoning_tokens += usage.reasoningTokens ?? 0;
    m.usage.request_count += usage.requestCount ?? 1;
  }
  if (m.title === null || m.preview === null) {
    const display = deriveDisplay(session.history);
    if (m.title === null && display.title !== "Untitled session") m.title = display.title;
    if (m.preview === null) m.preview = display.preview;
  }
  updateManifest(session, {});
}

/** `/rename`: a user title wins over generated ones from now on. */
export function renameSession(session: Session, title: string) {
  const clean = title.trim();
  if (!clean) throw new SessionError("invalid_title", "title must not be empty");
  updateManifest(session, { title: clean.slice(0, 240), title_generated: false });
}

export function deleteSession(deps: SessionDeps, id: string) {
  const dir = sessionDir(deps, id);
  if (!existsSync(dir)) throw new SessionError("not_found", `no saved session ${id}`);
  if (lockedElsewhere(deps, id))
    throw new SessionError("open_elsewhere", `session ${id} is open in another nod process`);
  rmSync(dir, { recursive: true, force: true });
}

// ---- read-only surfaces ----------------------------------------------------------------------

export type SessionDetail = Manifest & { history: HistoryTurn[] };

export function readSessionDetail(deps: Pick<SessionDeps, "home">, id: string): SessionDetail {
  const dir = sessionDir(deps, id);
  if (!existsSync(dir)) throw new SessionError("not_found", `no saved session ${id}`);
  const manifest = readManifest(dir, id);
  return { ...manifest, history: project(readEvents(dir).frames).turns };
}

export type MigrationResult = {
  id: string;
  status: "migrated" | "already_current";
  source_schema_version: number;
  source_bytes: number;
};

/** nod has a single on-disk format, so a readable session is always current. */
export function migrateSession(deps: Pick<SessionDeps, "home">, id: string): MigrationResult {
  const dir = sessionDir(deps, id);
  if (!existsSync(dir)) throw new SessionError("not_found", `no saved session ${id}`);
  const manifest = readManifest(dir, id);
  return {
    id,
    status: "already_current",
    source_schema_version: manifest.schema_version,
    source_bytes: eventsBytes(dir),
  };
}

export type RecoveryResult = {
  source_id: string;
  recovered_id: string;
  status: "recovered";
  history_turns: number;
};

/** Copies the readable prefix of a damaged session into a fresh id. The source is left untouched. */
export function recoverSession(deps: SessionDeps, id: string): RecoveryResult {
  const dir = sessionDir(deps, validateSessionId(id));
  if (!existsSync(dir)) throw new SessionError("not_found", `no saved session ${id}`);
  let manifest: Manifest | undefined;
  try {
    manifest = readManifest(dir, id);
  } catch {
    manifest = undefined;
  }
  const read = readReadablePrefix(dir);
  const projection = project(read.frames);
  const recovered = generateSessionId();
  const target = sessionDir(deps, recovered);
  ensurePrivateDir(target);
  const raw = readFileSync(join(dir, "events.jsonl"));
  writeFileSync(join(target, "events.jsonl"), raw.subarray(0, read.readable_bytes), { mode: 0o600 });
  if (existsSync(join(dir, RESULTS_DIR)))
    cpSync(join(dir, RESULTS_DIR), join(target, RESULTS_DIR), { recursive: true });
  const now = deps.now();
  const root = workspaceRoot(deps.cwd);
  const display = deriveDisplay(projection.turns);
  writeManifest(target, {
    schema_version: 1,
    id: recovered,
    created_at_ms: now,
    updated_at_ms: now,
    origin_workspace_root: manifest?.origin_workspace_root ?? root,
    workspace_root: manifest?.workspace_root ?? root,
    conversation_language: manifest?.conversation_language ?? "und",
    provider: manifest?.provider ?? null,
    model: manifest?.model ?? null,
    effort: manifest?.effort ?? null,
    fast_mode: manifest?.fast_mode ?? false,
    title: manifest?.title ?? (display.title === "Untitled session" ? null : display.title),
    title_generated: manifest?.title_generated ?? false,
    preview: display.preview,
    history_len: projection.turns.length,
    context_history_start: 0,
    usage: manifest?.usage ?? emptyUsage(),
    permission_grants: [],
    has_checkpoint: read.frames.some((f) => f.event.type === "context_checkpoint"),
  });
  mkdirSync(join(target, RESULTS_DIR), { recursive: true, mode: 0o700 });
  return { source_id: id, recovered_id: recovered, status: "recovered", history_turns: projection.turns.length };
}
