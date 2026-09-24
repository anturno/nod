/** Reads the settings layers from disk and writes patches back atomically (temp + rename, 0600 inside a 0700 home). */
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  MAX_SETTINGS_BYTES,
  PROVIDERS,
  parseLayer,
  type Settings,
  serializePermissionMode,
} from "./settings-schema.ts";

/** Same rule as the providers' auth store: NOD_HOME, else ~/.nod. */
export const nodHome = (env: Record<string, string | undefined> = process.env) =>
  env.NOD_HOME ?? join(homedir(), ".nod");
export const settingsPath = (home: string) => join(home, "settings.json");
export const projectSettingsPath = (workspaceRoot: string) => join(workspaceRoot, ".nod.json");

/** Trailing slashes off, so `workspaces` keys match however the root was spelled. */
export const normalizeWorkspaceRoot = (root: string) => root.replace(/(?<=.)\/+$/, "");

export type SettingsFile =
  | { kind: "absent" }
  | { kind: "oversized" }
  | { kind: "invalid"; error: string }
  | { kind: "valid"; json: unknown };

export function readSettingsFile(path: string): SettingsFile {
  let size: number;
  try {
    const stat = statSync(path);
    if (!stat.isFile()) return { kind: "invalid", error: "not a regular file" };
    size = stat.size;
  } catch {
    return { kind: "absent" };
  }
  if (size > MAX_SETTINGS_BYTES) return { kind: "oversized" };
  try {
    return { kind: "valid", json: JSON.parse(readFileSync(path, "utf8")) };
  } catch (err) {
    return { kind: "invalid", error: (err as Error).message };
  }
}

export type MergedSettings = {
  project: Settings;
  user: Settings;
  workspace: Settings;
  diagnostics: string[];
};

/** Loads .nod.json, settings.json and settings.workspaces[root]; a broken layer is dropped with a diagnostic. */
export function loadMergedSettings({ home, workspaceRoot }: { home: string; workspaceRoot: string }): MergedSettings {
  const root = normalizeWorkspaceRoot(workspaceRoot);
  const out: MergedSettings = { project: {}, user: {}, workspace: {}, diagnostics: [] };
  const load = (layer: "project" | "user", path: string): unknown => {
    const file = readSettingsFile(path);
    if (file.kind === "absent") return undefined;
    if (file.kind === "valid") return file.json;
    out.diagnostics.push(
      `[config] layer=${layer} cause=${file.kind === "oversized" ? "settings_too_large" : "malformed_settings"}${file.kind === "invalid" ? `; ${file.error}` : ""}`,
    );
    return undefined;
  };
  const parse = (layer: "project" | "user" | "workspace", json: unknown): Settings => {
    if (json === undefined) return {};
    try {
      const parsed = parseLayer(json, layer);
      out.diagnostics.push(...parsed.diagnostics.map((d) => `[config] layer=${layer} ${d}`));
      return parsed.settings;
    } catch (err) {
      out.diagnostics.push(`[config] layer=${layer} cause=malformed_settings; ${(err as Error).message}`);
      return {};
    }
  };
  out.project = parse("project", load("project", projectSettingsPath(root)));
  const userJson = load("user", settingsPath(home));
  out.user = parse("user", userJson);
  const workspaces = (userJson as { workspaces?: unknown } | undefined)?.workspaces;
  if (workspaces !== undefined) {
    if (typeof workspaces !== "object" || workspaces === null || Array.isArray(workspaces))
      out.diagnostics.push("[config] layer=user cause=malformed_settings; workspaces must be an object");
    else out.workspace = parse("workspace", (workspaces as Record<string, unknown>)[root]);
  }
  return out;
}

type Json = Record<string, unknown>;
const isObject = (v: unknown): v is Json => typeof v === "object" && v !== null && !Array.isArray(v);

/** The raw file as an object; absent → {}. Throws on malformed JSON so a patch never clobbers user data. */
function readRaw(home: string): Json {
  const file = readSettingsFile(settingsPath(home));
  if (file.kind === "absent") return {};
  if (file.kind !== "valid" || !isObject(file.json))
    throw new Error(`${settingsPath(home)} is not a JSON object; fix or remove it before saving settings`);
  return file.json;
}

function writeRaw(home: string, root: Json) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  chmodSync(home, 0o700);
  const path = settingsPath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, `${JSON.stringify(root, null, 2)}\n`, { mode: 0o600 });
  renameSync(tmp, path);
}

/** Legacy top-level `codex_model`/`grok_model` move under `models` (existing `models.<p>` wins). */
function migrateLegacyModels(root: Json) {
  for (const provider of PROVIDERS) {
    const key = `${provider}_model`;
    if (!(key in root)) continue;
    const legacy = root[key];
    delete root[key];
    if (typeof legacy !== "string") continue;
    const models = isObject(root.models) ? root.models : (root.models = {});
    models[provider] ??= legacy;
  }
}

/** A patch sets keys; `undefined` deletes; `models` merges by provider; `permission_mode` is normalized on disk. */
function applyPatch(target: Json, patch: Json) {
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) delete target[key];
    else if (key === "models" && isObject(value)) {
      const models = isObject(target.models) ? target.models : (target.models = {});
      for (const [provider, model] of Object.entries(value)) {
        if (model === undefined) delete models[provider];
        else models[provider] = model;
      }
    } else if (key === "permission_mode" && typeof value === "string")
      target[key] = serializePermissionMode(value as Parameters<typeof serializePermissionMode>[0]);
    else target[key] = value;
  }
}

/** Mutates only the given top-level keys of ~/.nod/settings.json, preserving everything else. */
export function writeUserPatch(home: string, patch: Json) {
  const root = readRaw(home);
  migrateLegacyModels(root);
  applyPatch(root, patch);
  writeRaw(home, root);
}

/** Same, under `workspaces[<absolute root>]`; an emptied workspace entry is removed. */
export function writeWorkspacePatch(home: string, workspaceRoot: string, patch: Json) {
  const root = readRaw(home);
  migrateLegacyModels(root);
  const key = normalizeWorkspaceRoot(workspaceRoot);
  const workspaces = isObject(root.workspaces) ? root.workspaces : (root.workspaces = {});
  const entry = isObject(workspaces[key]) ? workspaces[key] : (workspaces[key] = {});
  applyPatch(entry, patch);
  if (Object.keys(entry).length === 0) delete workspaces[key];
  writeRaw(home, root);
}
