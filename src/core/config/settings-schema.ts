/** settings.json / .nod.json shapes: one layer parsed at a time, unknown keys ignored, known keys strictly typed. */
import type { Effort, PermissionMode, Provider } from "../agent/types.ts";
import { type LimitOverrides, parseLimitsObject } from "../context/limits.ts";

export const MAX_SETTINGS_BYTES = 64 * 1024;
export const MAX_ADDITIONAL_DIRECTORIES = 16;
export const MIN_TOOL_RESULT_BYTES = 1024;

export type Layer = "project" | "user" | "workspace";
export type UpdateChannel = "stable" | "dev";
export type ToolChoice = "auto" | "none";

/** Everything a layer may set. Absent means "not set here". */
export type Settings = {
  provider?: Provider;
  models?: Partial<Record<Provider, string>>;
  permission_mode?: PermissionMode;
  credential_source?: string;
  yolo_acknowledged?: boolean;
  max_agent_steps?: number;
  max_tool_result_bytes?: number;
  context?: boolean;
  context_limits?: LimitOverrides;
  first_call_tool_choice?: ToolChoice;
  fast_mode?: boolean;
  effort?: Effort;
  slash_menu_categories?: boolean;
  collapse_tool_calls?: boolean;
  session_titles?: boolean;
  auto_upgrade?: boolean;
  update_channel?: UpdateChannel;
  startup_scrollback?: boolean;
  prompt_history_enabled?: boolean;
  statusline_context?: boolean;
  statusline_session?: boolean;
  statusline_workspace?: boolean;
  notification_turn_end?: boolean;
  notification_attention_required?: boolean;
  notification_max?: boolean;
  /** Permission rules, raw; the permissions module owns the shape. */
  permission?: unknown;
  /** Workspace layer only. */
  additional_directories?: string[];
  mcp_trust?: unknown;
  enabled_servers?: unknown;
  disabled_servers?: unknown;
};

/** The three keys .nod.json may set; anything else in it is reported and ignored. */
export const PROJECT_KEYS = ["max_agent_steps", "max_tool_result_bytes", "context"] as const;
const USER_ONLY_KEYS = new Set([
  "model",
  "models",
  "provider",
  "codex_model",
  "grok_model",
  "effort",
  "fast_mode",
  "fast_mode_model_bound",
  "slash_menu_categories",
  "collapse_tool_calls",
  "session_titles",
  "startup_scrollback",
  "prompt_history",
  "statusLine",
  "notifications",
  "context_limits",
  "skill_match_fuzzy",
  "first_call_tool_choice",
  "auto_upgrade",
  "update_channel",
  "permission_mode",
  "credential_source",
  "yolo_acknowledged",
  "permission",
  "additional_directories",
]);

export const PROVIDERS: Provider[] = ["codex", "grok"];
export const EFFORTS: Effort[] = ["auto", "none", "minimal", "low", "medium", "high", "xhigh", "max"];

/** A known key with the wrong type invalidates its whole layer. */
export class SettingsError extends Error {}

/** Accepts "full-access", "full access" and "yolo" for the same mode; case-insensitive. */
export function parsePermissionMode(raw: string): PermissionMode | undefined {
  const value = raw.trim().toLowerCase();
  if (value === "ask" || value === "auto") return value;
  if (value === "yolo" || value === "full-access" || value === "full access") return "yolo";
  return undefined;
}

/** Disk always spells full access as "yolo". */
export const serializePermissionMode = (mode: PermissionMode): string => mode;

export const parseEffort = (raw: string): Effort | undefined => {
  const value = raw.trim().toLowerCase();
  if (value === "adaptive" || value === "default") return "auto";
  return EFFORTS.find((e) => e === value);
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Model ids: non-empty, trimmed, no control characters. */
export function validModel(model: unknown): model is string {
  return (
    typeof model === "string" &&
    model.length > 0 &&
    model.length <= 256 &&
    model === model.trim() &&
    !Array.from(model).some((c) => c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f)
  );
}

function readBool(root: Record<string, unknown>, key: string): boolean | undefined {
  const value = root[key];
  if (value === undefined) return undefined;
  if (typeof value !== "boolean") throw new SettingsError(`"${key}" must be a boolean`);
  return value;
}

function readEnum<T extends string>(root: Record<string, unknown>, key: string, parse: (raw: string) => T | undefined) {
  const value = root[key];
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new SettingsError(`"${key}" must be a string`);
  const parsed = parse(value);
  if (parsed === undefined) throw new SettingsError(`"${key}" has an unsupported value: ${value}`);
  return parsed;
}

function readModels(root: Record<string, unknown>): Partial<Record<Provider, string>> | undefined {
  const models: Partial<Record<Provider, string>> = {};
  for (const provider of PROVIDERS) {
    const legacy = root[`${provider}_model`];
    if (legacy !== undefined) {
      if (!validModel(legacy)) throw new SettingsError(`"${provider}_model" must be a model id`);
      models[provider] = legacy;
    }
  }
  const nested = root.models;
  if (nested !== undefined) {
    if (!isObject(nested)) throw new SettingsError('"models" must be an object');
    for (const provider of PROVIDERS) {
      const value = nested[provider];
      if (value === undefined) continue;
      if (!validModel(value)) throw new SettingsError(`"models.${provider}" must be a model id`);
      models[provider] = value;
    }
  }
  return Object.keys(models).length ? models : undefined;
}

function readAdditionalDirectories(value: unknown): string[] {
  const bad = () =>
    new SettingsError(
      `additional_directories must be an array of at most ${MAX_ADDITIONAL_DIRECTORIES} unique absolute directory paths for the current primary workspace`,
    );
  if (!Array.isArray(value) || value.length > MAX_ADDITIONAL_DIRECTORIES) throw bad();
  const seen = new Set<string>();
  for (const item of value) {
    if (typeof item !== "string" || !item.startsWith("/") || item.includes("\0") || seen.has(item)) throw bad();
    seen.add(item);
  }
  return value as string[];
}

/** Keys shared by the user layer and its per-workspace overrides. */
function parseProfileFields(root: Record<string, unknown>, layer: Layer): Settings {
  if ("skill_match_fuzzy" in root)
    throw new SettingsError(
      "remove skill_match_fuzzy; skills now load only through explicit invocation or the skill tool",
    );
  const s: Settings = {};
  s.provider = readEnum(root, "provider", (raw) => PROVIDERS.find((p) => p === raw.toLowerCase()));
  s.models = readModels(root);
  s.permission_mode = readEnum(root, "permission_mode", parsePermissionMode);
  if (root.credential_source !== undefined) {
    if (typeof root.credential_source !== "string") throw new SettingsError('"credential_source" must be a string');
    s.credential_source = root.credential_source;
  }
  s.yolo_acknowledged = readBool(root, "yolo_acknowledged");
  if (root.context_limits !== undefined) {
    try {
      s.context_limits = parseLimitsObject(root.context_limits);
    } catch (err) {
      throw new SettingsError(
        `"context_limits" keys must be documented limit names with a non-negative integer or "off" value (${(err as Error).message})`,
      );
    }
  }
  if (root.first_call_tool_choice !== undefined) {
    if (typeof root.first_call_tool_choice !== "string")
      throw new SettingsError('"first_call_tool_choice" must be a string');
    const choice = root.first_call_tool_choice.trim().toLowerCase();
    if (choice === "auto" || choice === "none") s.first_call_tool_choice = choice;
  }
  s.fast_mode = readBool(root, "fast_mode");
  s.slash_menu_categories = readBool(root, "slash_menu_categories");
  s.collapse_tool_calls = readBool(root, "collapse_tool_calls");
  s.session_titles = readBool(root, "session_titles");
  s.auto_upgrade = readBool(root, "auto_upgrade");
  if (layer === "user")
    s.update_channel = readEnum(root, "update_channel", (raw) =>
      raw.toLowerCase() === "stable" ? "stable" : raw.toLowerCase() === "dev" ? "dev" : undefined,
    );
  s.startup_scrollback = readBool(root, "startup_scrollback");
  if (root.prompt_history !== undefined) {
    if (!isObject(root.prompt_history)) throw new SettingsError('"prompt_history" must be an object');
    s.prompt_history_enabled = readBool(root.prompt_history, "enabled");
  }
  if (root.effort === null) s.effort = "auto";
  else s.effort = readEnum(root, "effort", parseEffort);
  if (root.statusLine !== undefined) {
    if (!isObject(root.statusLine)) {
      if (layer === "user") throw new SettingsError('"statusLine" must be an object');
    } else {
      s.statusline_context = readBool(root.statusLine, "context");
      s.statusline_session = readBool(root.statusLine, "session");
      if (layer === "user") s.statusline_workspace = readBool(root.statusLine, "workspace");
    }
  }
  if (root.notifications !== undefined) {
    if (!isObject(root.notifications)) throw new SettingsError('"notifications" must be an object');
    s.notification_turn_end = readBool(root.notifications, "turn_end");
    s.notification_attention_required = readBool(root.notifications, "attention_required");
    s.notification_max = readBool(root.notifications, "max");
  }
  if (root.permission !== undefined) s.permission = root.permission;
  return s;
}

function parseProjectFields(root: Record<string, unknown>): Settings {
  const s: Settings = {};
  const steps = root.max_agent_steps;
  if (steps !== undefined) {
    if (!Number.isInteger(steps) || (steps as number) < 0)
      throw new SettingsError('"max_agent_steps" must be a non-negative integer');
    s.max_agent_steps = steps as number;
  }
  const bytes = root.max_tool_result_bytes;
  if (bytes !== undefined) {
    if (!Number.isInteger(bytes) || (bytes as number) < MIN_TOOL_RESULT_BYTES)
      throw new SettingsError(`"max_tool_result_bytes" must be an integer of at least ${MIN_TOOL_RESULT_BYTES}`);
    s.max_tool_result_bytes = bytes as number;
  }
  s.context = readBool(root, "context");
  return s;
}

export type ParsedLayer = { settings: Settings; diagnostics: string[] };

/**
 * Parses one layer. Throws SettingsError when a known key has the wrong type (the caller drops the layer);
 * returns diagnostics for keys that are merely ignored (user-only keys in .nod.json, bad additional_directories).
 */
export function parseLayer(json: unknown, layer: Layer): ParsedLayer {
  if (!isObject(json)) throw new SettingsError("settings must be a JSON object");
  const diagnostics: string[] = [];
  if (layer === "project") {
    for (const key of Object.keys(json))
      if (USER_ONLY_KEYS.has(key)) diagnostics.push(`ignored user-only setting in .nod.json; key=${key}`);
    return { settings: strip(parseProjectFields(json)), diagnostics };
  }
  const settings = { ...parseProfileFields(json, layer), ...parseProjectFields(json) };
  if (layer === "user" && "additional_directories" in json)
    diagnostics.push(
      `additional_directories must be an array of at most ${MAX_ADDITIONAL_DIRECTORIES} unique absolute directory paths for the current primary workspace; key=additional_directories`,
    );
  if (layer === "workspace") {
    if (json.additional_directories !== undefined) {
      try {
        settings.additional_directories = readAdditionalDirectories(json.additional_directories);
      } catch (err) {
        diagnostics.push(`${(err as Error).message}; key=additional_directories`);
      }
    }
    for (const key of ["mcp_trust", "enabled_servers", "disabled_servers"] as const)
      if (json[key] !== undefined) settings[key] = json[key];
  }
  return { settings: strip(settings), diagnostics };
}

/** Drops undefined entries so `{...a, ...b}` merges never clobber with undefined. */
function strip(settings: Settings): Settings {
  return Object.fromEntries(Object.entries(settings).filter(([, v]) => v !== undefined)) as Settings;
}
