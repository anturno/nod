/**
 * The headless interactive shell: owns the state, decodes keys, drives the agent loop, runs slash commands.
 * Ink (runTui) and the SDK's createTerminal only subscribe to the store and feed raw bytes.
 */
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { loadImages } from "../../cli/ask.ts";
import type { Runtime } from "../../cli/runtime.ts";
import { estimateMessagesTokens } from "../../core/agent/compaction.ts";
import { modelCapabilities } from "../../core/agent/config.ts";
import { projectHistory } from "../../core/agent/history.ts";
import type { AgentEvent, TurnOutcome } from "../../core/agent/loop.ts";
import { RECOVERY_PROMPTS } from "../../core/agent/recovery.ts";
import type {
  Effort,
  HistoryTurn,
  ImageRef,
  PermissionMode,
  Provider,
  Usage,
  UserTurn,
} from "../../core/agent/types.ts";
import type { ResolvedConfig } from "../../core/config/resolve.ts";
import { EFFORTS } from "../../core/config/settings-schema.ts";
import { writeUserPatch } from "../../core/config/settings-store.ts";
import {
  type ApprovalDecision,
  displayPermissionMode,
  formatPermissions,
  type Prompter,
  parsePermissionModeInput,
} from "../../core/permissions/index.ts";
import { listSessions, type SessionSummary } from "../../core/session/catalog.ts";
import { appendPromptHistory, loadPromptHistory } from "../../core/session/history.ts";
import { clearRecovery, interruptedTurn, readRecovery, writeRecovery } from "../../core/session/recovery.ts";
import {
  createSession,
  deleteSession,
  openSession,
  renameSession,
  type Session,
  saveTurn,
  updateManifest,
} from "../../core/session/store.ts";
import { generateTitle, shouldGenerateTitle } from "../../core/session/title.ts";
import type { Skill } from "../../core/skills/types.ts";
import type { AskUser } from "../../core/tools/spec.ts";
import { buildReport, renderUsage } from "../../core/usage/report.ts";
import { appendGeneration, loadUsage } from "../../core/usage/store.ts";
import type { AccessScope } from "../../core/workspace/access.ts";
import { runWorkspaceCommand, type WorkspaceAction } from "../../core/workspace/commands.ts";
import { renderWorkspace } from "../../core/workspace/render.ts";
import type { Subscription } from "../../providers/providers.ts";
import { applySound, soundLevel, soundPatch } from "../sound.ts";
import type { Activity } from "./activity.ts";
import {
  completeSlash,
  cycleTab,
  helpText,
  parseSlash,
  type SlashTab,
  slashRows,
  unknownCommandNotice,
} from "./commands.ts";
import {
  backslashNewline,
  createEditor,
  type Editor,
  expandForSubmit,
  isImagePath,
  reduceEditor,
  referencedImages,
} from "./composer.ts";
import { createGestures, ctrlCGesture, escapeGesture, type Gestures } from "./gestures.ts";
import { createHistoryNav, type HistoryNav, historyDown, historyRemember, historyReset, historyUp } from "./history.ts";
import { createKeyDecoder, ESC_ALONE_MS, type KeyAction } from "./keys.ts";
import {
  type ActiveQuery,
  activeQuery,
  buildFileIndex,
  type Dismissed,
  dismissQuery,
  matchPaths,
  PICKER_ROWS,
} from "./pickers.ts";
import { createStore, type Store } from "./store.ts";
import {
  type ApprovalState,
  createApproval,
  createQuestions,
  type Question,
  type QuestionState,
  reduceApproval,
  reduceQuestion,
} from "./surfaces.ts";
import {
  applyEvent,
  CANCELLED_NOTICE,
  cancelRunning,
  itemsFromHistory,
  type NoticeTone,
  pushItem,
  type TranscriptItem,
  transcriptLines,
} from "./transcript.ts";

export type ListRow = { value: string; label?: string; hint?: string; disabled?: boolean };
export type SettingsRow = { key: string; label: string; category: SettingsTab; value: string; values: string[] };
export type SettingsTab = "Interface" | "Agent" | "Notifications" | "Advanced" | null;
export const SETTINGS_TABS: SettingsTab[] = [null, "Interface", "Agent", "Notifications", "Advanced"];

export type ModelRow = { id: string; facts: string; disabled?: boolean };
export type Surface =
  | { kind: "approval"; state: ApprovalState }
  | { kind: "question"; state: QuestionState }
  | {
      kind: "model";
      step: "model" | "effort" | "fast";
      provider: Provider;
      rows: ModelRow[] | null;
      index: number;
      model?: string;
      effort?: string;
      options: string[];
      error?: string;
    }
  | { kind: "sessions"; scope: "workspace" | "all"; rows: SessionSummary[]; index: number; confirm: string | null }
  | { kind: "settings"; tab: SettingsTab; index: number; rows: SettingsRow[] }
  | { kind: "list"; title: string; rows: ListRow[]; index: number; onChoose: (value: string) => void }
  | { kind: "mcp" };

export type Screen = { kind: "review" | "full" | "diff"; scroll: number };
export type Menu = { index: number; tab: SlashTab; dismissed: Dismissed };

export type TerminalState = {
  items: TranscriptItem[];
  editor: Editor;
  menu: Menu;
  surface: Surface | null;
  screen: Screen | null;
  /** Transcript scroll offset in lines, from the bottom. */
  scroll: number;
  activity: Activity | null;
  /** Usage of the running turn. */
  turnUsage: Usage;
  pending: { text: string } | null;
  mode: PermissionMode;
  provider: Provider;
  model: string;
  effort: Effort;
  fast: boolean;
  cols: number;
  rows: number;
  theme: "dark" | "light";
  ctrlCArmed: boolean;
  /** Footer label from the update check; ctrl+g relaunches when an update is ready. */
  updateLabel: string | null;
  updateReady: boolean;
  /** Set when the user accepted the update: the host re-executes `nod resume <id>` after exit. */
  relaunch: boolean;
  status: { ctx: number | null; title: string | null; cwd: string; branch: string | null; sessionId: string };
  settings: Pick<
    ResolvedConfig,
    "slashMenuCategories" | "collapseToolCalls" | "statusLine" | "startupScrollback" | "notifications"
  >;
  version: string;
  exited: number | null;
  /** Images attached to the draft, by token id. */
  pendingImages: ImageRef[];
  skills: Skill[];
  /** The `@` picker's rows and the `$` picker's rows for the current query. */
  fileRows: string[];
  skillRows: Skill[];
  now: number;
};

export type MakeRuntimeOptions = {
  history: HistoryTurn[];
  sessionId: string;
  sessionDir: string;
  prompter: Prompter;
  askUser: AskUser;
  permissionMode: PermissionMode;
  provider: Provider;
  model: string | undefined;
  effort: Effort;
  fastMode: boolean;
  images?: ImageRef[];
};

export type TerminalDeps = {
  cwd: string;
  env: Record<string, string | undefined>;
  config: ResolvedConfig;
  access: AccessScope;
  session: Session;
  makeRuntime(o: MakeRuntimeOptions): Promise<Runtime>;
  subscriptions: Record<Provider, Subscription>;
  version: string;
  theme: "dark" | "light";
  clock?: () => number;
  openUrl?: (url: string) => void;
  notify?: { turnEnd(success: boolean): void; attention(): void };
  clipboard?: { copy(text: string): Promise<boolean>; pasteImage(dir: string): Promise<string | null> };
  fileIndex?: () => string[];
  branch?: string | null;
  resumePicker?: boolean;
  fullAccess?: boolean;
  /** Background update check (src/core/upgrade); absent when running from source or disabled. */
  upgrade?: { poll(): Promise<{ state: "ready" | "failed"; label: string } | undefined> };
};

export type TerminalCore = {
  store: Store<TerminalState>;
  feed(bytes: string): void;
  resize(cols: number, rows: number): void;
  start(): Promise<void>;
  stop(): Promise<void>;
  exited: Promise<number>;
  /** The transcript as plain text, for startup_scrollback. */
  plainTranscript(): string;
  /** The current session and runtime, for hosts that need them. */
  session(): Session;
};

const FEEDBACK_URL = "https://github.com/anturno/nod/issues";
/** Commands the menu leaves in the draft for their argument instead of running. */
const NEEDS_ARGS = new Set(["/rename", "/image"]);
export const FULL_ACCESS_HINT = "Full access enabled: nod permission checks disabled";
export const CTRL_C_HINT = "press ctrl+c again to exit";
const MAX_IMAGES = 8;

const tokenFact = (n: number) =>
  n >= 1_000_000 ? `${n / 1_000_000}M` : n >= 1000 ? `${Math.round(n / 1000)}K` : `${n}`;

export function modelFacts(provider: Provider, id: string): string {
  const caps = modelCapabilities(provider, id);
  const facts: string[] = [];
  if (caps.contextWindow) facts.push(`${tokenFact(caps.contextWindow)} context`);
  if (caps.maxOutputTokens) facts.push(`${tokenFact(caps.maxOutputTokens)} output`);
  if (caps.fastMode) facts.push("Fast");
  return facts.join(" · ");
}

export function settingsRows(
  s: TerminalState["settings"] & { sessionTitles?: boolean; promptHistory?: boolean },
): SettingsRow[] {
  const bool = (v: boolean) => (v ? "on" : "off");
  const onOff = ["on", "off"];
  return [
    {
      key: "slash_menu_categories",
      label: "Slash menu categories",
      category: "Interface",
      value: bool(s.slashMenuCategories),
      values: onOff,
    },
    {
      key: "collapse_tool_calls",
      label: "Collapse tool calls",
      category: "Interface",
      value: bool(s.collapseToolCalls),
      values: onOff,
    },
    {
      key: "startup_scrollback",
      label: "Startup scrollback",
      category: "Interface",
      value: bool(s.startupScrollback),
      values: onOff,
    },
    {
      key: "statusline_context",
      label: "Status line: context",
      category: "Interface",
      value: bool(s.statusLine.context),
      values: onOff,
    },
    {
      key: "statusline_session",
      label: "Status line: session",
      category: "Interface",
      value: bool(s.statusLine.session),
      values: onOff,
    },
    {
      key: "statusline_workspace",
      label: "Status line: workspace",
      category: "Interface",
      value: bool(s.statusLine.workspace),
      values: onOff,
    },
    {
      key: "session_titles",
      label: "Session titles",
      category: "Agent",
      value: bool(s.sessionTitles ?? true),
      values: onOff,
    },
    {
      key: "prompt_history",
      label: "Prompt history",
      category: "Agent",
      value: bool(s.promptHistory ?? true),
      values: onOff,
    },
    {
      key: "notification_turn_end",
      label: "Sound: turn end",
      category: "Notifications",
      value: bool(s.notifications.turnEnd),
      values: onOff,
    },
    {
      key: "notification_attention_required",
      label: "Sound: attention required",
      category: "Notifications",
      value: bool(s.notifications.attentionRequired),
      values: onOff,
    },
    {
      key: "notification_max",
      label: "Sound: max volume",
      category: "Notifications",
      value: bool(s.notifications.max),
      values: onOff,
    },
  ];
}

const SETTING_PATCH: Record<string, (value: string) => Record<string, unknown>> = {
  slash_menu_categories: (v) => ({ slash_menu_categories: v === "on" }),
  collapse_tool_calls: (v) => ({ collapse_tool_calls: v === "on" }),
  startup_scrollback: (v) => ({ startup_scrollback: v === "on" }),
  session_titles: (v) => ({ session_titles: v === "on" }),
  prompt_history: (v) => ({ prompt_history: { enabled: v === "on" } }),
};

export function createTerminalCore(deps: TerminalDeps): TerminalCore {
  const now = deps.clock ?? Date.now;
  const { config, cwd } = deps;
  let upgradeTimer: ReturnType<typeof setTimeout> | undefined;
  const sessionDeps = { home: config.home, cwd, now: () => Date.now() };
  let session = deps.session;
  let runtime: Runtime | null = null;
  let building: Promise<Runtime> | null = null;
  const decoder = createKeyDecoder();
  let escTimer: ReturnType<typeof setTimeout> | null = null;
  let ctrlCTimer: ReturnType<typeof setTimeout> | null = null;
  let gestures: Gestures = createGestures();
  let history: HistoryNav = createHistoryNav(
    loadPromptHistory({ home: config.home, enabled: config.promptHistory }, cwd, 500).reverse(),
  );
  let fileIndex: string[] | null = null;
  let approvalSeq = 0;
  const approvals = new Map<number, (d: ApprovalDecision) => void>();
  let questionResolve: ((a: { answers: { question: string; answer: string }[] } | null) => void) | null = null;
  let current: {
    controller: AbortController;
    prompt: UserTurn;
    startedAt: number;
    text: string;
    settled: Promise<void>;
  } | null = null;
  let lastRecovery: { prompt: UserTurn; recoveryPrompt?: string } | null = null;
  let turnCount = session.history.filter((t) => t.kind !== "compacted_summary").length;
  const undoStack: { path: string; before: string | null }[] = [];
  const grants: { permission: string; pattern: string }[] = [];
  let exitResolve: (code: number) => void = () => {};
  const exited = new Promise<number>((r) => (exitResolve = r));
  let settings = {
    provider: config.provider,
    model: config.model,
    effort: config.effort,
    fastMode: config.fastMode,
    sessionTitles: config.sessionTitles,
    promptHistory: config.promptHistory,
  };

  const store = createStore<TerminalState>({
    items: itemsFromHistory(session.history),
    editor: createEditor(),
    menu: { index: 0, tab: null, dismissed: null },
    surface: null,
    screen: null,
    scroll: 0,
    activity: null,
    turnUsage: {},
    pending: null,
    mode: deps.fullAccess ? "yolo" : config.permissionMode,
    provider: config.provider,
    model: config.model ?? "",
    effort: config.effort,
    fast: config.fastMode,
    cols: 80,
    rows: 24,
    theme: deps.theme,
    ctrlCArmed: false,
    updateLabel: null,
    updateReady: false,
    relaunch: false,
    status: {
      ctx: null,
      title: session.manifest.title,
      cwd,
      branch: deps.branch ?? null,
      sessionId: session.id,
    },
    settings: {
      slashMenuCategories: config.slashMenuCategories,
      collapseToolCalls: config.collapseToolCalls,
      statusLine: config.statusLine,
      startupScrollback: config.startupScrollback,
      notifications: config.notifications,
    },
    version: deps.version,
    exited: null,
    pendingImages: [],
    skills: [],
    fileRows: [],
    skillRows: [],
    now: now(),
  });
  const get = store.get;
  const patch = (p: Partial<TerminalState>) => store.update((s) => ({ ...s, ...p }));

  // ---- transcript helpers ----------------------------------------------------------------------

  const notice = (tone: NoticeTone, text: string, topic?: string) =>
    store.update((s) => ({ ...s, items: pushItem(s.items, { type: "notice", tone, text, topic }) }));
  const block = (text: string) =>
    store.update((s) => ({ ...s, items: pushItem(s.items, { type: "text", text, streaming: false }) }));
  const busy = () => current !== null;

  // ---- runtime ---------------------------------------------------------------------------------

  const prompter: Prompter = (request, signal) =>
    new Promise<ApprovalDecision>((resolve) => {
      if (signal?.aborted) return resolve({ outcome: "deny" });
      const id = ++approvalSeq;
      const finish = (d: ApprovalDecision) => {
        if (!approvals.has(id)) return;
        approvals.delete(id);
        store.update((s) => ({
          ...s,
          surface: s.surface?.kind === "approval" && s.surface.state.id === id ? null : s.surface,
          screen: s.screen?.kind === "diff" ? null : s.screen,
        }));
        resolve(d);
      };
      approvals.set(id, finish);
      signal?.addEventListener("abort", () => finish({ outcome: "deny" }), { once: true });
      const state = createApproval(id, request);
      const diffLines = request.preparation?.diff ? diffText(request.preparation.diff).split("\n").length : 0;
      const fits = diffLines <= Math.max(4, get().rows - 12);
      patch({ surface: { kind: "approval", state }, screen: fits ? null : { kind: "diff", scroll: 0 } });
      deps.notify?.attention();
    });

  const askUser: AskUser = (questions, signal) =>
    new Promise((resolve) => {
      if (signal?.aborted) return resolve(null);
      questionResolve = (answer) => {
        questionResolve = null;
        store.update((s) => ({
          ...s,
          surface: s.surface?.kind === "question" ? null : s.surface,
          activity: s.activity ? { ...s.activity, phase: "tool" } : null,
        }));
        resolve(answer);
      };
      signal?.addEventListener("abort", () => questionResolve?.(null), { once: true });
      patch({
        surface: { kind: "question", state: createQuestions(questions as Question[]) },
        activity: get().activity ? { ...(get().activity as Activity), phase: "asking" } : null,
      });
      deps.notify?.attention();
    });

  async function rebuildRuntime(historyOverride?: HistoryTurn[]): Promise<Runtime> {
    const build = deps.makeRuntime({
      history: historyOverride ?? session.history,
      sessionId: session.id,
      sessionDir: session.dir,
      prompter,
      askUser,
      permissionMode: get().mode,
      provider: settings.provider,
      model: settings.model,
      effort: settings.effort,
      fastMode: settings.fastMode,
    });
    building = build;
    try {
      const built = await build;
      built.policy.grants.push(...grants);
      built.toolContext.onFileMutation = (path, before) => undoStack.push({ path, before });
      runtime = built;
      settings = { ...settings, provider: built.provider, model: built.model };
      patch({
        provider: built.provider,
        model: built.model,
        effort: settings.effort,
        fast: settings.fastMode,
        skills: built.toolContext.skills?.list() ?? [],
      });
      return built;
    } finally {
      if (building === build) building = null;
    }
  }

  async function ensureRuntime(): Promise<Runtime> {
    if (runtime) return runtime;
    if (building) return building;
    return rebuildRuntime();
  }

  // ---- turns -----------------------------------------------------------------------------------

  function contextPercent(rt: Runtime): number | null {
    const window = modelCapabilities(rt.provider, rt.model).contextWindow;
    if (!window) return null;
    const tokens = estimateMessagesTokens(projectHistory(rt.state.history), rt.state.calibration ?? 0.25);
    return Math.min(100, Math.round((tokens / window) * 100));
  }

  async function runTurn(prompt: UserTurn, opts: { recoveryPrompt?: string } = {}) {
    let rt: Runtime;
    try {
      rt = await ensureRuntime();
    } catch (e) {
      notice("error", (e as Error).message);
      return;
    }
    const controller = new AbortController();
    const startedAt = now();
    let settle: () => void = () => {};
    const settled = new Promise<void>((r) => (settle = r));
    current = { controller, prompt, startedAt, text: prompt.text, settled };
    turnCount++;
    const turn = turnCount;
    if (opts.recoveryPrompt) rt.state.steering.push(opts.recoveryPrompt);
    store.update((s) => ({
      ...s,
      items: pushItem(s.items, { type: "user", text: prompt.text, images: prompt.images?.length || undefined }),
      activity: { phase: "thinking", startedAt },
      turnUsage: {},
      scroll: 0,
    }));
    const wantTitle = shouldGenerateTitle(session.manifest, { sessionTitles: settings.sessionTitles });
    const before = { ...rt.state.usage };
    let outcome: TurnOutcome | null = null;
    let steps = 0;
    try {
      const gen = rt.loop.run(prompt, controller.signal);
      for (;;) {
        const next = await gen.next();
        if (next.done) {
          outcome = next.value;
          break;
        }
        const ev: AgentEvent = next.value;
        store.update((s) => ({ ...s, items: applyEvent(s.items, ev), activity: nextActivity(s.activity, ev, now()) }));
        if (ev.type === "step") {
          steps = ev.step;
          patch({ turnUsage: delta(rt.state.usage, before) });
        }
      }
    } catch (e) {
      notice("error", (e as Error).message);
    }
    const usage = { ...delta(rt.state.usage, before), requestCount: steps };
    const elapsedMs = now() - startedAt;
    current = null;
    settle();
    if (outcome) {
      try {
        saveTurn(session, outcome.turn, usage);
      } catch (e) {
        notice("error", `session: ${(e as Error).message}`);
      }
      if (outcome.kind === "paused" || outcome.kind === "failed") {
        lastRecovery = {
          prompt,
          recoveryPrompt: outcome.kind === "paused" ? outcome.recoveryPrompt : RECOVERY_PROMPTS.continue_response,
        };
        writeRecovery(session.dir, {
          version: 2,
          disposition: "continuable",
          turn_id: session.history.length,
          user: prompt,
          assistant_source: "",
          cause: outcome.kind === "failed" ? outcome.error : outcome.reason,
          action: outcome.kind === "paused" ? "pause" : "stop",
          tool_state: "none",
          fast_mode: settings.fastMode,
          max_provider_attempts: 10,
          consumed_provider_attempts: rt.state.attempts,
        });
        notice("error", outcome.kind === "failed" ? outcome.error : `paused: ${outcome.reason} · /continue to resume`);
      } else {
        lastRecovery = null;
        clearRecovery(session.dir);
      }
      if (steps > 0)
        appendGeneration(
          { home: config.home, now: Date.now },
          {
            id: `${session.id}-${session.history.length}`,
            created_at_ms: Date.now(),
            model: rt.model,
            input_tokens: usage.inputTokens ?? 0,
            output_tokens: usage.outputTokens ?? 0,
            cache_read_tokens: usage.cacheReadTokens ?? 0,
            cache_write_tokens: 0,
            reasoning_tokens: usage.reasoningTokens ?? 0,
            billable_web_search_calls: 0,
            total_cost: 0,
          },
        );
    }
    const cancelled = outcome?.kind === "interrupted" || controller.signal.aborted;
    store.update((s) => {
      let items = cancelled ? cancelRunning(s.items) : s.items;
      if (
        cancelled &&
        !items.some(
          (i) =>
            i.type === "notice" &&
            i.text === CANCELLED_NOTICE &&
            i.id > (items.findLast((x) => x.type === "user")?.id ?? 0),
        )
      )
        items = pushItem(items, { type: "notice", tone: "warning", text: CANCELLED_NOTICE });
      items = pushItem(items, { type: "done", turn, elapsedMs, usage, outcome: outcome?.kind ?? "failed" });
      return {
        ...s,
        items,
        activity: null,
        status: { ...s.status, ctx: contextPercent(rt), title: session.manifest.title ?? s.status.title },
      };
    });
    deps.notify?.turnEnd(outcome?.kind === "completed");
    if (wantTitle && outcome && outcome.kind !== "interrupted") {
      void generateTitle(rt.llm.llm(rt.model), prompt.text).then((title) => {
        if (!title || session.manifest.title_generated) return;
        updateManifest(session, { title, title_generated: true });
        store.update((s) => ({ ...s, status: { ...s.status, title } }));
      });
    }
    const pending = get().pending;
    if (pending) {
      const unconsumed = rt.state.steering.indexOf(pending.text);
      if (unconsumed >= 0) rt.state.steering.splice(unconsumed, 1);
      patch({ pending: null });
      if (unconsumed >= 0) {
        store.update((s) => ({ ...s, items: s.items.filter((i) => !(i.type === "user" && i.queued)) }));
        void runTurn({ text: pending.text });
      }
    }
  }

  function nextActivity(a: Activity | null, ev: AgentEvent, at: number): Activity | null {
    if (!a) return a;
    if (ev.type === "tool_started")
      return { phase: "tool", label: toolActivityLabel(ev.label, ev.call.name), startedAt: at };
    if (ev.type === "tool_finished" || ev.type === "step")
      return { phase: "thinking", startedAt: a.phase === "thinking" ? a.startedAt : at };
    if (ev.type === "compaction") return { phase: "thinking", startedAt: at };
    return a;
  }

  function cancelTurn() {
    if (!current) return;
    for (const finish of [...approvals.values()]) finish({ outcome: "deny" });
    questionResolve?.(null);
    current.controller.abort();
    if (get().pending) withdrawPending();
  }

  function withdrawPending() {
    const pending = get().pending;
    if (!pending) return;
    if (runtime) {
      const i = runtime.state.steering.indexOf(pending.text);
      if (i >= 0) runtime.state.steering.splice(i, 1);
    }
    store.update((s) => ({
      ...s,
      pending: null,
      items: s.items.filter((i) => !(i.type === "user" && i.queued)),
      editor: reduceEditor(s.editor, { type: "set_text", text: pending.text }),
    }));
  }

  // ---- submit ----------------------------------------------------------------------------------

  function submit() {
    const s = get();
    const editor = s.editor;
    const text = expandForSubmit(editor).trim();
    const imageIds = referencedImages(editor);
    const images = s.pendingImages.filter((i) => imageIds.includes(i.id));
    if (!text && images.length === 0) return;
    const remember = editor.text.trim();
    if (remember) {
      history = historyRemember(history, remember);
      appendPromptHistory({ home: config.home, now: Date.now, enabled: settings.promptHistory }, cwd, remember);
    }
    const parsed = parseSlash(text);
    if (parsed.kind !== "prompt") {
      patch({ editor: reduceEditor(editor, { type: "clear" }), menu: { index: 0, tab: s.menu.tab, dismissed: null } });
      if (parsed.kind === "unknown")
        return parsed.token === "/models"
          ? void runSlash("/model", "")
          : notice("warning", unknownCommandNotice(parsed.token));
      return void runSlash(parsed.spec.command, parsed.rest);
    }
    const promptText = text || images.map((i) => `[Image #${i.id}]`).join("\n");
    patch({
      editor: reduceEditor(editor, { type: "clear" }),
      pendingImages: s.pendingImages.filter((i) => !imageIds.includes(i.id)),
      menu: { index: 0, tab: s.menu.tab, dismissed: null },
    });
    if (busy()) {
      if (runtime) {
        const old = get().pending;
        if (old) {
          const i = runtime.state.steering.indexOf(old.text);
          if (i >= 0) runtime.state.steering.splice(i, 1);
        }
        runtime.state.steering.push(promptText);
      }
      store.update((st) => ({
        ...st,
        pending: { text: promptText },
        items: pushItem(
          st.items.filter((i) => !(i.type === "user" && i.queued)),
          { type: "user", text: promptText, queued: true },
        ),
      }));
      return;
    }
    void runTurn({ text: promptText, images: images.length ? images : undefined });
  }

  // ---- slash commands --------------------------------------------------------------------------

  const usage = (help: string) => notice("error", `usage: ${help}`, "session");

  async function runSlash(command: string, rest: string) {
    const args = rest.split(/\s+/).filter(Boolean);
    switch (command) {
      case "/help":
        return block(helpText());
      case "/clear":
      case "/new":
      case "/reset":
        return newSession(command === "/reset");
      case "/resume":
        return openSessions("workspace");
      case "/continue": {
        if (busy()) return notice("warning", "a turn is still running");
        const pending = lastRecovery ?? recoveryFromDisk();
        if (!pending) return notice("info", "nothing to continue");
        lastRecovery = null;
        return void runTurn(pending.prompt, { recoveryPrompt: pending.recoveryPrompt });
      }
      case "/rename":
        if (!rest) return usage("/rename <title>");
        renameSession(session, rest);
        store.update((s) => ({ ...s, status: { ...s.status, title: rest } }));
        return notice("success", `renamed to ${rest}`, "session");
      case "/login":
        return login(args[0]);
      case "/logout": {
        const p = (args[0] ?? settings.provider) as Provider;
        const sub = deps.subscriptions[p];
        if (!sub) return notice("error", `Unknown provider "${args[0]}". Use codex or grok.`);
        return notice("info", await sub.logout());
      }
      case "/provider":
        if (!args[0]) return providerPicker();
        return setProvider(args[0]);
      case "/stats": {
        const u = session.manifest.usage;
        return block(
          [
            "Session statistics",
            `session   ${session.id}`,
            `turns     ${session.history.filter((t) => t.kind !== "compacted_summary").length}`,
            `model     ${get().provider}/${get().model}`,
            `requests  ${u.request_count}`,
            `tokens    ↑${u.input_tokens} ↓${u.output_tokens} · cache ${u.cache_read_tokens} · reasoning ${u.reasoning_tokens}`,
          ].join("\n"),
        );
      }
      case "/usage":
        return block(renderUsage(buildReport(loadUsage(config.home), "30d", Date.now()), "text").trimEnd());
      case "/status": {
        const s = get();
        const sub = deps.subscriptions[s.provider];
        return block(
          [
            `model            ${s.model}`,
            `provider         ${sub?.label ?? s.provider} (${sub?.signedIn() ? "signed in" : "not signed in"})`,
            `effort           ${s.effort}${s.fast ? " · fast" : ""}`,
            `permission mode  ${displayPermissionMode(s.mode)}`,
            `workspace        ${cwd}`,
            `session          ${session.id}${s.status.title ? ` · ${s.status.title}` : ""}`,
            `history turns    ${session.history.filter((t) => t.kind !== "compacted_summary").length}`,
            `session grants   ${grants.length}`,
            `version          ${deps.version}`,
          ].join("\n"),
        );
      }
      case "/image":
        if (!rest) return usage("/image <path>");
        return attachImage(rest);
      case "/images":
        if (args[0] === "clear") {
          patch({ pendingImages: [] });
          return notice("info", "pending images cleared");
        }
        return notice(
          "info",
          get().pendingImages.length
            ? get()
                .pendingImages.map((i) => `[Image #${i.id}] ${i.path ?? i.mime}`)
                .join("\n")
            : "no pending images",
        );
      case "/model":
        if (rest) return chooseModel(rest);
        return openModels();
      case "/permissions":
        return permissions(rest);
      case "/allowlist":
        return allowlist(args);
      case "/undo":
        return undo();
      case "/mcp":
        return patch({ surface: { kind: "mcp" } });
      case "/skills": {
        const skills = get().skills;
        return block(
          skills.length
            ? skills.map((s) => `$${s.name}  ${s.description} (${s.source})`).join("\n")
            : "no skills installed · /skills install <source>",
        );
      }
      case "/copy": {
        const last = get().items.findLast((i) => i.type === "text");
        if (last?.type !== "text") return notice("info", "nothing to copy");
        const ok = await (deps.clipboard?.copy(last.text) ?? Promise.resolve(false));
        return notice(ok ? "success" : "error", ok ? "copied the latest response" : "clipboard unavailable");
      }
      case "/feedback":
        deps.openUrl?.(FEEDBACK_URL);
        return notice("info", `report a problem: ${FEEDBACK_URL}`);
      case "/compact":
        return compact();
      case "/settings":
        if (args[0] === "startup-scrollback") return setStartupScrollback(args[1]);
        return patch({
          surface: { kind: "settings", tab: null, index: 0, rows: settingsRows({ ...get().settings, ...settings }) },
        });
      case "/paste": {
        const dir = join(config.home, "images");
        const path = await (deps.clipboard?.pasteImage(dir) ?? Promise.resolve(null));
        if (!path) return notice("error", "no image on the clipboard");
        return attachImage(path);
      }
      case "/fast": {
        const caps = modelCapabilities(get().provider, get().model);
        if (!caps.fastMode) return notice("warning", `${get().model} does not support fast mode`);
        settings = { ...settings, fastMode: !settings.fastMode };
        writeUserPatch(config.home, { fast_mode: settings.fastMode });
        patch({ fast: settings.fastMode });
        notice("success", `fast mode ${settings.fastMode ? "on" : "off"}`);
        return scheduleRebuild();
      }
      case "/statusline":
        if (args[0]) return toggleStatusline(args[0]);
        return patch({
          surface: {
            kind: "list",
            title: "Status line",
            rows: (["context", "session", "workspace"] as const).map((k) => ({
              value: k,
              hint: get().settings.statusLine[k] ? "on" : "off",
            })),
            index: 0,
            onChoose: (v) => toggleStatusline(v),
          },
        });
      case "/sound":
        return sound(args[0]);
      case "/workspace":
        return workspace(args);
      case "/version":
        return notice("info", `nod ${deps.version}`);
      case "/quit":
        return exit(0);
    }
  }

  function recoveryFromDisk() {
    const r = readRecovery(session.dir);
    return r ? { prompt: r.user, recoveryPrompt: RECOVERY_PROMPTS.continue_response } : null;
  }

  async function newSession(stopShells: boolean) {
    if (busy()) return notice("warning", "finish or cancel the turn first");
    const old = session;
    const oldRuntime = runtime;
    session = createSession(sessionDeps, {
      provider: settings.provider,
      model: settings.model ?? null,
      effort: settings.effort,
      fast_mode: settings.fastMode,
    });
    old.close();
    if (old.history.length === 0 && !old.manifest.has_checkpoint) deleteSession(sessionDeps, old.id);
    turnCount = 0;
    undoStack.length = 0;
    runtime = null;
    if (stopShells) await oldRuntime?.close();
    store.update((s) => ({
      ...s,
      items: [],
      scroll: 0,
      status: { ...s.status, title: null, ctx: null, sessionId: session.id },
    }));
    notice("info", stopShells ? "fresh session; background processes stopped" : "fresh session");
    void rebuildRuntime();
  }

  function openSessions(scope: "workspace" | "all") {
    const rows = listSessions(sessionDeps, { scope, limit: 100 }).sessions.filter((r) => r.id !== session.id);
    patch({ surface: { kind: "sessions", scope, rows, index: 0, confirm: null } });
  }

  async function resumeSession(id: string) {
    if (busy()) return notice("warning", "finish or cancel the turn first");
    let next: Session;
    try {
      next = openSession(sessionDeps, id, { rebindWorkspace: true });
    } catch (e) {
      return notice("error", (e as Error).message, "session");
    }
    const old = session;
    session = next;
    old.close();
    if (old.history.length === 0 && !old.manifest.has_checkpoint) deleteSession(sessionDeps, old.id);
    const pending = readRecovery(session.dir);
    if (pending) {
      saveTurn(session, interruptedTurn(pending) as unknown as HistoryTurn);
      clearRecovery(session.dir);
    }
    turnCount = session.history.filter((t) => t.kind !== "compacted_summary").length;
    runtime = null;
    store.update((s) => ({
      ...s,
      surface: null,
      items: itemsFromHistory(session.history),
      scroll: 0,
      status: { ...s.status, title: session.manifest.title, sessionId: session.id, ctx: null },
    }));
    notice("success", `resumed ${session.manifest.title ?? session.id}`, "session");
    void rebuildRuntime();
  }

  async function login(name?: string) {
    if (!name) return providerPicker();
    const sub = deps.subscriptions[name as Provider];
    if (!sub) return notice("error", `Unknown provider "${name}". Use codex or grok.`);
    try {
      await sub.login({ print: (line) => notice("info", line) });
      notice("success", `Signed in with ${sub.label}.`);
    } catch (e) {
      notice("error", (e as Error).message);
    }
  }

  function providerPicker() {
    const rows: ListRow[] = (Object.keys(deps.subscriptions) as Provider[]).map((p) => ({
      value: p,
      label: deps.subscriptions[p].label,
      hint: deps.subscriptions[p].signedIn() ? "signed in" : `not signed in · /login ${p}`,
    }));
    patch({ surface: { kind: "list", title: "Providers", rows, index: 0, onChoose: (v) => void setProvider(v) } });
  }

  async function setProvider(name: string) {
    const sub = deps.subscriptions[name as Provider];
    if (!sub) return notice("error", `Unknown provider "${name}". Use codex or grok.`);
    if (!sub.signedIn()) return login(name);
    settings = { ...settings, provider: name as Provider, model: undefined };
    writeUserPatch(config.home, { provider: name });
    notice("success", `Default provider set to ${sub.label} (${name}).`);
    return scheduleRebuild();
  }

  function scheduleRebuild() {
    if (busy()) return notice("info", "the change applies after this turn");
    return rebuildRuntime().then(
      () => undefined,
      (e) => notice("error", (e as Error).message),
    );
  }

  function attachImage(path: string) {
    const s = get();
    if (s.pendingImages.length >= MAX_IMAGES) return notice("error", `at most ${MAX_IMAGES} images per prompt`);
    try {
      const id = (s.pendingImages.at(-1)?.id ?? 0) + 1;
      const [image] = loadImages([path], cwd);
      if (!image) return;
      const ref = { ...image, id };
      store.update((st) => ({
        ...st,
        pendingImages: [...st.pendingImages, ref],
        editor: reduceEditor(st.editor, { type: "add_image", id }),
      }));
    } catch (e) {
      notice("error", (e as Error).message);
    }
  }

  async function openModels() {
    const provider = settings.provider;
    patch({ surface: { kind: "model", step: "model", provider, rows: null, index: 0, options: [] } });
    await loadModelRows(provider);
  }

  async function loadModelRows(provider: Provider) {
    const sub = deps.subscriptions[provider];
    let rows: ModelRow[];
    let error: string | undefined;
    if (!sub.signedIn()) {
      rows = [];
      error = `not signed in · /login ${provider}`;
    } else {
      try {
        rows = (await sub.models()).map((id) => ({ id, facts: modelFacts(provider, id) }));
      } catch (e) {
        rows = [];
        error = (e as Error).message;
      }
    }
    store.update((s) =>
      s.surface?.kind === "model" && s.surface.provider === provider && s.surface.step === "model"
        ? {
            ...s,
            surface: {
              ...s.surface,
              rows,
              error,
              index: Math.max(
                0,
                rows.findIndex((r) => r.id === s.model),
              ),
            },
          }
        : s,
    );
  }

  async function chooseModel(query: string) {
    const [id, effort, fast] = query.split(/\s+/);
    const sub = deps.subscriptions[settings.provider];
    let listed: string[] = [];
    try {
      listed = await sub.models();
    } catch {
      listed = [];
    }
    const model = listed.includes(id as string) ? (id as string) : listed.find((m) => m.includes(id as string));
    if (!model) return notice("error", `no model matches ${id}`);
    return applyModel(
      settings.provider,
      model,
      effort as Effort | undefined,
      fast === undefined ? undefined : fast === "fast" || fast === "on",
    );
  }

  function applyModel(provider: Provider, model: string, effort?: Effort, fast?: boolean) {
    settings = {
      ...settings,
      provider,
      model,
      effort: effort ?? settings.effort,
      fastMode: fast ?? settings.fastMode,
    };
    writeUserPatch(config.home, {
      provider,
      models: { [provider]: model },
      effort: settings.effort,
      fast_mode: settings.fastMode,
    });
    patch({ surface: null, provider, model, effort: settings.effort, fast: settings.fastMode });
    notice("success", `model ${provider}/${model}${effort ? ` · ${effort}` : ""}${settings.fastMode ? " · fast" : ""}`);
    return scheduleRebuild();
  }

  function permissions(rest: string) {
    if (!rest)
      return block(
        formatPermissions(
          { mode: get().mode, rules: runtime?.policy.rules ?? [], grants, workspaceRoot: cwd },
          displayPermissionMode,
        ).trimEnd(),
      );
    if (rest.trim() === "reset") return setMode(config.permissionMode);
    const mode = parsePermissionModeInput(rest);
    if (!mode) return usage("/permissions [ask|auto|full-access|reset]");
    return setMode(mode);
  }

  function setMode(mode: PermissionMode) {
    if (runtime) runtime.policy.mode = mode;
    patch({ mode });
    notice("info", `permission mode: ${displayPermissionMode(mode)}`);
    if (!busy()) void rebuildRuntime().catch((e) => notice("error", (e as Error).message));
  }

  function allowlist(args: string[]) {
    const rules = runtime?.policy.rules ?? [];
    const [scope, verb] = args[0] === "local" || args[0] === "user" ? [args[0], args[1]] : ["user", args[0]];
    if (!verb || verb === "view") {
      const filter = args[1] && args[1] !== "effective" ? args[1] : scope === "local" ? "workspace" : undefined;
      const shown = filter && verb === "view" ? rules.filter((r) => r.source === filter) : rules;
      return block(
        shown.length
          ? shown.map((r) => `${r.action} ${r.permission} -> ${r.pattern} (${r.source ?? "user"})`).join("\n")
          : "no permission rules configured",
      );
    }
    return notice(
      "info",
      'edit persistent rules in ~/.nod/settings.json under "permission"; /allowlist view shows the effective rules',
    );
  }

  function undo() {
    const last = undoStack.pop();
    if (!last) return notice("info", "nothing to undo");
    try {
      if (last.before === null) rmSync(last.path, { force: true });
      else {
        mkdirSync(dirname(last.path), { recursive: true });
        writeFileSync(last.path, last.before);
      }
      notice("success", `restored ${last.path}`);
    } catch (e) {
      notice("error", `undo failed: ${(e as Error).message}`);
    }
  }

  async function compact() {
    if (busy()) return notice("warning", "finish or cancel the turn first");
    const rt = await ensureRuntime();
    patch({ activity: { phase: "compacting", startedAt: now() } });
    try {
      const result = await rt.loop.compactNow();
      if (!result) notice("info", "nothing to compact");
      else {
        const summary = rt.state.history[0];
        if (summary?.kind === "compacted_summary") saveTurn(session, summary);
        notice("success", `compacted ${result.removedTurns} turns`);
      }
    } catch (e) {
      notice("error", `compaction failed: ${(e as Error).message}`);
    } finally {
      store.update((s) => ({ ...s, activity: null, status: { ...s.status, ctx: contextPercent(rt) } }));
    }
  }

  function setStartupScrollback(value?: string) {
    const next = value === undefined ? !get().settings.startupScrollback : value === "on";
    if (value !== undefined && value !== "on" && value !== "off")
      return usage("/settings [startup-scrollback [on|off]]");
    writeUserPatch(config.home, { startup_scrollback: next });
    store.update((s) => ({ ...s, settings: { ...s.settings, startupScrollback: next } }));
    return notice("info", `startup scrollback ${next ? "on" : "off"}`);
  }

  function toggleStatusline(field: string) {
    if (field !== "context" && field !== "session" && field !== "workspace")
      return usage("/statusline [context|session|workspace]");
    const next = { ...get().settings.statusLine, [field]: !get().settings.statusLine[field] };
    writeUserPatch(config.home, {
      statusLine: { context: next.context, session: next.session, workspace: next.workspace },
    });
    store.update((s) => ({
      ...s,
      settings: { ...s.settings, statusLine: next },
      surface: s.surface?.kind === "list" ? null : s.surface,
    }));
    return notice("info", `status line ${field} ${next[field] ? "on" : "off"}`);
  }

  function sound(arg?: string) {
    const next = applySound(get().settings.notifications, arg);
    if (!next) return usage("/sound [on|off|max]");
    writeUserPatch(config.home, soundPatch(next));
    store.update((s) => ({ ...s, settings: { ...s.settings, notifications: next } }));
    return notice("info", `sounds ${soundLevel(next)}`);
  }

  function workspace(args: string[]) {
    const [verb, path] = args;
    let action: WorkspaceAction;
    if (!verb || verb === "list") action = { kind: "list" };
    else if (verb === "clear") action = { kind: "clear" };
    else if ((verb === "add" || verb === "remove") && path) action = { kind: verb, path };
    else return usage("/workspace [list|add PATH|remove PATH|clear]");
    try {
      const result = runWorkspaceCommand({ home: config.home }, action, deps.access);
      deps.access.entries.splice(0, deps.access.entries.length, ...result.scope.entries);
      return block(renderWorkspace({ ...result.snapshot, mutation: result.mutation }, "text").trimEnd());
    } catch (e) {
      return notice("error", (e as Error).message);
    }
  }

  function applySetting(row: SettingsRow, value: string) {
    const settingPatch = SETTING_PATCH[row.key]?.(value);
    if (row.key.startsWith("statusline_")) return toggleStatusline(row.key.slice("statusline_".length));
    if (row.key.startsWith("notification_")) {
      const n = { ...get().settings.notifications };
      if (row.key === "notification_turn_end") n.turnEnd = value === "on";
      if (row.key === "notification_attention_required") n.attentionRequired = value === "on";
      if (row.key === "notification_max") n.max = value === "on";
      writeUserPatch(config.home, {
        notifications: { turn_end: n.turnEnd, attention_required: n.attentionRequired, max: n.max },
      });
      return store.update((s) => ({ ...s, settings: { ...s.settings, notifications: n } }));
    }
    if (!settingPatch) return;
    writeUserPatch(config.home, settingPatch);
    const on = value === "on";
    if (row.key === "session_titles") settings = { ...settings, sessionTitles: on };
    if (row.key === "prompt_history") settings = { ...settings, promptHistory: on };
    store.update((s) => ({
      ...s,
      settings: {
        ...s.settings,
        ...(row.key === "slash_menu_categories" ? { slashMenuCategories: on } : {}),
        ...(row.key === "collapse_tool_calls" ? { collapseToolCalls: on } : {}),
        ...(row.key === "startup_scrollback" ? { startupScrollback: on } : {}),
      },
    }));
  }

  // ---- exit ------------------------------------------------------------------------------------

  let stopping = false;
  async function exit(code: number) {
    if (stopping) return;
    stopping = true;
    cancelTurn();
    patch({ exited: code });
    exitResolve(code);
  }

  // ---- keys ------------------------------------------------------------------------------------

  function feedAction(a: KeyAction) {
    const s = get();
    if (s.exited !== null) return;
    if (a.type === "ctrl_c") return ctrlC();
    if (a.type === "wheel") return wheel(a.direction);
    if (s.screen && s.screen.kind !== "diff") return screenKey(a);
    if (a.type === "ctrl_o")
      return patch({ screen: { kind: "review", scroll: 0 }, menu: { ...s.menu, dismissed: null } });
    if (a.type === "toggle_permission_mode") return togglePermissionMode();
    if (a.type === "ctrl_g") {
      if (!s.updateReady) return notice("info", "no update ready");
      if (current || s.surface) return notice("warning", "finish the current turn before reloading");
      patch({ relaunch: true });
      return void exit(0);
    }
    if (a.type === "ctrl_l") return patch({ scroll: 0 });
    if (s.surface?.kind === "approval") return approvalKey(s.surface.state, a);
    if (s.surface?.kind === "question") return questionKey(s.surface.state, a);
    if (s.surface?.kind === "model") return modelKey(s.surface, a);
    if (s.surface?.kind === "sessions") return sessionsKey(s.surface, a);
    if (s.surface?.kind === "settings") return settingsKey(s.surface, a);
    if (s.surface?.kind === "list") return listKey(s.surface, a);
    if (s.surface?.kind === "mcp") {
      if (a.type === "escape" || a.type === "submit") patch({ surface: null });
      return;
    }
    const query = activeQuery(s.editor, s.menu.dismissed);
    if (query && menuKey(query, a)) return;
    composerKey(a);
  }

  function ctrlC() {
    const s = get();
    if (
      s.surface?.kind === "model" ||
      s.surface?.kind === "sessions" ||
      s.surface?.kind === "settings" ||
      s.surface?.kind === "list" ||
      s.surface?.kind === "mcp"
    )
      return patch({ surface: null });
    if (s.screen && s.screen.kind !== "diff") return patch({ screen: null });
    if (busy() && s.editor.text.length > 0) return patch({ editor: reduceEditor(s.editor, { type: "clear" }) });
    const g = ctrlCGesture(gestures, now());
    gestures = g.gestures;
    if (g.exit) return void exit(130);
    if (busy()) cancelTurn();
    patch({ ctrlCArmed: true });
    if (ctrlCTimer) clearTimeout(ctrlCTimer);
    ctrlCTimer = setTimeout(() => patch({ ctrlCArmed: false }), 3000);
  }

  function wheel(direction: "up" | "down") {
    const s = get();
    if (s.screen)
      return patch({ screen: { ...s.screen, scroll: Math.max(0, s.screen.scroll + (direction === "up" ? -3 : 3)) } });
    patch({ scroll: Math.max(0, s.scroll + (direction === "up" ? 3 : -3)) });
  }

  function screenKey(a: KeyAction) {
    const s = get();
    const screen = s.screen as Screen;
    const lines = transcriptLines(s.items, screen.kind === "full" ? "full" : "review").length;
    const page = Math.max(1, s.rows - 3);
    const max = Math.max(0, lines - page);
    const set = (scroll: number) => patch({ screen: { ...screen, scroll: Math.max(0, Math.min(max, scroll)) } });
    if (a.type === "escape" || a.type === "ctrl_o") return patch({ screen: null });
    if (a.type === "move") {
      if (a.kind === "left" || a.kind === "right")
        return patch({ screen: { kind: screen.kind === "review" ? "full" : "review", scroll: 0 } });
      if (a.kind === "up") return set(screen.scroll - 3);
      if (a.kind === "down") return set(screen.scroll + 3);
      if (a.kind === "page_up") return set(screen.scroll - page);
      if (a.kind === "page_down") return set(screen.scroll + page);
      if (a.kind === "line_start") return set(0);
      if (a.kind === "line_end") return set(max);
    }
  }

  function togglePermissionMode() {
    const order: PermissionMode[] = ["ask", "auto", "yolo"];
    const next = order[(order.indexOf(get().mode) + 1) % order.length] as PermissionMode;
    setMode(next);
  }

  function approvalKey(state: ApprovalState, a: KeyAction) {
    const screen = get().screen;
    if (screen?.kind === "diff" && a.type === "move" && (a.kind === "page_up" || a.kind === "page_down")) {
      const page = Math.max(1, get().rows - 8);
      return patch({
        screen: { ...screen, scroll: Math.max(0, screen.scroll + (a.kind === "page_up" ? -page : page)) },
      });
    }
    const step = reduceApproval(state, a);
    if (step.done) {
      const finish = approvals.get(state.id);
      if (step.done === "cancel") {
        finish?.({ outcome: "deny" });
        cancelTurn();
        return;
      }
      finish?.(step.done);
      return;
    }
    patch({ surface: { kind: "approval", state: step.state } });
  }

  function questionKey(state: QuestionState, a: KeyAction) {
    const step = reduceQuestion(state, a);
    if (step.done === "cancel") return questionResolve?.(null);
    if (step.done) {
      const answers = state.questions.map((q, i) => ({
        question: q.question,
        answer: (step.done as { answers: string[] }).answers[i] ?? "",
      }));
      return questionResolve?.({ answers });
    }
    patch({ surface: { kind: "question", state: step.state } });
  }

  function modelKey(surface: Extract<Surface, { kind: "model" }>, a: KeyAction) {
    const rows = surface.step === "model" ? (surface.rows ?? []).map((r) => r.id) : surface.options;
    const setIndex = (index: number) =>
      patch({ surface: { ...surface, index: Math.max(0, Math.min(rows.length - 1, index)) } });
    const mirror = (s: Extract<Surface, { kind: "model" }>) =>
      reduceEditor(get().editor, {
        type: "set_text",
        text: `/model ${[s.model, s.effort].filter(Boolean).join(" ")}`.trimEnd(),
      });
    switch (a.type) {
      case "escape":
        if (surface.step === "model")
          return patch({ surface: null, editor: reduceEditor(get().editor, { type: "clear" }) });
        if (surface.step === "effort") {
          const back = { ...surface, step: "model" as const, rows: null, index: 0, model: undefined };
          patch({ surface: back, editor: mirror(back) });
          return void loadModelRows(surface.provider);
        }
        return patch({
          surface: {
            ...surface,
            step: "effort",
            options: efforts(surface.provider, surface.model as string),
            index: 0,
            effort: undefined,
          },
        });
      case "tab":
      case "move":
        if (a.type === "move" && a.kind === "up") return setIndex(surface.index - 1);
        if (a.type === "move" && a.kind === "down") return setIndex(surface.index + 1);
        if (surface.step === "model" && (a.type === "tab" || a.kind === "left" || a.kind === "right")) {
          const providers = Object.keys(deps.subscriptions) as Provider[];
          const i = providers.indexOf(surface.provider);
          const provider = providers[
            (i + (a.type === "move" && a.kind === "left" ? -1 : 1) + providers.length) % providers.length
          ] as Provider;
          patch({ surface: { ...surface, provider, rows: null, index: 0 } });
          return void loadModelRows(provider);
        }
        return;
      case "submit": {
        if (surface.step === "model") {
          const row = surface.rows?.[surface.index];
          if (!row || row.disabled) return;
          const options = efforts(surface.provider, row.id);
          const next = { ...surface, model: row.id };
          if (options.length === 0)
            return finishModel({ ...next, options: fastOptions(surface.provider, row.id), step: "fast" });
          const chosen = {
            ...next,
            step: "effort" as const,
            options,
            index: Math.max(0, options.indexOf(settings.effort)),
          };
          return patch({ surface: chosen, editor: mirror(chosen) });
        }
        if (surface.step === "effort") {
          const effort = surface.options[surface.index] as string;
          const next = {
            ...surface,
            effort,
            options: fastOptions(surface.provider, surface.model as string),
            step: "fast" as const,
            index: 0,
          };
          return finishModel(next);
        }
        const fast = surface.options[surface.index] === "fast";
        return applyModel(surface.provider, surface.model as string, surface.effort as Effort | undefined, fast);
      }
      default:
        if (a.type === "insert" && /^[1-9]$/.test(a.text)) return setIndex(Number(a.text) - 1);
    }
  }

  function finishModel(next: Extract<Surface, { kind: "model" }>) {
    if (next.options.length === 0)
      return applyModel(next.provider, next.model as string, next.effort as Effort | undefined, false);
    patch({
      surface: next,
      editor: reduceEditor(get().editor, {
        type: "set_text",
        text: `/model ${[next.model, next.effort].filter(Boolean).join(" ")}`,
      }),
    });
  }

  const efforts = (provider: Provider, model: string) =>
    (modelCapabilities(provider, model).efforts ?? []).filter((e) => EFFORTS.includes(e));
  const fastOptions = (provider: Provider, model: string) =>
    modelCapabilities(provider, model).fastMode ? ["fast", "normal"] : [];

  function sessionsKey(surface: Extract<Surface, { kind: "sessions" }>, a: KeyAction) {
    if (surface.confirm) {
      if (a.type === "submit" || (a.type === "insert" && (a.text === "1" || a.text === "y"))) {
        try {
          deleteSession(sessionDeps, surface.confirm);
          notice("success", `deleted ${surface.confirm}`, "session");
        } catch (e) {
          notice("error", (e as Error).message, "session");
        }
        const rows = surface.rows.filter((r) => r.id !== surface.confirm);
        return patch({
          surface: { ...surface, rows, confirm: null, index: Math.min(surface.index, Math.max(0, rows.length - 1)) },
        });
      }
      if (a.type === "escape" || (a.type === "insert" && (a.text === "2" || a.text === "n")))
        return patch({ surface: { ...surface, confirm: null } });
      return;
    }
    if (a.type === "escape") return patch({ surface: null });
    if (a.type === "tab") return openSessions(surface.scope === "all" ? "workspace" : "all");
    if (a.type === "move" && a.kind === "up")
      return patch({ surface: { ...surface, index: Math.max(0, surface.index - 1) } });
    if (a.type === "move" && a.kind === "down")
      return patch({ surface: { ...surface, index: Math.min(surface.rows.length - 1, surface.index + 1) } });
    const row = surface.rows[surface.index];
    if (!row) return;
    if (a.type === "submit") return void resumeSession(row.id);
    if (a.type === "insert" && a.text === "d") return patch({ surface: { ...surface, confirm: row.id } });
  }

  function settingsKey(surface: Extract<Surface, { kind: "settings" }>, a: KeyAction) {
    const visible = surface.rows.filter((r) => !surface.tab || r.category === surface.tab);
    const row = visible[surface.index];
    const refresh = (p: Partial<Extract<Surface, { kind: "settings" }>>) =>
      patch({ surface: { ...surface, ...p, rows: settingsRows({ ...get().settings, ...settings }) } });
    if (a.type === "escape") return patch({ surface: null });
    if (a.type === "tab")
      return refresh({
        tab: SETTINGS_TABS[(SETTINGS_TABS.indexOf(surface.tab) + 1) % SETTINGS_TABS.length] as SettingsTab,
        index: 0,
      });
    if (a.type === "move" && a.kind === "up") return refresh({ index: Math.max(0, surface.index - 1) });
    if (a.type === "move" && a.kind === "down")
      return refresh({ index: Math.min(visible.length - 1, surface.index + 1) });
    if (!row) return;
    if (a.type === "submit" || (a.type === "move" && (a.kind === "left" || a.kind === "right"))) {
      const i = row.values.indexOf(row.value);
      const by = a.type === "move" && a.kind === "left" ? -1 : 1;
      applySetting(row, row.values[(i + by + row.values.length) % row.values.length] as string);
      return refresh({});
    }
  }

  function listKey(surface: Extract<Surface, { kind: "list" }>, a: KeyAction) {
    if (a.type === "escape") return patch({ surface: null });
    if (a.type === "move" && a.kind === "up")
      return patch({ surface: { ...surface, index: Math.max(0, surface.index - 1) } });
    if (a.type === "move" && a.kind === "down")
      return patch({ surface: { ...surface, index: Math.min(surface.rows.length - 1, surface.index + 1) } });
    const row = surface.rows[surface.index];
    if (a.type === "submit" && row && !row.disabled) {
      patch({ surface: null });
      surface.onChoose(row.value);
    }
  }

  /** True when the picker consumed the key. */
  function menuKey(query: ActiveQuery, a: KeyAction): boolean {
    const s = get();
    const rows =
      query.kind === "slash"
        ? slashRows(query.prefix, s.settings.slashMenuCategories ? s.menu.tab : null).map((r) => r.command)
        : query.kind === "file"
          ? s.fileRows
          : s.skillRows.map((k) => k.name);
    const index = Math.min(s.menu.index, Math.max(0, rows.length - 1));
    const setMenu = (p: Partial<Menu>) => patch({ menu: { ...s.menu, ...p } });
    switch (a.type) {
      case "escape":
        setMenu({ dismissed: dismissQuery(query), index: 0 });
        return true;
      case "move":
        if (a.kind === "up") return setMenu({ index: Math.max(0, index - 1) }), true;
        if (a.kind === "down") return setMenu({ index: Math.min(rows.length - 1, index + 1) }), true;
        if (query.kind === "slash" && s.settings.slashMenuCategories && (a.kind === "left" || a.kind === "right")) {
          setMenu({ tab: cycleTab(s.menu.tab, a.kind === "left" ? -1 : 1), index: 0 });
          return true;
        }
        return false;
      case "tab": {
        if (query.kind === "slash") {
          const completed = completeSlash(query.prefix);
          if (completed) {
            patch({
              editor: reduceEditor(s.editor, { type: "set_text", text: completed }),
              menu: { ...s.menu, index: 0 },
            });
            return true;
          }
          if (s.settings.slashMenuCategories) setMenu({ tab: cycleTab(s.menu.tab, 1), index: 0 });
          return true;
        }
        const row = rows[index];
        if (row) insertPick(query, row);
        return true;
      }
      case "submit": {
        const row = rows[index];
        if (!row) return false;
        if (query.kind === "slash") {
          const spec = slashRows(query.prefix, s.settings.slashMenuCategories ? s.menu.tab : null)[index];
          if (!spec) return false;
          const typed = s.editor.text.slice(query.prefix.length).trim();
          if (NEEDS_ARGS.has(spec.command) && !typed) {
            patch({
              editor: reduceEditor(s.editor, { type: "set_text", text: `${spec.command} ` }),
              menu: { ...s.menu, index: 0 },
            });
            return true;
          }
          patch({ editor: reduceEditor(s.editor, { type: "set_text", text: `${spec.command} ${typed}`.trimEnd() }) });
          submit();
          return true;
        }
        insertPick(query, row);
        return true;
      }
      default:
        return false;
    }
  }

  function insertPick(query: ActiveQuery, value: string) {
    const s = get();
    if (query.kind === "file")
      return patch({
        editor: reduceEditor(s.editor, {
          type: "replace_range",
          start: query.tokenStart,
          end: s.editor.cursor,
          text: `${value} `,
        }),
        menu: { ...s.menu, index: 0 },
      });
    if (query.kind === "skill") {
      const skill = s.skills.find((k) => k.name === value);
      if (!skill) return;
      return patch({
        editor: reduceEditor(s.editor, {
          type: "add_skill",
          token: { name: skill.name, location: skill.location },
          tokenStart: query.tokenStart,
        }),
        menu: { ...s.menu, index: 0 },
      });
    }
  }

  function composerKey(a: KeyAction) {
    const s = get();
    const e = s.editor;
    const setEditor = (next: Editor) => {
      const { notice: rejected, ...editor } = next;
      if (rejected) notice("error", rejected);
      const query = activeQuery(editor, s.menu.dismissed);
      const previous = activeQuery(e, null);
      const sameSlash = query?.kind === "slash" && previous?.kind === "slash" && query.prefix === previous.prefix;
      patch({
        editor,
        menu: { ...s.menu, index: sameSlash ? s.menu.index : 0 },
        fileRows: query?.kind === "file" ? matchPaths(fileIndexNow(), query.query, PICKER_ROWS) : [],
        skillRows: query?.kind === "skill" ? matchSkills(s.skills, query.query) : [],
      });
      if (a.type !== "move") history = historyReset(history);
    };
    switch (a.type) {
      case "insert":
        return setEditor(reduceEditor(e, { type: "insert", text: a.text }));
      case "paste": {
        if (isImagePath(a.text) && existsSync(a.text.trim())) return attachImage(a.text.trim());
        return setEditor(reduceEditor(e, { type: "paste", text: a.text }));
      }
      case "insert_newline":
        return setEditor(reduceEditor(e, { type: "insert_newline" }));
      case "submit": {
        const continued = backslashNewline(e);
        if (continued) return setEditor(continued);
        return submit();
      }
      case "delete":
        return setEditor(reduceEditor(e, { type: "delete", kind: a.kind }));
      case "yank":
        return setEditor(reduceEditor(e, { type: "yank" }));
      case "undo":
        return setEditor(reduceEditor(e, { type: "undo" }));
      case "history_next": {
        const r = historyDown(history, e);
        if (r) (history = r.nav), setEditor(r.editor);
        return;
      }
      case "move": {
        if (a.kind === "up") {
          const r = historyUp(history, e);
          if (r) return (history = r.nav), setEditor(r.editor);
        }
        if (a.kind === "down") {
          const r = historyDown(history, e);
          if (r) return (history = r.nav), setEditor(r.editor);
        }
        if (a.kind === "page_up" || a.kind === "page_down") {
          const page = Math.max(1, s.rows - 6);
          return patch({ scroll: Math.max(0, s.scroll + (a.kind === "page_up" ? page : -page)) });
        }
        return setEditor(reduceEditor(e, { type: "move", kind: a.kind }));
      }
      case "escape": {
        if (busy()) {
          cancelTurn();
          return;
        }
        if (s.pending) return withdrawPending();
        const g = escapeGesture(gestures, now());
        gestures = g.gestures;
        if (g.double && e.text.length > 0) return setEditor(reduceEditor(e, { type: "clear" }));
        return;
      }
      case "tab":
        return;
      default:
        return;
    }
  }

  const fileIndexNow = () => (fileIndex ??= deps.fileIndex ? deps.fileIndex() : buildFileIndex(cwd));
  const matchSkills = (skills: Skill[], query: string) =>
    skills
      .filter(
        (k) =>
          !query ||
          k.name.toLowerCase().includes(query.toLowerCase()) ||
          k.description.toLowerCase().includes(query.toLowerCase()),
      )
      .slice(0, PICKER_ROWS);

  // ---- public ----------------------------------------------------------------------------------

  return {
    store,
    session: () => session,
    feed(bytes) {
      if (escTimer) {
        clearTimeout(escTimer);
        escTimer = null;
      }
      for (const a of decoder.feed(bytes)) feedAction(a);
      if (decoder.pendingEscape())
        escTimer = setTimeout(() => {
          escTimer = null;
          for (const a of decoder.flush()) feedAction(a);
        }, ESC_ALONE_MS);
    },
    resize(cols, rows) {
      patch({ cols, rows });
    },
    async start() {
      const pending = readRecovery(session.dir);
      if (pending) {
        lastRecovery = { prompt: pending.user, recoveryPrompt: RECOVERY_PROMPTS.continue_response };
        notice("info", "a paused response is waiting · /continue resumes it");
      }
      if (get().mode === "yolo") notice("warning", FULL_ACCESS_HINT);
      if (deps.resumePicker) openSessions("workspace");
      if (deps.upgrade) {
        const poll = async () => {
          const status = await deps.upgrade?.poll().catch(() => undefined);
          if (status) patch({ updateLabel: status.label, updateReady: status.state === "ready" });
        };
        // Waits 10 s before the first check, then keeps polling; the checker itself rate-limits to 30 min.
        upgradeTimer = setTimeout(() => {
          void poll();
          upgradeTimer = setInterval(() => void poll(), 60_000);
        }, 10_000);
      }
      try {
        await rebuildRuntime();
      } catch (e) {
        notice("error", (e as Error).message);
      }
    },
    async stop() {
      const running = current;
      cancelTurn();
      if (upgradeTimer) clearTimeout(upgradeTimer);
      if (ctrlCTimer) clearTimeout(ctrlCTimer);
      if (escTimer) clearTimeout(escTimer);
      // The loop writes the interrupted turn itself; a provider that ignores the abort gets one second.
      if (running) await Promise.race([running.settled, new Promise((r) => setTimeout(r, 1000))]);
      try {
        await runtime?.close();
      } catch {
        // shells may already be gone
      }
      session.close();
      if (session.history.length === 0 && !session.manifest.has_checkpoint) {
        try {
          deleteSession(sessionDeps, session.id);
        } catch {
          // already gone
        }
      }
    },
    exited,
    plainTranscript: () => transcriptLines(get().items, "review").join("\n"),
  };
}

const delta = (after: Usage, before: Usage): Usage => ({
  inputTokens: (after.inputTokens ?? 0) - (before.inputTokens ?? 0),
  outputTokens: (after.outputTokens ?? 0) - (before.outputTokens ?? 0),
  cacheReadTokens: (after.cacheReadTokens ?? 0) - (before.cacheReadTokens ?? 0),
  reasoningTokens: (after.reasoningTokens ?? 0) - (before.reasoningTokens ?? 0),
});

/** "shell.run bun test" → "Running bun test", "read_file x" → "Reading x". */
export function toolActivityLabel(label: string, name: string): string {
  const verbs: Record<string, string> = {
    shell: "Running",
    read_file: "Reading",
    edit_file: "Editing",
    write_file: "Writing",
    glob_files: "Searching",
    grep_files: "Searching",
    web_fetch: "Fetching",
    web_search: "Searching",
    skill: "Loading skill",
  };
  const verb = verbs[name] ?? "Running";
  const target = label.replace(/^\S+\s*/, "");
  return `${verb} ${target || name}`.trim();
}

/** A unified-ish diff for the approval panel: removed lines with -, added with +. */
export function diffText(diff: { path: string; before: string | null; after: string }): string {
  const a = diff.before === null ? [] : diff.before.split("\n");
  const b = diff.after.split("\n");
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const lines = [`${diff.before === null ? "create" : "edit"} ${diff.path}`];
  const context = a.slice(Math.max(0, prefix - 2), prefix);
  lines.push(...context.map((l) => `  ${l}`));
  lines.push(...a.slice(prefix, a.length - suffix).map((l) => `- ${l}`));
  lines.push(...b.slice(prefix, b.length - suffix).map((l) => `+ ${l}`));
  lines.push(...a.slice(a.length - suffix, a.length - suffix + 2).map((l) => `  ${l}`));
  return lines.join("\n");
}
