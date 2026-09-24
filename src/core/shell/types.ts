/** Background command execution contract used by the shell tool and the UIs. */

export type ShellStatus = { exitCode: number } | { signal: string } | "indeterminate";
export type ShellState =
  | "starting"
  | "running"
  | "stopping"
  | { completed: ShellStatus }
  | { stopped: ShellStatus | null }
  | "lost";

export type ShellSnapshot = {
  id: string;
  command: string;
  cwd: string;
  startedAt: number;
  /** False once the execution is a tombstone: it still answers, but the handle is gone. */
  retained: boolean;
  state: ShellState;
  /** Output produced since the last observation, already terminal-safe. */
  outputDelta: string;
  outputTruncated: boolean;
  outputIncomplete: boolean;
  /** Handle for read_tool_result over the complete raw output, or null. */
  fullOutputHandle: string | null;
  exitCode: number | null;
  signal: string | null;
  durationMs: number | null;
  error: string | null;
};

export type ShellStart = {
  command: string;
  cwd: string;
  profile: "user" | "clean";
  timeoutMs?: number;
  signal?: AbortSignal;
};

export type ShellManager = {
  start(input: ShellStart): { id: string } | { error: "capacity_exhausted" };
  /** Waits until the process exits or waitMs elapses, then returns undelivered output. */
  observe(id: string, waitMs: number): Promise<ShellSnapshot | null>;
  /** Sends input to a tty execution. Rejects when the execution has no tty. */
  write(id: string, chars: string): Promise<void>;
  stop(id: string, force: boolean): Promise<ShellSnapshot | null>;
  list(): ShellSnapshot[];
  /** Reads a byte range of a retained full output by handle. Null when unknown. */
  readRetained(handle: string, startByte: number, byteCount: number): Promise<string | null>;
  searchRetained(handle: string, query: string): Promise<string | null>;
  killAll(): void;
};
