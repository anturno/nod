import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShellManager } from "../../src/core/shell/manager.ts";
import type { ShellSnapshot } from "../../src/core/shell/types.ts";
import { formatSnapshot, type ShellRequest, shellTool, snapshotFailed } from "../../src/core/tools/shell.ts";
import type { ToolContext } from "../../src/core/tools/spec.ts";

const workspace = mkdtempSync(join(tmpdir(), "nod-shell-tool-"));
mkdirSync(join(workspace, "sub"));
const shell = createShellManager({ maxOutputBytes: 65536, logDir: join(workspace, ".logs") });
afterAll(() => shell.killAll());

const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({
  workspaceRoot: workspace,
  cwd: workspace,
  home: workspace,
  resultDir: join(workspace, ".results"),
  sessionId: "s1",
  maxToolResultBytes: 65536,
  images: [],
  additionalDirectories: [],
  shell,
  ...extra,
});

const decode = (args: unknown) => shellTool.decode(args, ctx());
const failure = (args: unknown) => {
  const r = decode(args);
  if (r.ok) throw new Error("expected failure");
  return JSON.parse(r.failure).error;
};
const run = async (request: Record<string, unknown>, c = ctx()) => {
  const d = decode({ request });
  if (!d.ok) throw new Error(d.failure);
  const result = await shellTool.call(d.input, c);
  const [json, ...rest] = result.output.split("\n<command_output_handle>");
  return { result, body: JSON.parse(json!), notice: rest.join("") };
};

describe("shell schema", () => {
  test("is the process-only request union", () => {
    expect(shellTool.name).toBe("shell");
    expect(shellTool.activity).toBe("command");
    expect(shellTool.requiresApproval).toBe(true);
    expect(shellTool.permissionTarget).toBe("none");
    const p = shellTool.parameters as {
      required: string[];
      properties: { request: { oneOf: { properties: object }[] } };
    };
    expect(p.required).toEqual(["request"]);
    expect(p.properties.request.oneOf.map((o) => Object.keys(o.properties))).toEqual([
      ["action", "command", "cwd", "profile", "yield_time_ms", "timeout_ms"],
      ["action", "session_id", "yield_time_ms"],
      ["action", "session_id", "force"],
    ]);
    expect(JSON.stringify(shellTool.parameters)).not.toContain("tty");
    expect(shellTool.description).toStartWith("Run every command with shell.run.");
  });
});

describe("shell decode", () => {
  test("accepts wrapped and bare requests with action defaults", () => {
    expect(decode({ request: { action: "run", command: "ls" } })).toEqual({
      ok: true,
      input: { action: "run", command: "ls", yield_time_ms: 30000 },
    });
    expect(decode({ action: "interact", session_id: "abc", chars: null })).toEqual({
      ok: true,
      input: { action: "interact", session_id: "abc", yield_time_ms: 5000 },
    });
    expect(decode({ request: { action: "stop", session_id: "abc", cwd: "null" } })).toEqual({
      ok: true,
      input: { action: "stop", session_id: "abc", force: false },
    });
  });

  test("returns retry_with for repairable mistakes", () => {
    const e = failure({ request: { action: "run", command: "ls", bogus: null } });
    expect(e.code).toBe("invalid_shell_request");
    expect(e.executed).toBe(false);
    expect(e.problems).toEqual(["request.bogus is not accepted for run."]);
    expect(e.instruction).toBe("Call shell once using retry_with exactly.");
    expect(e.retry_with).toEqual({ request: { action: "run", command: "ls" } });

    const missing = failure({ command: "ls", yield_time_ms: "100" });
    expect(missing.problems).toEqual(["request.action is required.", "request.yield_time_ms must be an integer."]);
    expect(missing.retry_with).toEqual({ request: { action: "run", command: "ls", yield_time_ms: 100 } });

    const nested = failure({ request: { action: "stop", session_id: "x" }, force: true });
    expect(nested.problems).toEqual(["Only request is allowed at the top level; put action fields inside request."]);
    expect(nested.retry_with).toEqual({ request: { action: "stop", session_id: "x", force: true } });
  });

  test("reports validation problems verbatim without retry_with", () => {
    expect(failure({ action: "run", command: "" }).problems).toEqual(["request.command must contain 1-65536 bytes."]);
    expect(failure({ action: "run", command: "x".repeat(65537) }).problems).toEqual([
      "Request is too large to suggest a repair; submit the intended action with only its required fields.",
    ]);
    expect(failure({ action: "run", command: "ls", yield_time_ms: 30001 }).problems).toEqual([
      "request.yield_time_ms must be between 0 and 30000.",
    ]);
    expect(failure({ action: "interact", session_id: "a", yield_time_ms: 300001 }).problems).toEqual([
      "request.yield_time_ms must be between 0 and 300000.",
    ]);
    expect(failure({ action: "run", command: "ls", timeout_ms: 0 }).problems).toEqual([
      "request.timeout_ms must be at least 1; choose the intended deadline.",
    ]);
    expect(failure({ action: "run", command: "ls", yield_time_ms: "abc" })).not.toHaveProperty("retry_with");
    expect(failure({ action: "run" }).problems).toEqual(["request.command is required."]);
    expect(failure({ action: "run", command: "ls", profile: "posix" }).problems).toEqual([
      "request.profile must be an advertised value.",
    ]);
    expect(failure({ action: "launch", command: "ls" }).problems).toEqual([
      "request.action must be run, interact, or stop.",
    ]);
    expect(failure({ action: "run", command: "ls", tty: true }).problems).toEqual([
      "Interactive Shell fields require a saved session.",
    ]);
    expect(failure({ action: "interact", session_id: "a", chars: "y\n" }).problems).toEqual([
      "Interactive Shell fields require a saved session.",
    ]);
    expect(failure({ action: "run", command: "ls", force: true }).problems).toEqual([
      "request.force is not accepted for run.",
    ]);
    expect(failure({ action: "run", command: "ls", force: true })).not.toHaveProperty("retry_with");
    expect(failure([]).problems).toEqual(["Shell arguments must be one bounded request object."]);
    expect(failure("{nope").problems).toEqual(["Shell arguments must be a JSON object."]);
    expect(failure({ request: "[]" }).problems).toEqual(["request must be one object containing the intended action."]);
    expect(failure({ request: '{"action":"stop","session_id":"s"}' }).problems).toEqual([
      "request must be an object, not a JSON string.",
    ]);
    expect(failure({ request: 5 }).problems).toEqual(["request must be one object containing the intended action."]);
  });

  test("targets, readsOnly and label follow the action", () => {
    const run: ShellRequest = { action: "run", command: "bun test", yield_time_ms: 0 };
    const interact: ShellRequest = { action: "interact", session_id: "abc", yield_time_ms: 0 };
    const stop: ShellRequest = { action: "stop", session_id: "abc", force: true };
    expect(shellTool.targets!(run, ctx())).toEqual([{ permission: "bash", target: "bun test", kind: "command" }]);
    expect(shellTool.targets!(interact, ctx())).toEqual([]);
    expect(shellTool.readsOnly!(run)).toBe(false);
    expect(shellTool.readsOnly!(interact)).toBe(true);
    expect(shellTool.readsOnly!(stop)).toBe(true);
    expect(shellTool.label!(run, ctx())).toBe("shell.run bun test");
    expect(shellTool.label!(interact, ctx())).toBe("shell.interact abc");
    expect(shellTool.label!(stop, ctx())).toBe("shell.stop abc");
  });
});

describe("shell call", () => {
  test("runs a command and returns the snapshot body plus the output handle notice", async () => {
    const { result, body, notice } = await run({ action: "run", command: "printf 'hi\\n'", profile: "clean" });
    expect(result.status).toBe("success");
    expect(body).toMatchObject({
      state: "completed",
      backend: "captured",
      persistence: "process",
      output_truncated: false,
      output_incomplete: false,
      output_terminal_safe: true,
      exit_code: 0,
      signal: null,
      termination_indeterminate: false,
      accepted_bytes: null,
      error: null,
      retry_guidance: null,
      output_delta: "hi\n",
    });
    expect(body.session_id).toMatch(/^[A-Za-z0-9_-]{8}$/);
    expect(body.full_output_handle).toBe(`nod-command-${body.session_id}.log`);
    expect(notice).toBe(
      `${body.full_output_handle}</command_output_handle>\nFull captured command output is available through read_tool_result with this handle.`,
    );
    expect(result.memory).toEqual({ commandOutputHandle: body.full_output_handle });
  });

  test("fails on non-zero exit and on stopped executions", async () => {
    const failed = await run({ action: "run", command: "sh -c 'exit 3'", profile: "clean" });
    expect(failed.result.status).toBe("failure");
    expect(failed.body.exit_code).toBe(3);

    const started = await run({ action: "run", command: "sleep 5", profile: "clean", yield_time_ms: 0 });
    expect(started.body.state).toBe("running");
    const stopped = await run({ action: "stop", session_id: started.body.session_id, force: true });
    expect(stopped.result.status).toBe("success");
    expect(stopped.body).toMatchObject({ state: "stopped", signal: "SIGKILL", exit_code: null });
    const tomb = await run({ action: "interact", session_id: started.body.session_id, yield_time_ms: 0 });
    expect(tomb.result.status).toBe("failure");
    expect(tomb.body.session_id).toBeNull();
  });

  test("resolves cwd inside the workspace or an additional directory", async () => {
    const inside = await run({ action: "run", command: "pwd", cwd: "sub", profile: "clean" });
    expect(inside.body.output_delta.trim()).toEndWith("/sub");
    const outside = await shellTool.call({ action: "run", command: "pwd", cwd: "/", yield_time_ms: 0 }, ctx());
    expect(outside).toEqual({ status: "failure", output: "shell run cwd is invalid: PathOutsideWorkspace" });
    const missing = await shellTool.call({ action: "run", command: "pwd", cwd: "sub/none", yield_time_ms: 0 }, ctx());
    expect(missing.output).toBe("shell run cwd is invalid: FileNotFound");
    const extra = await run(
      { action: "run", command: "pwd", cwd: "/", profile: "clean" },
      ctx({ additionalDirectories: ["/"] }),
    );
    expect(extra.result.status).toBe("success");
  });

  test("reports unavailable runtime and unknown executions", async () => {
    expect(await shellTool.call({ action: "stop", session_id: "x", force: false }, ctx({ shell: undefined }))).toEqual({
      status: "failure",
      output: '{"error":{"tool":"shell","code":"unavailable","retryable":false}}',
    });
    expect(await shellTool.call({ action: "interact", session_id: "nope", yield_time_ms: 0 }, ctx())).toEqual({
      status: "failure",
      output: '{"error":{"tool":"shell","code":"ExecutionNotFound","retryable":false}}',
    });
  });

  test("bounds the body to min(cap, 16 KiB) with the omission marker", async () => {
    const big = await run(
      { action: "run", command: "printf '%020000d' 1", profile: "clean" },
      ctx({ maxToolResultBytes: 2048 }),
    );
    const json = big.result.output.split("\n<command_output_handle>")[0]!;
    expect(Buffer.byteLength(json)).toBeLessThanOrEqual(2048);
    expect(big.body.output_truncated).toBe(true);
    expect(big.body.output_delta).toContain("\n... bytes omitted; use full_output_handle for exact output ...\n");
    expect(big.result.status).toBe("success");
  });
});

describe("snapshotFailed and formatSnapshot", () => {
  const base: ShellSnapshot = {
    id: "abcdefgh",
    command: "x",
    cwd: "/",
    startedAt: 0,
    retained: true,
    state: "running",
    outputDelta: "",
    outputTruncated: false,
    outputIncomplete: false,
    fullOutputHandle: "nod-command-abcdefgh.log",
    exitCode: null,
    signal: null,
    durationMs: 1,
    error: null,
  };

  test("matrix", () => {
    expect(snapshotFailed(base)).toBe(false);
    expect(snapshotFailed({ ...base, state: { completed: { exitCode: 0 } } })).toBe(false);
    expect(snapshotFailed({ ...base, state: { completed: { exitCode: 1 } } })).toBe(true);
    expect(snapshotFailed({ ...base, state: { completed: { signal: "SIGTERM" } } })).toBe(true);
    expect(snapshotFailed({ ...base, state: { completed: "indeterminate" } })).toBe(true);
    expect(snapshotFailed({ ...base, state: { stopped: { exitCode: 0 } } })).toBe(true);
    expect(snapshotFailed({ ...base, state: "lost" })).toBe(true);
    expect(snapshotFailed({ ...base, outputIncomplete: true })).toBe(true);
  });

  test("lost and incomplete carry retry guidance", () => {
    const lost = JSON.parse(formatSnapshot({ ...base, state: "lost", retained: false }, 65536));
    expect(lost).toMatchObject({ session_id: null, state: "lost", termination_indeterminate: true });
    expect(lost.retry_guidance).toBe(
      "Execution status is indeterminate. Inspect external state before retrying; do not blindly rerun a command that may have changed state.",
    );
    const incomplete = JSON.parse(formatSnapshot({ ...base, outputIncomplete: true }, 65536));
    expect(incomplete.retry_guidance).toBe(
      "Command output is incomplete. Inspect external state and available output before retrying; do not blindly rerun a command that may have changed state.",
    );
    expect(Object.keys(lost)).toEqual([
      "session_id",
      "state",
      "backend",
      "persistence",
      "output_truncated",
      "output_incomplete",
      "output_terminal_safe",
      "full_output_handle",
      "exit_code",
      "signal",
      "termination_indeterminate",
      "duration_ms",
      "accepted_bytes",
      "error",
      "retry_guidance",
      "output_delta",
    ]);
  });

  test("never exceeds 16 KiB even with a larger cap", () => {
    const body = formatSnapshot({ ...base, outputDelta: "é".repeat(20000) }, 1 << 20);
    expect(Buffer.byteLength(body)).toBeLessThanOrEqual(16 * 1024);
    expect(JSON.parse(body).output_truncated).toBe(true);
  });
});
