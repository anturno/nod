/** Background command executions: spawn, observe deltas, stop, and retained full output logs. */
import { type ChildProcess, spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFileSync, mkdirSync } from "node:fs";
import { open, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { terminalSafe, utf8Backward, utf8Forward } from "./output.ts";
import type { ShellManager, ShellSnapshot, ShellStart, ShellState, ShellStatus } from "./types.ts";

export const MAX_LIVE = 64;
export const MAX_TOMBSTONES = 32;
export const STOP_SETTLE_MS = 5_000;
const HANDLE = /^nod-command-[A-Za-z0-9_-]{8}\.log$/;
const SEARCH_MAX_BYTES = 64 * 1024;

type Entry = {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  state: ShellState;
  child: ChildProcess | null;
  pending: Buffer[];
  pendingBytes: number;
  truncated: boolean;
  error: string | null;
  published: boolean;
  endedAt: number | null;
  done: Promise<void>;
  finish: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

export function isTerminal(state: ShellState): boolean {
  return typeof state === "object" || state === "lost";
}

function shellInvocation(profile: "user" | "clean", command: string): [string, string[]] {
  const configured = process.env.SHELL ?? "";
  const name = basename(configured);
  const shell = name === "bash" || name === "zsh" ? configured : "/bin/bash";
  if (profile === "user") return [shell, ["-lc", command]];
  return [shell, name === "zsh" ? ["-f", "-c", command] : ["--noprofile", "--norc", "-c", command]];
}

function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });
}

const managers = new Set<() => void>();
let exitHookRegistered = false;

export function createShellManager(deps: {
  maxOutputBytes: number;
  logDir: string;
  now?: () => number;
  stopSettleMs?: number;
}): ShellManager {
  const now = deps.now ?? Date.now;
  const stopSettleMs = deps.stopSettleMs ?? STOP_SETTLE_MS;
  const live = new Map<string, Entry>();
  const tombstones = new Map<string, ShellSnapshot>();
  mkdirSync(deps.logDir, { recursive: true });

  const logPath = (id: string) => join(deps.logDir, `nod-command-${id}.log`);

  function killGroup(e: Entry, sig: "SIGTERM" | "SIGKILL") {
    const pid = e.child?.pid;
    if (!pid) return;
    try {
      process.kill(-pid, sig);
    } catch {
      try {
        e.child?.kill(sig);
      } catch {}
    }
  }

  function settle(e: Entry, state: ShellState, error: string | null = null) {
    if (isTerminal(e.state)) return;
    e.state = state;
    e.error = error;
    e.endedAt = now();
    clearTimeout(e.timer);
    e.finish();
  }

  function onChunk(e: Entry, chunk: Buffer) {
    // ponytail: synchronous append per chunk keeps close == fully logged; a WriteStream if disks are slow.
    appendFileSync(logPath(e.id), chunk);
    e.pending.push(chunk);
    e.pendingBytes += chunk.length;
    while (e.pendingBytes > deps.maxOutputBytes) {
      const excess = e.pendingBytes - deps.maxOutputBytes;
      const first = e.pending[0]!;
      e.truncated = true;
      if (first.length <= excess) {
        e.pending.shift();
        e.pendingBytes -= first.length;
      } else {
        e.pending[0] = first.subarray(excess);
        e.pendingBytes -= excess;
      }
    }
  }

  /** Delivers everything undelivered; a live delta stops at the last complete UTF-8 sequence. */
  function takeDelta(e: Entry): string {
    const all = Buffer.concat(e.pending);
    const end = isTerminal(e.state) ? all.length : utf8Backward(all, all.length);
    e.pending = end < all.length ? [all.subarray(end)] : [];
    e.pendingBytes = all.length - end;
    return terminalSafe(all.subarray(0, end));
  }

  function snapshot(e: Entry, delta: string): ShellSnapshot {
    const status: ShellStatus | null =
      typeof e.state === "object" ? ("completed" in e.state ? e.state.completed : e.state.stopped) : null;
    return {
      id: e.id,
      command: e.command,
      cwd: e.cwd,
      startedAt: e.startedAt,
      retained: true,
      state: e.state,
      outputDelta: delta,
      outputTruncated: e.truncated,
      outputIncomplete: false,
      fullOutputHandle: `nod-command-${e.id}.log`,
      exitCode: status !== null && typeof status === "object" && "exitCode" in status ? status.exitCode : null,
      signal: status !== null && typeof status === "object" && "signal" in status ? status.signal : null,
      durationMs: (e.endedAt ?? now()) - e.startedAt,
      error: e.error,
    };
  }

  // ponytail: the delta is committed the moment observe/stop returns (no reservation/cancel handshake as in fx);
  // if the caller then fails to publish the result, that delta is only recoverable via readRetained.
  function deliver(e: Entry): ShellSnapshot {
    const snap = snapshot(e, takeDelta(e));
    e.truncated = false;
    e.published = true;
    if (isTerminal(e.state)) {
      live.delete(e.id);
      tombstones.set(e.id, { ...snap, outputDelta: "", outputTruncated: false, retained: false });
      while (tombstones.size > MAX_TOMBSTONES) tombstones.delete(tombstones.keys().next().value!);
    }
    return snap;
  }

  const manager: ShellManager = {
    start(input: ShellStart) {
      if (live.size >= MAX_LIVE) return { error: "capacity_exhausted" };
      const id = randomBytes(6).toString("base64url");
      let finish = () => {};
      const done = new Promise<void>((resolve) => (finish = resolve));
      const e: Entry = {
        id,
        command: input.command,
        cwd: input.cwd,
        startedAt: now(),
        state: "starting",
        child: null,
        pending: [],
        pendingBytes: 0,
        truncated: false,
        error: null,
        published: false,
        endedAt: null,
        done,
        finish,
      };
      live.set(id, e);
      appendFileSync(logPath(id), "");
      const [shell, args] = shellInvocation(input.profile, input.command);
      try {
        e.child = spawn(shell, args, {
          cwd: input.cwd,
          detached: true,
          stdio: ["ignore", "pipe", "pipe"],
          env: { ...process.env, TERM: "dumb", NO_COLOR: "1", CI: "1", PAGER: "cat", GIT_PAGER: "cat" },
        });
      } catch (err) {
        settle(e, "lost", String((err as Error).message ?? err));
        return { id };
      }
      e.state = "running";
      e.child.stdout?.on("data", (chunk: Buffer) => onChunk(e, chunk));
      e.child.stderr?.on("data", (chunk: Buffer) => onChunk(e, chunk));
      e.child.on("error", (err) => settle(e, "lost", err.message));
      // close fires after exit AND both pipes drained: the completion barrier.
      e.child.on("close", (code, signal) => {
        const status: ShellStatus = signal ? { signal } : code !== null ? { exitCode: code } : "indeterminate";
        settle(e, e.state === "stopping" ? { stopped: status } : { completed: status });
      });
      if (input.timeoutMs) {
        e.timer = setTimeout(() => {
          e.state = "stopping";
          killGroup(e, "SIGKILL");
        }, input.timeoutMs);
      }
      // Cancelled before the first result was published: stop and join. Afterwards only the waiter is released.
      input.signal?.addEventListener("abort", () => void (e.published || manager.stop(id, false)), { once: true });
      return { id };
    },

    async observe(id, waitMs) {
      const tomb = tombstones.get(id);
      if (tomb) return tomb;
      const e = live.get(id);
      if (!e) return null;
      if (!isTerminal(e.state) && waitMs > 0) {
        const ac = new AbortController();
        await Promise.race([e.done, sleep(waitMs, ac.signal)]);
        ac.abort();
      }
      return deliver(e);
    },

    async write() {
      // ponytail: no PTY in Bun without a native dependency; add node-pty for tty=true.
      throw new Error("tty unavailable");
    },

    async stop(id, force) {
      const tomb = tombstones.get(id);
      if (tomb) return tomb;
      const e = live.get(id);
      if (!e) return null;
      if (!isTerminal(e.state)) {
        e.state = "stopping";
        killGroup(e, force ? "SIGKILL" : "SIGTERM");
        const ac = new AbortController();
        await Promise.race([e.done, sleep(stopSettleMs, ac.signal)]);
        ac.abort();
        if (!isTerminal(e.state)) {
          killGroup(e, "SIGKILL");
          // ponytail: a grandchild outside the group holding the pipes would delay this; add a hard cap if seen.
          await e.done;
        }
      }
      return deliver(e);
    },

    list() {
      return [...live.values()].map((e) => snapshot(e, ""));
    },

    async readRetained(handle, startByte, byteCount) {
      if (!HANDLE.test(handle)) return null;
      let file: Awaited<ReturnType<typeof open>>;
      try {
        file = await open(join(deps.logDir, handle), "r");
      } catch {
        return null;
      }
      try {
        const total = (await file.stat()).size;
        const start = Math.min(Math.max(startByte, 1) - 1, total);
        const raw = Buffer.alloc(Math.max(0, Math.min(byteCount, total - start)));
        const { bytesRead } = await file.read(raw, 0, raw.length, start);
        const page = raw.subarray(0, bytesRead);
        const from = utf8Forward(page, 0);
        const to = bytesRead === raw.length && start + bytesRead < total ? utf8Backward(page, bytesRead) : bytesRead;
        const body = terminalSafe(page.subarray(from, to));
        const first = start + from;
        return `<command_output handle="${handle}" start_byte="${first + 1}" end_byte="${first + (to - from)}" total_bytes="${total}">\n${body}</command_output>`;
      } finally {
        await file.close();
      }
    },

    async searchRetained(handle, query) {
      if (!HANDLE.test(handle)) return null;
      let text: string;
      try {
        text = terminalSafe(await readFile(join(deps.logDir, handle)));
      } catch {
        return null;
      }
      const needle = query.trim();
      let out = `<command_output_query handle="${handle}">\nquery: ${JSON.stringify(needle)}\n`;
      let matches = 0;
      const lines = text.split("\n");
      for (let i = 0; i < lines.length && matches < 50 && out.length < SEARCH_MAX_BYTES; i++) {
        if (!lines[i]!.includes(needle)) continue;
        out += `${i + 1}|${lines[i]}\n`;
        matches++;
      }
      if (matches === 0) out += "(no matches)\n";
      return `${out}</command_output_query>`;
    },

    killAll() {
      for (const e of live.values()) if (!isTerminal(e.state)) killGroup(e, "SIGKILL");
    },
  };

  managers.add(manager.killAll);
  if (!exitHookRegistered) {
    exitHookRegistered = true;
    process.once("exit", () => {
      for (const kill of managers) kill();
    });
  }
  return manager;
}
