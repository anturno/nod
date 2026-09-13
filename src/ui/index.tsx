/** `runTui`: builds config, session and the terminal core, renders the Ink app in the alternate screen, exits with a code. */
import { render } from "ink";
import { VERSION } from "../cli/info.ts";
import { createRuntime } from "../cli/runtime.ts";
import { BUILD_VERSION } from "../cli/upgrade.ts";
import { loadConfig } from "../core/config/resolve.ts";
import { parseOverride } from "../core/context/limits.ts";
import { findLastSession } from "../core/session/catalog.ts";
import { createSession, openSession, type Session } from "../core/session/store.ts";
import { createAutoUpgrade } from "../core/upgrade/index.ts";
import { resolveAccess } from "../core/workspace/access.ts";
import { openBrowser } from "../providers/auth/oauth.ts";
import { subscriptions as realSubscriptions } from "../providers/providers.ts";
import { createClipboard } from "./clipboard.ts";
import { App } from "./components/App.tsx";
import { createTerminalCore, type TerminalCore, type TerminalDeps } from "./core/terminal.ts";
import { createNotifier, streamSink } from "./notify.ts";
import { applyTheme, detectTheme } from "./theme.ts";

export type RunTuiOptions = {
  cwd: string;
  env: Record<string, string | undefined>;
  resume?: { kind: "last" } | { kind: "id"; id: string } | { kind: "picker" };
  fullAccess?: boolean;
  addDirs?: string[];
  noAdditionalDirs?: boolean;
  contextLimits?: string[];
  stdin?: NodeJS.ReadableStream;
  stdout?: NodeJS.WritableStream;
  patchConsole?: boolean;
  exec?: (r: {
    command: string;
    cwd: string;
    signal?: AbortSignal;
  }) => Promise<{ output: string; exitCode: number | null }>;
  /** Test and SDK hooks: a fake subscription/runtime, a fixed clock, a canned file index. Additive to the contract. */
  hooks?: Partial<
    Pick<
      TerminalDeps,
      "makeRuntime" | "subscriptions" | "clock" | "fileIndex" | "clipboard" | "notify" | "openUrl" | "branch"
    >
  > & { onCore?: (core: TerminalCore) => void };
};

/** SGR mouse reports (wheel), bracketed paste, kitty disambiguated keys (shift+enter as CSI 13;2u). */
const TERMINAL_ON = "\x1b[?1000h\x1b[?1006h\x1b[?2004h\x1b[>1u";
const TERMINAL_OFF = "\x1b[<u\x1b[?2004l\x1b[?1000l\x1b[?1006l";

type Tty = NodeJS.ReadableStream & { isTTY?: boolean; setRawMode?: (on: boolean) => unknown };

/** Writes an OSC query and waits for the terminal's reply on stdin, or gives up after `timeoutMs`. */
function oscQuery(stdin: NodeJS.ReadableStream, stdout: NodeJS.WritableStream) {
  return (sequence: string, timeoutMs: number) =>
    new Promise<string | null>((resolve) => {
      let reply = "";
      const finish = (value: string | null) => {
        clearTimeout(timer);
        stdin.off("data", onData);
        resolve(value);
      };
      const onData = (chunk: Buffer | string) => {
        reply += chunk.toString();
        // biome-ignore lint/suspicious/noControlCharactersInRegex: matching the OSC 11 reply terminator
        if (/\x1b\]11;[^\x07\x1b]*(\x07|\x1b\\)/.test(reply)) finish(reply);
      };
      const timer = setTimeout(() => finish(null), timeoutMs);
      stdin.on("data", onData);
      stdout.write(sequence);
    });
}

export function gitBranch(cwd: string): string | null {
  const r = Bun.spawnSync(["git", "rev-parse", "--abbrev-ref", "HEAD"], { cwd, stdout: "pipe", stderr: "ignore" });
  return r.exitCode === 0 ? r.stdout.toString().trim() || null : null;
}

export async function runTui(options: RunTuiOptions): Promise<number> {
  const stdout = (options.stdout ?? process.stdout) as NodeJS.WriteStream;
  const stdin = (options.stdin ?? process.stdin) as Tty;
  const { cwd, env } = options;
  const config = loadConfig({
    workspaceRoot: cwd,
    env,
    cli: {
      permissionMode: options.fullAccess ? "yolo" : undefined,
      contextLimits: options.contextLimits?.map(parseOverride),
    },
  });
  const access = resolveAccess({ cwd }, config.additionalDirectories, {
    addDirs: options.addDirs,
    suppressSaved: options.noAdditionalDirs,
  });
  const deps = { home: config.home, cwd, now: Date.now };
  const fresh = () =>
    createSession(deps, {
      provider: config.provider,
      model: config.model ?? null,
      effort: config.effort,
      fast_mode: config.fastMode,
    });
  let session: Session;
  if (options.resume?.kind === "id") session = openSession(deps, options.resume.id, { rebindWorkspace: true });
  else if (options.resume?.kind === "last") {
    const last = findLastSession(deps, "workspace");
    session = last ? openSession(deps, last.id, { rebindWorkspace: true }) : fresh();
  } else session = fresh();

  const raw = stdin.isTTY === true && typeof stdin.setRawMode === "function";
  if (raw) stdin.setRawMode?.(true);
  const theme = await detectTheme({
    env,
    query: raw && stdout.isTTY ? oscQuery(stdin, stdout) : undefined,
  });
  applyTheme(theme);

  const subscriptions = options.hooks?.subscriptions ?? realSubscriptions;
  const hooks = options.hooks ?? {};
  let notifySettings = config.notifications;
  const core = createTerminalCore({
    cwd,
    env,
    config,
    access,
    session,
    subscriptions,
    version: VERSION,
    theme,
    clock: hooks.clock,
    openUrl: hooks.openUrl ?? ((url) => openBrowser(url)),
    notify: hooks.notify ?? createNotifier({ settings: () => notifySettings, env, sink: streamSink(stdout) }),
    clipboard: hooks.clipboard ?? createClipboard(),
    fileIndex: hooks.fileIndex,
    branch: hooks.branch === undefined ? gitBranch(cwd) : hooks.branch,
    upgrade: hooks.makeRuntime
      ? undefined
      : createAutoUpgrade({ fetch, config, now: Date.now, currentVersion: BUILD_VERSION }),
    resumePicker: options.resume?.kind === "picker",
    fullAccess: options.fullAccess,
    makeRuntime:
      hooks.makeRuntime ??
      ((o) =>
        createRuntime({
          config: { ...config, provider: o.provider, model: o.model, effort: o.effort, fastMode: o.fastMode },
          access,
          sessionId: o.sessionId,
          sessionDir: o.sessionDir,
          history: o.history,
          interactive: true,
          prompter: o.prompter,
          askUser: o.askUser,
          permissionMode: o.permissionMode,
        })),
  });
  hooks.onCore?.(core);
  const unsubscribe = core.store.subscribe(() => {
    notifySettings = core.store.get().settings.notifications;
  });

  stdout.write(TERMINAL_ON);
  const ink = render(<App core={core} subscriptions={subscriptions} now={hooks.clock ?? Date.now} />, {
    stdin: stdin as unknown as NodeJS.ReadStream,
    stdout,
    exitOnCtrlC: false,
    patchConsole: options.patchConsole ?? true,
    alternateScreen: options.stdout === undefined,
  });
  void core.start();
  let code = 0;
  try {
    const result = await ink.waitUntilExit();
    code = typeof result === "number" ? result : 0;
  } finally {
    unsubscribe();
    await core.stop();
    stdout.write(TERMINAL_OFF);
    if (raw) stdin.setRawMode?.(false);
  }
  if (core.store.get().settings.startupScrollback) stdout.write(`${core.plainTranscript()}\n`);
  if (core.store.get().relaunch) {
    // The binary on disk is already the new one; hand the session over to it.
    const child = Bun.spawn([process.execPath, "resume", core.session().id, "--upgrade-relaunch"], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    return await child.exited;
  }
  return code;
}
