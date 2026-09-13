/** The shell tool: run, interact (observe), and stop background command executions. */
import { statSync } from "node:fs";
import { boundOutput } from "../shell/output.ts";
import type { ShellManager, ShellSnapshot } from "../shell/types.ts";
import { type ResolvedPath, resolvePath } from "./paths.ts";
import type { DecodeResult, PermissionTarget, ToolContext, ToolResult, ToolSpec } from "./spec.ts";

export type ShellRequest =
  | {
      action: "run";
      command: string;
      cwd?: string;
      profile?: "clean" | "user";
      yield_time_ms: number;
      timeout_ms?: number;
    }
  | { action: "interact"; session_id: string; yield_time_ms: number }
  | { action: "stop"; session_id: string; force: boolean };

type Action = ShellRequest["action"];

const MAX_COMMAND_BYTES = 64 * 1024;
const MAX_WRITE_BYTES = 64 * 1024;
const DEFAULT_YIELD_MS = 30_000;
const MAX_YIELD_MS = 30_000;
const DEFAULT_WAIT_MS = 5_000;
const MAX_WAIT_MS = 300_000;
const INLINE_MAX_BYTES = 16 * 1024;
const OMISSION_MARKER = "\n... bytes omitted; use full_output_handle for exact output ...\n";

const description =
  "Run every command with shell.run. Fast commands complete in one call; commands still running after yield_time_ms return one owned session_id and remain available across turns. Use shell.interact with that exact session_id: omit chars to observe, or provide chars to send exact input and then observe. Use shell.stop only when termination is requested. output_delta is always terminal-safe; unsafe bytes are escaped while full_output_handle retains exact output, so do not run a separate command merely to test output safety or shell usability. Never detach with &, nohup, setsid, or double-forking.";

const parameters = {
  type: "object",
  properties: {
    request: {
      oneOf: [
        {
          type: "object",
          properties: {
            action: { type: "string", enum: ["run"] },
            command: {
              type: "string",
              maxLength: MAX_COMMAND_BYTES,
              description: "Shell command to execute exactly once.",
            },
            cwd: { type: "string", description: "Working directory; defaults to the workspace." },
            profile: {
              type: "string",
              enum: ["clean", "user"],
              description: "Defaults to user; clean skips user startup files. Mutually exclusive with shell.",
            },
            yield_time_ms: {
              type: "integer",
              minimum: 0,
              maximum: MAX_YIELD_MS,
              description:
                "Initial observation window. Defaults to 30000; use 0 to return the owned running handle immediately.",
            },
            timeout_ms: {
              type: "integer",
              minimum: 1,
              description:
                "Set only when the user explicitly requests a finite deadline. Omit for commands intended to remain running, receive input, continue across turns, or be stopped later.",
            },
          },
          additionalProperties: false,
          required: ["action", "command"],
        },
        {
          type: "object",
          properties: {
            action: { type: "string", enum: ["interact"] },
            session_id: { type: "string", description: "Owned execution handle returned by shell.run." },
            yield_time_ms: {
              type: "integer",
              minimum: 0,
              maximum: MAX_WAIT_MS,
              description:
                "Wait before yielding output. Empty observations wait 5000-300000 ms; shorter values are raised to 5000. Non-empty input is capped at 30000 ms and keeps shorter requested waits. Defaults to 5000. If the process remains running, interact with the same session_id again; never rerun it.",
            },
          },
          additionalProperties: false,
          required: ["action", "session_id"],
        },
        {
          type: "object",
          properties: {
            action: { type: "string", enum: ["stop"] },
            session_id: { type: "string", description: "Owned execution handle returned by shell.run." },
            force: { type: "boolean", description: "Use immediate force termination when true. Defaults to false." },
          },
          additionalProperties: false,
          required: ["action", "session_id"],
        },
      ],
    },
  },
  additionalProperties: false,
  required: ["request"],
};

// fx Input field order; also the canonical order of retry_with.
const FIELDS = [
  "action",
  "command",
  "cwd",
  "profile",
  "shell",
  "tty",
  "yield_time_ms",
  "timeout_ms",
  "session_id",
  "chars",
  "force",
] as const;
type Field = (typeof FIELDS)[number];
const TTY_FIELDS: Field[] = ["tty", "shell", "chars"];
const CONTRACT: Record<Action, { allowed: Field[]; required: Field[]; conflicts: [Field, Field][] }> = {
  run: {
    allowed: ["action", "command", "cwd", "profile", "shell", "tty", "yield_time_ms", "timeout_ms"],
    required: ["action", "command"],
    conflicts: [["profile", "shell"]],
  },
  interact: {
    allowed: ["action", "session_id", "chars", "yield_time_ms"],
    required: ["action", "session_id"],
    conflicts: [],
  },
  stop: { allowed: ["action", "session_id", "force"], required: ["action", "session_id"], conflicts: [] },
};
const EXPECTED: Record<Exclude<Field, "action">, string> = {
  command: "a string",
  cwd: "a string",
  profile: "an advertised value",
  shell: "an object matching its schema",
  tty: "a boolean",
  yield_time_ms: "an integer",
  timeout_ms: "an integer",
  session_id: "a string",
  chars: "a string",
  force: "a boolean",
};

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const isAction = (v: unknown): v is Action => v === "run" || v === "interact" || v === "stop";
const isUint = (v: unknown): v is number => typeof v === "number" && Number.isInteger(v) && v >= 0;

function wellTyped(field: Exclude<Field, "action">, v: unknown): boolean {
  switch (field) {
    case "yield_time_ms":
    case "timeout_ms":
      return isUint(v);
    case "tty":
    case "force":
      return typeof v === "boolean";
    case "profile":
      return v === "clean" || v === "user";
    case "shell":
      return isObj(v) && v.kind === "executable" && typeof v.path === "string";
    default:
      return typeof v === "string";
  }
}

/** Drops nulls and textual "null" placeholders the way fx elideKnownNullFields does. */
function elideNulls(o: Obj) {
  for (const f of FIELDS.slice(1)) {
    const v = o[f];
    if (v === null || (typeof v === "string" && v.trim().toLowerCase() === "null")) delete o[f];
  }
}

function fieldCorrection(action: Action, o: Obj) {
  const c = CONTRACT[action];
  const invalid = Object.keys(o)
    .filter((k) => !(c.allowed as string[]).includes(k))
    .sort();
  const missing = c.required.filter((f) => o[f] === undefined);
  const conflicts = c.conflicts.filter(([a, b]) => o[a] !== undefined && o[b] !== undefined);
  return invalid.length || missing.length || conflicts.length ? { invalid, missing, conflicts } : null;
}

function argumentProblem(i: Obj): string | null {
  switch (i.action) {
    case "run": {
      if (typeof i.command !== "string") return "request.command is required.";
      const len = Buffer.byteLength(i.command);
      if (len === 0 || len > MAX_COMMAND_BYTES) return "request.command must contain 1-65536 bytes.";
      if (i.timeout_ms === 0) return "request.timeout_ms must be at least 1; choose the intended deadline.";
      if (i.profile !== undefined && i.shell !== undefined) return "Choose either request.profile or request.shell.";
      if (!i.tty && i.shell !== undefined)
        return "request.shell requires tty=true; choose the intended execution mode.";
      if ((i.yield_time_ms as number) > MAX_YIELD_MS) return "request.yield_time_ms must be between 0 and 30000.";
      return null;
    }
    case "interact":
      if ((i.yield_time_ms as number) > MAX_WAIT_MS) return "request.yield_time_ms must be between 0 and 300000.";
      if (typeof i.chars === "string" && Buffer.byteLength(i.chars) > MAX_WRITE_BYTES)
        return "request.chars exceed 65536 bytes.";
      return null;
    default:
      return null;
  }
}

const defaultYield = (action: Action) =>
  action === "run" ? DEFAULT_YIELD_MS : action === "interact" ? DEFAULT_WAIT_MS : 0;

/** The dispatcher shape: `{request:{...}}` alone unwraps; anything else is the request itself. */
function unwrap(args: unknown): unknown {
  if (isObj(args) && Object.keys(args).length === 1 && isObj(args.request)) return args.request;
  return args;
}

function decodeStrict(args: unknown): ShellRequest | null {
  const raw = unwrap(args);
  if (!isObj(raw) || !isAction(raw.action)) return null;
  const o: Obj = { ...raw };
  elideNulls(o);
  if (fieldCorrection(o.action as Action, o)) return null;
  for (const f of FIELDS.slice(1) as Exclude<Field, "action">[]) {
    if (o[f] !== undefined && !wellTyped(f, o[f])) return null;
  }
  if (TTY_FIELDS.some((f) => o[f] !== undefined)) return null;
  if (o.action === "stop") o.force = o.force ?? false;
  else if (o.yield_time_ms === undefined) o.yield_time_ms = defaultYield(o.action as Action);
  if (argumentProblem(o)) return null;
  return o as ShellRequest;
}

function correction(problems: string[], candidate: Obj | null): string {
  return JSON.stringify({
    error: {
      code: "invalid_shell_request",
      executed: false,
      problems: [...new Set(problems)],
      ...(candidate
        ? { instruction: "Call shell once using retry_with exactly.", retry_with: { request: candidate } }
        : {}),
    },
  });
}

// Advisory only: none of these values enters the executable decode path.
function requestCorrection(args: unknown): string {
  if (typeof args === "string") {
    if (args.length > 16 * 1024) {
      return correction(
        ["Request is too large to suggest a repair; submit the intended action with only its required fields."],
        null,
      );
    }
    try {
      args = JSON.parse(args);
    } catch {
      return correction(["Shell arguments must be a JSON object."], null);
    }
  } else if (JSON.stringify(args ?? null).length > 16 * 1024) {
    return correction(
      ["Request is too large to suggest a repair; submit the intended action with only its required fields."],
      null,
    );
  }
  if (!isObj(args) || Object.keys(args).length > 32) {
    return correction(["Shell arguments must be one bounded request object."], null);
  }
  const problems: string[] = [];
  let repairable = true;
  let object: Obj = { ...args };
  if (args.request !== undefined) {
    let request = args.request;
    if (typeof request === "string") {
      problems.push("request must be an object, not a JSON string.");
      try {
        request = JSON.parse(request);
      } catch {
        return correction(problems, null);
      }
    }
    if (!isObj(request) || Object.keys(request).length > 32) {
      return correction(["request must be one object containing the intended action."], null);
    }
    object = { ...request };
    if (Object.keys(args).length > 1) {
      problems.push("Only request is allowed at the top level; put action fields inside request.");
      for (const [name, value] of Object.entries(args)) {
        if (name === "request") continue;
        if (name in object) repairable = false;
        else object[name] = value;
      }
    }
  }
  elideNulls(object);
  let action: Action;
  if (object.action !== undefined) {
    if (!isAction(object.action)) {
      problems.push("request.action must be run, interact, or stop.");
      return correction(problems, null);
    }
    action = object.action;
  } else {
    problems.push("request.action is required.");
    const command = object.command;
    if (
      command === undefined ||
      typeof command !== "string" ||
      "session_id" in object ||
      "chars" in object ||
      "force" in object
    ) {
      return correction(problems, null);
    }
    object.action = "run";
    action = "run";
  }

  const fields = fieldCorrection(action, object);
  if (fields) {
    for (const name of fields.invalid) {
      problems.push(`request.${name.slice(0, 64)} is not accepted for ${action}.`);
      // A non-null unknown field can express intent that cannot be reconstructed.
      if (object[name] !== null) repairable = false;
      delete object[name];
    }
    for (const name of fields.missing) {
      problems.push(`request.${name} is required.`);
      repairable = false;
    }
    for (const [a, b] of fields.conflicts) {
      problems.push(`Choose either request.${a} or request.${b}.`);
      repairable = false;
    }
  }

  const canonical: Obj = {};
  let typed = true;
  for (const field of FIELDS) {
    if (object[field] === undefined) continue;
    let value = object[field];
    if (field === "action") {
      canonical.action = value;
      continue;
    }
    let typeReported = false;
    if ((field === "yield_time_ms" || field === "timeout_ms") && typeof value === "string") {
      problems.push(`request.${field} must be an integer.`);
      typeReported = true;
      if (/^\d+$/.test(value.trim())) value = Number(value.trim());
      else repairable = false;
    }
    if (wellTyped(field, value)) {
      if (field === "shell") {
        const shell = value as Obj;
        value = Object.fromEntries(["kind", "path", "clean_start"].filter((k) => k in shell).map((k) => [k, shell[k]]));
      }
    } else {
      if (!typeReported) problems.push(`request.${field} must be ${EXPECTED[field]}.`);
      repairable = false;
      typed = false;
    }
    canonical[field] = value;
  }
  if (!typed) return correction(problems, null);
  const problem = argumentProblem({
    tty: false,
    ...canonical,
    yield_time_ms: canonical.yield_time_ms ?? DEFAULT_YIELD_MS,
  });
  if (problem) {
    problems.push(problem);
    repairable = false;
  }
  if (TTY_FIELDS.some((f) => canonical[f] !== undefined)) {
    problems.push("Interactive Shell fields require a saved session.");
    repairable = false;
  }
  if (problems.length === 0) problems.push("Submit one Shell action inside request.");
  return correction(problems, repairable ? canonical : null);
}

function effectiveInteractWait(requested: number): number {
  // Process-only executions never carry input, so the empty-observation rule always applies.
  return Math.min(Math.max(requested, DEFAULT_WAIT_MS), MAX_WAIT_MS);
}

function resolveCwd(ctx: ToolContext, requested: string | undefined): { cwd: string } | { error: string } {
  if (requested === undefined || requested === ".") return { cwd: ctx.workspaceRoot };
  let resolved: ResolvedPath;
  try {
    resolved = resolvePath(ctx.workspaceRoot, requested, ctx.home, ctx.additionalDirectories);
  } catch (err) {
    return { error: (err as Error).message };
  }
  if (resolved.external) return { error: "PathOutsideWorkspace" };
  try {
    if (!statSync(resolved.absolute).isDirectory()) return { error: "NotDir" };
  } catch {
    return { error: "FileNotFound" };
  }
  return { cwd: resolved.absolute };
}

const unavailable = (): ToolResult => ({
  status: "failure",
  output: '{"error":{"tool":"shell","code":"unavailable","retryable":false}}',
});
const runtimeFailure = (code: string): ToolResult => ({
  status: "failure",
  output: `{"error":{"tool":"shell","code":"${code}","retryable":false}}`,
});

function stateName(state: ShellSnapshot["state"]): "running" | "completed" | "stopped" | "lost" {
  if (state === "lost") return "lost";
  if (typeof state !== "object") return "running";
  return "completed" in state ? "completed" : "stopped";
}

const INCOMPLETE_GUIDANCE =
  "Command output is incomplete. Inspect external state and available output before retrying; do not blindly rerun a command that may have changed state.";
const LOST_GUIDANCE =
  "Execution status is indeterminate. Inspect external state before retrying; do not blindly rerun a command that may have changed state.";

function formatSnapshotRaw(s: ShellSnapshot, outputDelta: string, outputTruncated: boolean): string {
  const status = typeof s.state === "object" ? ("completed" in s.state ? s.state.completed : s.state.stopped) : null;
  return JSON.stringify({
    session_id: s.retained ? s.id : null,
    state: stateName(s.state),
    backend: "captured",
    persistence: "process",
    output_truncated: outputTruncated,
    output_incomplete: s.outputIncomplete,
    output_terminal_safe: true,
    full_output_handle: s.fullOutputHandle,
    exit_code: s.exitCode,
    signal: s.signal,
    termination_indeterminate: s.state === "lost" || status === "indeterminate",
    duration_ms: s.durationMs,
    accepted_bytes: null,
    error: s.error,
    retry_guidance: s.outputIncomplete ? INCOMPLETE_GUIDANCE : s.state === "lost" ? LOST_GUIDANCE : null,
    output_delta: outputDelta,
  });
}

/** JSON body kept within min(cap, 16 KiB) by trimming output_delta head/tail (binary search on the budget). */
export function formatSnapshot(s: ShellSnapshot, maxBytes: number): string {
  const inlineMax = Math.min(maxBytes, INLINE_MAX_BYTES);
  const full = formatSnapshotRaw(s, s.outputDelta, s.outputTruncated);
  if (Buffer.byteLength(full) <= inlineMax) return full;
  let lo = 0;
  let hi = Math.min(Buffer.byteLength(s.outputDelta), inlineMax);
  let best: string | null = null;
  while (lo <= hi) {
    const budget = lo + Math.floor((hi - lo) / 2);
    const candidate = formatSnapshotRaw(s, boundOutput(s.outputDelta, budget, OMISSION_MARKER), true);
    if (Buffer.byteLength(candidate) <= inlineMax) {
      best = candidate;
      lo = budget + 1;
    } else {
      if (budget === 0) break;
      hi = budget - 1;
    }
  }
  return best ?? formatSnapshotRaw(s, "", true);
}

export function snapshotFailed(s: ShellSnapshot): boolean {
  if (s.outputIncomplete) return true;
  if (s.state === "lost") return true;
  if (typeof s.state !== "object") return false;
  if ("stopped" in s.state) return true;
  const status = s.state.completed;
  return typeof status === "object" && "exitCode" in status ? status.exitCode !== 0 : true;
}

function stopResultFailed(s: ShellSnapshot): boolean {
  if (s.state === "lost") return true;
  return typeof s.state === "object" && "stopped" in s.state && s.state.stopped === "indeterminate";
}

function finish(s: ShellSnapshot, ctx: ToolContext, action: "command" | "stop"): ToolResult {
  const body = formatSnapshot(s, ctx.maxToolResultBytes);
  const failed = action === "command" ? snapshotFailed(s) : stopResultFailed(s);
  const handle = s.fullOutputHandle;
  const notice = handle
    ? `\n<command_output_handle>${handle}</command_output_handle>\nFull captured command output is available through read_tool_result with this handle.`
    : "";
  return {
    status: failed ? "failure" : "success",
    output: body + notice,
    memory: handle ? { commandOutputHandle: handle } : undefined,
  };
}

async function callRun(input: Extract<ShellRequest, { action: "run" }>, shell: ShellManager, ctx: ToolContext) {
  const resolved = resolveCwd(ctx, input.cwd);
  if ("error" in resolved)
    return { status: "failure", output: `shell run cwd is invalid: ${resolved.error}` } as ToolResult;
  const started = shell.start({
    command: input.command,
    cwd: resolved.cwd,
    profile: input.profile ?? "user",
    timeoutMs: input.timeout_ms,
    signal: ctx.signal,
  });
  if ("error" in started) {
    return {
      status: "failure",
      output: "shell run rejected: 64 executions are already live; stop one first",
    } as ToolResult;
  }
  const snap = await shell.observe(started.id, input.yield_time_ms);
  return snap ? finish(snap, ctx, "command") : runtimeFailure("ExecutionNotFound");
}

export const shellTool: ToolSpec<ShellRequest> = {
  name: "shell",
  description,
  parameters,
  activity: "command",
  requiresApproval: true,
  permissionTarget: "none",

  decode(args): DecodeResult<ShellRequest> {
    const input = decodeStrict(args);
    return input ? { ok: true, input } : { ok: false, failure: requestCorrection(args) };
  },

  targets(input): PermissionTarget[] {
    return input.action === "run" ? [{ permission: "bash", target: input.command, kind: "command" }] : [];
  },

  readsOnly(input) {
    return input.action !== "run";
  },

  label(input) {
    return input.action === "run" ? `shell.run ${input.command}` : `shell.${input.action} ${input.session_id}`;
  },

  async call(input, ctx) {
    const shell = ctx.shell;
    if (!shell) return unavailable();
    switch (input.action) {
      case "run":
        return callRun(input, shell, ctx);
      case "interact": {
        const snap = await shell.observe(input.session_id, effectiveInteractWait(input.yield_time_ms));
        return snap ? finish(snap, ctx, "command") : runtimeFailure("ExecutionNotFound");
      }
      case "stop": {
        const snap = await shell.stop(input.session_id, input.force);
        return snap ? finish(snap, ctx, "stop") : runtimeFailure("ExecutionNotFound");
      }
    }
  },
};
