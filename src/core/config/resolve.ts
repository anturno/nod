/** Precedence: default → .nod.json → settings.json → settings.workspaces[primary] → env → cli, with the source of every field. */

import { subscriptions } from "../../providers/providers.ts";
import type { Effort, PermissionMode, Provider } from "../agent/types.ts";
import { type LimitOverride, type ResolvedLimits, resolveLimits } from "../context/limits.ts";
import {
  MIN_TOOL_RESULT_BYTES,
  parsePermissionMode,
  type Settings,
  type ToolChoice,
  type UpdateChannel,
} from "./settings-schema.ts";
import { loadMergedSettings, type MergedSettings, nodHome, normalizeWorkspaceRoot } from "./settings-store.ts";

export type Source = "default" | "project" | "user" | "workspace" | "env" | "cli";
export type Env = Record<string, string | undefined>;
export type CliOverrides = { permissionMode?: PermissionMode; model?: string; contextLimits?: LimitOverride[] };

export type ResolvedConfig = {
  provider: Provider;
  /** Undefined when neither settings nor NOD_MODEL name one and the provider has no compiled default. */
  model: string | undefined;
  effort: Effort;
  fastMode: boolean;
  permissionMode: PermissionMode;
  /** 0 = unlimited. */
  maxAgentSteps: number;
  maxToolResultBytes: number;
  context: boolean;
  contextLimits: ResolvedLimits;
  firstCallToolChoice: ToolChoice;
  slashMenuCategories: boolean;
  collapseToolCalls: boolean;
  sessionTitles: boolean;
  autoUpgrade: boolean;
  updateChannel: UpdateChannel;
  startupScrollback: boolean;
  promptHistory: boolean;
  statusLine: { context: boolean; session: boolean; workspace: boolean };
  notifications: { turnEnd: boolean; attentionRequired: boolean; max: boolean };
  credentialSource: string | undefined;
  yoloAcknowledged: boolean;
  permissionRules: { user: unknown; workspace: unknown };
  /** Saved for this workspace in settings.json; the workspace module resolves them against the filesystem. */
  additionalDirectories: string[];
  theme: string | undefined;
  openBrowser: boolean;
  workspaceRoot: string;
  home: string;
  sources: Record<string, Source>;
  diagnostics: string[];
};

export const DEFAULT_PERMISSION_MODE: PermissionMode = "auto";
export const DEFAULT_MAX_TOOL_RESULT_BYTES = 64 * 1024;
const NOTIFICATIONS_DEFAULT = process.platform === "darwin";

const trimmed = (value: string | undefined) => {
  const t = value?.trim();
  return t ? t : undefined;
};
const envFalse = (value: string | undefined) => value !== undefined && /^(0|false)$/i.test(value.trim());

export function resolveConfig(
  merged: MergedSettings,
  env: Env,
  cli: CliOverrides,
  paths: { home: string; workspaceRoot: string },
): ResolvedConfig {
  const sources: Record<string, Source> = {};
  const layers: [Source, Settings][] = [
    ["project", merged.project],
    ["user", merged.user],
    ["workspace", merged.workspace],
  ];
  /** The highest layer that sets `key`, else the default; records the source under `name`. */
  const pick = <K extends keyof Settings>(name: string, key: K, fallback: NonNullable<Settings[K]>) => {
    let value: NonNullable<Settings[K]> = fallback;
    sources[name] = "default";
    for (const [source, settings] of layers) {
      const candidate = settings[key];
      if (candidate !== undefined) (value = candidate as NonNullable<Settings[K]>), (sources[name] = source);
    }
    return value;
  };
  const override = <T>(name: string, value: T | undefined, source: Source, current: T) => {
    if (value === undefined) return current;
    sources[name] = source;
    return value;
  };

  const provider = pick("provider", "provider", "codex");

  // The model is per provider, so its source is the highest layer that names one for the chosen provider.
  let model: string | undefined = subscriptions[provider].defaultModel;
  sources.model = "default";
  for (const [source, settings] of layers) {
    const candidate = settings.models?.[provider];
    if (candidate !== undefined) (model = candidate), (sources.model = source);
  }
  model = override("model", trimmed(env.NOD_MODEL), "env", model);
  model = override("model", trimmed(cli.model), "cli", model);

  let permissionMode = pick("permissionMode", "permission_mode", DEFAULT_PERMISSION_MODE);
  const envMode = env.NOD_PERMISSION_MODE === undefined ? undefined : parsePermissionMode(env.NOD_PERMISSION_MODE);
  permissionMode = override("permissionMode", envMode, "env", permissionMode);
  permissionMode = override("permissionMode", cli.permissionMode, "cli", permissionMode);

  let maxAgentSteps = pick("maxAgentSteps", "max_agent_steps", 0);
  const envSteps = trimmed(env.NOD_MAX_AGENT_STEPS);
  if (envSteps !== undefined && /^\d+$/.test(envSteps))
    maxAgentSteps = override("maxAgentSteps", Number(envSteps), "env", maxAgentSteps);

  let autoUpgrade = pick("autoUpgrade", "auto_upgrade", true);
  if (envFalse(env.NOD_AUTO_UPGRADE)) autoUpgrade = override("autoUpgrade", false, "env", autoUpgrade);

  const notifications = {
    turnEnd: pick("notifications.turnEnd", "notification_turn_end", NOTIFICATIONS_DEFAULT),
    attentionRequired: pick(
      "notifications.attentionRequired",
      "notification_attention_required",
      NOTIFICATIONS_DEFAULT,
    ),
    max: pick("notifications.max", "notification_max", false),
  };
  const sound = trimmed(env.NOD_SOUND)?.toLowerCase();
  if (sound !== undefined) {
    const on = !/^(0|false|off)$/.test(sound);
    notifications.turnEnd = override("notifications.turnEnd", on, "env", notifications.turnEnd);
    notifications.attentionRequired = override(
      "notifications.attentionRequired",
      on,
      "env",
      notifications.attentionRequired,
    );
    if (sound === "max") notifications.max = override("notifications.max", true, "env", notifications.max);
  }

  const theme = trimmed(env.NOD_THEME);
  if (theme !== undefined) sources.theme = "env";
  const openBrowser = env.NOD_NO_OPEN_BROWSER === undefined;
  if (!openBrowser) sources.openBrowser = "env";

  const contextLimits = resolveLimits(merged.user.context_limits, merged.workspace.context_limits, cli.contextLimits);

  return {
    provider,
    model,
    effort: pick("effort", "effort", "auto"),
    fastMode: pick("fastMode", "fast_mode", false),
    permissionMode,
    maxAgentSteps,
    maxToolResultBytes: Math.max(
      MIN_TOOL_RESULT_BYTES,
      pick("maxToolResultBytes", "max_tool_result_bytes", DEFAULT_MAX_TOOL_RESULT_BYTES),
    ),
    context: pick("context", "context", true),
    contextLimits,
    firstCallToolChoice: pick("firstCallToolChoice", "first_call_tool_choice", "auto"),
    slashMenuCategories: pick("slashMenuCategories", "slash_menu_categories", true),
    collapseToolCalls: pick("collapseToolCalls", "collapse_tool_calls", true),
    sessionTitles: pick("sessionTitles", "session_titles", true),
    autoUpgrade,
    updateChannel: pick("updateChannel", "update_channel", "stable"),
    startupScrollback: pick("startupScrollback", "startup_scrollback", false),
    promptHistory: pick("promptHistory", "prompt_history_enabled", true),
    statusLine: {
      context: pick("statusLine.context", "statusline_context", true),
      session: pick("statusLine.session", "statusline_session", true),
      workspace: pick("statusLine.workspace", "statusline_workspace", true),
    },
    notifications,
    credentialSource: merged.workspace.credential_source ?? merged.user.credential_source,
    yoloAcknowledged: pick("yoloAcknowledged", "yolo_acknowledged", false),
    permissionRules: { user: merged.user.permission, workspace: merged.workspace.permission },
    additionalDirectories: merged.workspace.additional_directories ?? [],
    theme,
    openBrowser,
    workspaceRoot: normalizeWorkspaceRoot(paths.workspaceRoot),
    home: paths.home,
    sources,
    diagnostics: merged.diagnostics,
  };
}

/** Disk + env + cli in one call. */
export function loadConfig({
  workspaceRoot,
  env = process.env,
  cli = {},
  home = nodHome(env),
}: {
  workspaceRoot: string;
  env?: Env;
  cli?: CliOverrides;
  home?: string;
}): ResolvedConfig {
  return resolveConfig(loadMergedSettings({ home, workspaceRoot }), env, cli, { home, workspaceRoot });
}
