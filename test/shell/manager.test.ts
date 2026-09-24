import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createShellManager, MAX_LIVE } from "../../src/core/shell/manager.ts";
import type { ShellManager } from "../../src/core/shell/types.ts";

const logDir = mkdtempSync(join(tmpdir(), "nod-shell-"));
const created: ShellManager[] = [];
function manager(opts: { maxOutputBytes?: number; stopSettleMs?: number } = {}) {
  const m = createShellManager({
    maxOutputBytes: opts.maxOutputBytes ?? 65536,
    logDir,
    stopSettleMs: opts.stopSettleMs,
  });
  created.push(m);
  return m;
}
const start = (m: ShellManager, command: string, extra: { timeoutMs?: number; signal?: AbortSignal } = {}) => {
  const started = m.start({ command, cwd: logDir, profile: "clean", ...extra });
  if ("error" in started) throw new Error(started.error);
  return started.id;
};
afterAll(() => {
  for (const m of created) m.killAll();
});

describe("createShellManager", () => {
  test("completes a fast command with exit code, delta, and a full output log", async () => {
    const m = manager();
    const id = start(m, "printf 'hi\\n'; printf 'err' >&2");
    expect(id).toMatch(/^[A-Za-z0-9_-]{8}$/);
    const snap = (await m.observe(id, 3000))!;
    expect(snap.state).toEqual({ completed: { exitCode: 0 } });
    expect(snap.exitCode).toBe(0);
    expect(snap.signal).toBeNull();
    expect(snap.retained).toBe(true);
    expect(snap.outputDelta).toContain("hi\n");
    expect(snap.outputDelta).toContain("err");
    expect(snap.fullOutputHandle).toBe(`nod-command-${id}.log`);
    expect(snap.durationMs).toBeGreaterThanOrEqual(0);
    expect(readFileSync(join(logDir, snap.fullOutputHandle!), "utf8")).toContain("hi\n");
  });

  test("reports non-zero exit codes", async () => {
    const m = manager();
    const snap = (await m.observe(start(m, "sh -c 'exit 3'"), 3000))!;
    expect(snap.state).toEqual({ completed: { exitCode: 3 } });
    expect(snap.exitCode).toBe(3);
  });

  test("yield 0 returns running immediately and later observes commit only new output", async () => {
    const m = manager();
    const id = start(m, "printf a; sleep 0.2; printf b");
    const first = (await m.observe(id, 0))!;
    expect(first.state).toBe("running");
    await Bun.sleep(50);
    const second = (await m.observe(id, 0))!;
    expect(second.outputDelta).toBe("a");
    const third = (await m.observe(id, 3000))!;
    expect(third.state).toEqual({ completed: { exitCode: 0 } });
    expect(third.outputDelta).toBe("b");
    expect(m.list().find((s) => s.id === id)).toBeUndefined();
  });

  test("a tombstone still answers with its final state, retained:false and no delta", async () => {
    const m = manager();
    const id = start(m, "printf done");
    await m.observe(id, 3000);
    const tomb = (await m.observe(id, 0))!;
    expect(tomb.retained).toBe(false);
    expect(tomb.outputDelta).toBe("");
    expect(tomb.exitCode).toBe(0);
    expect((await m.stop(id, true))!.retained).toBe(false);
    expect(await m.observe("nope1234", 0)).toBeNull();
  });

  test("bounds the in-memory delta but keeps the complete log", async () => {
    const m = manager({ maxOutputBytes: 16 });
    const id = start(m, "printf '%0100d' 7");
    const snap = (await m.observe(id, 3000))!;
    expect(snap.outputTruncated).toBe(true);
    expect(snap.outputDelta.length).toBe(16);
    expect(readFileSync(join(logDir, snap.fullOutputHandle!), "utf8").length).toBe(100);
  });

  test("stop sends SIGTERM to the group and escalates to SIGKILL", async () => {
    const m = manager({ stopSettleMs: 100 });
    const gentle = start(m, "sleep 5");
    await m.observe(gentle, 0);
    const stopped = (await m.stop(gentle, false))!;
    expect(stopped.state).toEqual({ stopped: { signal: "SIGTERM" } });
    expect(stopped.signal).toBe("SIGTERM");

    const stubborn = start(m, "trap '' TERM; sleep 5");
    await Bun.sleep(100);
    const killed = (await m.stop(stubborn, false))!;
    expect(killed.state).toEqual({ stopped: { signal: "SIGKILL" } });

    const forced = start(m, "sleep 5");
    expect((await m.stop(forced, true))!.signal).toBe("SIGKILL");
  });

  test("timeoutMs kills the group and reports stopped with SIGKILL", async () => {
    const m = manager();
    const snap = (await m.observe(start(m, "sleep 5", { timeoutMs: 100 }), 3000))!;
    expect(snap.state).toEqual({ stopped: { signal: "SIGKILL" } });
  });

  test("delivers terminal-safe output", async () => {
    const m = manager();
    const snap = (await m.observe(start(m, "printf '\\033[31mred\\033[0m\\001'"), 3000))!;
    expect(snap.outputDelta).toBe("red\\u{0001}");
  });

  test("rejects the 65th live execution and killAll releases them", async () => {
    const m = manager();
    const ids = Array.from({ length: MAX_LIVE }, () => start(m, "sleep 5"));
    expect(m.start({ command: "true", cwd: logDir, profile: "clean" })).toEqual({ error: "capacity_exhausted" });
    expect(m.list()).toHaveLength(MAX_LIVE);
    m.killAll();
    for (const id of ids) expect((await m.observe(id, 3000))!.state).toEqual({ completed: { signal: "SIGKILL" } });
    expect(m.list()).toHaveLength(0);
  });

  test("cancellation before publish stops the execution", async () => {
    const m = manager();
    const ac = new AbortController();
    const id = start(m, "sleep 5", { signal: ac.signal });
    ac.abort();
    const snap = (await m.observe(id, 3000))!;
    expect(snap.state).toEqual({ stopped: { signal: "SIGTERM" } });
  });

  test("write rejects without a tty", async () => {
    const m = manager();
    const id = start(m, "sleep 0.2");
    await expect(m.write(id, "x\n")).rejects.toThrow("tty unavailable");
    await m.stop(id, true);
  });

  test("reads and searches retained output by handle", async () => {
    const m = manager();
    const id = start(m, "printf 'alpha\\nbeta\\ngamma\\n'");
    const snap = (await m.observe(id, 3000))!;
    const handle = snap.fullOutputHandle!;
    expect(await m.readRetained(handle, 1, 5)).toBe(
      `<command_output handle="${handle}" start_byte="1" end_byte="5" total_bytes="17">\nalpha</command_output>`,
    );
    expect(await m.readRetained(handle, 7, 100)).toContain('start_byte="7" end_byte="17"');
    expect(await m.searchRetained(handle, "a")).toBe(
      `<command_output_query handle="${handle}">\nquery: "a"\n1|alpha\n2|beta\n3|gamma\n</command_output_query>`,
    );
    expect(await m.searchRetained(handle, "zzz")).toContain("(no matches)");
    expect(await m.readRetained("nod-command-zzzzzzzz.log", 1, 10)).toBeNull();
    expect(await m.readRetained("../etc/passwd", 1, 10)).toBeNull();
  });
});
