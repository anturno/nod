/** createTerminal: the interactive shell over a host terminal adapter (xterm.js or any cols/rows/write/onData surface). */
import { Readable, Writable } from "node:stream";
import { parseGlobalArgs, type ResumeTarget } from "../cli/global-args.ts";

export type TerminalAdapter = {
  readonly cols: number;
  readonly rows: number;
  write(bytes: Uint8Array | string): void;
  onData(callback: (data: string) => void): () => void;
  onResize(callback: () => void): () => void;
  /** Flushes pending output before the terminal counts as interactive. */
  drain?(): void | Promise<void>;
};

export type SessionStore = {
  load(id: string): Promise<Uint8Array | null> | Uint8Array | null;
  commit(id: string, bytes: Uint8Array, expected?: string): Promise<string | undefined> | string | undefined;
  list():
    | Promise<{ id: string; title?: string; updatedAt: number }[]>
    | { id: string; title?: string; updatedAt: number }[];
  remove(id: string): Promise<void> | void;
};

export type Exec = (r: {
  command: string;
  cwd: string;
  signal?: AbortSignal;
}) => Promise<{ output: string; exitCode: number | null }>;

/** The contract `src/ui/index.tsx` implements (AGENT_COMMON.md); `openUrl` and `sessionStore` are additive. */
export type RunTuiOptions = {
  cwd: string;
  env: Record<string, string | undefined>;
  resume?: ResumeTarget;
  fullAccess?: boolean;
  addDirs?: string[];
  noAdditionalDirs?: boolean;
  contextLimits?: string[];
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  patchConsole?: boolean;
  exec?: Exec;
  openUrl?: (url: string) => boolean | Promise<boolean>;
  sessionStore?: SessionStore;
};

export type DiagnosticEvent = { type: string; timestamp: number; [detail: string]: unknown };

export type TerminalOptions = {
  terminal: TerminalAdapter;
  env?: Record<string, string>;
  /** CLI arguments such as `["--resume", "last"]` or `["--full-access"]`. */
  args?: string[];
  onEvent?: (event: DiagnosticEvent) => void;
  /** String input containing this key is reported as `terminal.interrupt`; "" disables it. Default ctrl+c. */
  interruptKey?: string;
  sessionStore?: SessionStore;
  openUrl?: (url: string) => boolean | Promise<boolean>;
  workspace?: { cwd?: string; exec?: Exec };
  /** The shell implementation; defaults to `src/ui/index.tsx`. Tests inject a fake. */
  runTui?: (options: RunTuiOptions) => Promise<number>;
};

export type TerminalRuntime = {
  interactive: Promise<void>;
  exited: Promise<number>;
  write(data: string | Uint8Array): void;
  resize(): void;
  abort(): void;
};

const TUI_MODULE = "../ui/index.tsx";
const loadRunTui = async (): Promise<NonNullable<TerminalOptions["runTui"]>> =>
  ((await import(TUI_MODULE)) as { runTui: NonNullable<TerminalOptions["runTui"]> }).runTui;

export async function createTerminal(options: TerminalOptions): Promise<TerminalRuntime> {
  if (!options?.terminal) throw new TypeError("terminal is required");
  const { terminal } = options;
  const emit = (type: string, detail: Record<string, unknown> = {}) => {
    try {
      options.onEvent?.({ type, timestamp: performance.now(), ...detail });
    } catch {}
  };
  const runTui = options.runTui ?? (await loadRunTui());
  const global = parseGlobalArgs(options.args ?? []);
  if (global.rest.length) throw new TypeError(`unsupported terminal argument: ${global.rest[0]}`);

  let resolveInteractive: () => void = () => {};
  let rejectInteractive: (e: Error) => void = () => {};
  let interactiveScheduled = false;
  const interactive = new Promise<void>((resolve, reject) => {
    resolveInteractive = resolve;
    rejectInteractive = reject;
  });
  interactive.catch(() => {});
  const markInteractive = () => {
    if (interactiveScheduled) return;
    interactiveScheduled = true;
    queueMicrotask(async () => {
      try {
        await terminal.drain?.();
        resolveInteractive();
      } catch (e) {
        rejectInteractive(e as Error);
      }
    });
  };

  // Ink wants a raw-mode capable tty on both ends: the adapter is that tty.
  const stdin = Object.assign(new Readable({ read() {} }), {
    isTTY: true,
    isRaw: false,
    setRawMode(mode: boolean) {
      stdin.isRaw = mode;
      return stdin;
    },
    ref() {},
    unref() {},
  });
  const stdout = Object.assign(
    new Writable({
      write(chunk: Buffer | string, _encoding, callback) {
        terminal.write(typeof chunk === "string" ? chunk : new Uint8Array(chunk));
        markInteractive();
        callback();
      },
    }),
    {
      isTTY: true,
      get columns() {
        return terminal.cols;
      },
      get rows() {
        return terminal.rows;
      },
    },
  );

  let released = false;
  let unsubscribeData = () => {};
  let unsubscribeResize = () => {};
  const release = () => {
    if (released) return;
    released = true;
    try {
      unsubscribeData();
    } catch (e) {
      emit("terminal.cleanup_error", { source: "data", error: e });
    }
    try {
      unsubscribeResize();
    } catch (e) {
      emit("terminal.cleanup_error", { source: "resize", error: e });
    }
  };
  const interruptKey = options.interruptKey ?? "\x03";
  const write = (data: string | Uint8Array) => {
    if (interruptKey && typeof data === "string" && data.includes(interruptKey)) emit("terminal.interrupt");
    stdin.push(typeof data === "string" ? Buffer.from(data) : Buffer.from(data));
  };
  const resize = () => {
    emit("terminal.resize", { cols: terminal.cols, rows: terminal.rows });
    stdout.emit("resize");
  };

  emit("runtime.start", { surface: "terminal" });
  let abortExit: (code: number) => void = () => {};
  const aborted = new Promise<number>((resolve) => {
    abortExit = resolve;
  });
  const ran = runTui({
    cwd: options.workspace?.cwd ?? process.cwd(),
    env: { ...process.env, ...options.env },
    resume: global.resume,
    fullAccess: global.fullAccess,
    addDirs: global.addDirs,
    noAdditionalDirs: global.noAdditionalDirs,
    contextLimits: global.contextLimits,
    stdin,
    stdout,
    patchConsole: false,
    exec: options.workspace?.exec,
    openUrl: options.openUrl,
    sessionStore: options.sessionStore,
  });
  const exited = Promise.race([ran, aborted]).then(
    (code) => {
      release();
      if (!interactiveScheduled)
        rejectInteractive(new Error(`nod terminal exited with code ${code} before becoming interactive`));
      emit("runtime.exit", { surface: "terminal", code });
      return code;
    },
    (e: Error) => {
      release();
      if (!interactiveScheduled) rejectInteractive(e);
      emit("runtime.exit", { surface: "terminal", code: 1, error: e.message });
      throw e;
    },
  );
  emit("runtime.ready", { surface: "terminal" });
  try {
    unsubscribeData = terminal.onData(write);
    unsubscribeResize = terminal.onResize(resize);
  } catch (e) {
    release();
    stdin.push(null);
    abortExit(130);
    throw e;
  }
  return {
    interactive,
    exited,
    write,
    resize,
    abort() {
      release();
      stdin.push(null);
      abortExit(130);
    },
  };
}
