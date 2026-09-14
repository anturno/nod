import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig, resolveConfig } from "../../src/core/config/resolve.ts";
import {
  parseEffort,
  parseLayer,
  parsePermissionMode,
  SettingsError,
  serializePermissionMode,
} from "../../src/core/config/settings-schema.ts";
import {
  loadMergedSettings,
  nodHome,
  readSettingsFile,
  writeUserPatch,
  writeWorkspacePatch,
} from "../../src/core/config/settings-store.ts";

let tmp: string;
let home: string;
let ws: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nod-config-"));
  home = join(tmp, ".nod");
  ws = join(tmp, "workspace");
  mkdirSync(ws, { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const writeUser = (json: unknown) => {
  mkdirSync(home, { recursive: true });
  writeFileSync(join(home, "settings.json"), typeof json === "string" ? json : JSON.stringify(json));
};
const writeProject = (json: unknown) => writeFileSync(join(ws, ".nod.json"), JSON.stringify(json));
const rawUser = () => JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
const load = (env = {}, cli = {}) => loadConfig({ home, workspaceRoot: ws, env, cli });

test("nodHome matches the auth store rule", () => {
  expect(nodHome({ NOD_HOME: "/x/.nod" })).toBe("/x/.nod");
  expect(nodHome({})).toEndWith("/.nod");
});

test("permission mode accepts every spelling and serializes yolo", () => {
  for (const raw of ["yolo", "YOLO", "full-access", "Full Access", " full access "])
    expect(parsePermissionMode(raw)).toBe("yolo");
  expect(parsePermissionMode("ask")).toBe("ask");
  expect(parsePermissionMode("Auto")).toBe("auto");
  expect(parsePermissionMode("nope")).toBeUndefined();
  expect(serializePermissionMode("yolo")).toBe("yolo");
  expect(parseEffort("HIGH")).toBe("high");
  expect(parseEffort("adaptive")).toBe("auto");
  expect(parseEffort("bogus")).toBeUndefined();
});

test("parseLayer reads every user key", () => {
  const { settings, diagnostics } = parseLayer(
    {
      provider: "Grok",
      codex_model: "legacy-codex",
      models: { codex: "gpt-x", grok: "grok-y" },
      permission_mode: "full-access",
      credential_source: "grok_subscription",
      yolo_acknowledged: true,
      max_agent_steps: 12,
      max_tool_result_bytes: 4096,
      context: false,
      context_limits: { skill_chunk_bytes: "off" },
      first_call_tool_choice: "NONE",
      fast_mode: true,
      effort: null,
      slash_menu_categories: false,
      collapse_tool_calls: false,
      session_titles: false,
      auto_upgrade: false,
      update_channel: "dev",
      startup_scrollback: true,
      prompt_history: { enabled: false },
      statusLine: { context: false, session: false, workspace: false },
      notifications: { turn_end: true, attention_required: false, max: true },
      permission: { bash: "ask" },
      unknown_key: 1,
    },
    "user",
  );
  expect(diagnostics).toEqual([]);
  expect(settings).toEqual({
    provider: "grok",
    models: { codex: "gpt-x", grok: "grok-y" },
    permission_mode: "yolo",
    credential_source: "grok_subscription",
    yolo_acknowledged: true,
    max_agent_steps: 12,
    max_tool_result_bytes: 4096,
    context: false,
    context_limits: { skill_chunk_bytes: "off" },
    first_call_tool_choice: "none",
    fast_mode: true,
    effort: "auto",
    slash_menu_categories: false,
    collapse_tool_calls: false,
    session_titles: false,
    auto_upgrade: false,
    update_channel: "dev",
    startup_scrollback: true,
    prompt_history_enabled: false,
    statusline_context: false,
    statusline_session: false,
    statusline_workspace: false,
    notification_turn_end: true,
    notification_attention_required: false,
    notification_max: true,
    permission: { bash: "ask" },
  });
  expect(parseLayer({ grok_model: "g-1" }, "user").settings.models).toEqual({ grok: "g-1" });
  expect(parseLayer({ first_call_tool_choice: "required" }, "user").settings.first_call_tool_choice).toBeUndefined();
});

test("parseLayer rejects wrong types per key", () => {
  const bad: Record<string, unknown>[] = [
    { provider: "openai" },
    { provider: 1 },
    { models: "gpt" },
    { models: { codex: " padded " } },
    { codex_model: "" },
    { permission_mode: "sudo" },
    { credential_source: 1 },
    { yolo_acknowledged: "yes" },
    { max_agent_steps: -1 },
    { max_agent_steps: 1.5 },
    { max_tool_result_bytes: 1023 },
    { context: "true" },
    { context_limits: { wat: 1 } },
    { first_call_tool_choice: 1 },
    { fast_mode: 1 },
    { effort: "extreme" },
    { effort: 3 },
    { update_channel: "nightly" },
    { prompt_history: true },
    { prompt_history: { enabled: "no" } },
    { statusLine: "x" },
    { statusLine: { context: 1 } },
    { notifications: [] },
    { notifications: { max: "loud" } },
    { skill_match_fuzzy: true },
  ];
  for (const json of bad) expect(() => parseLayer(json, "user")).toThrow(SettingsError);
  expect(() => parseLayer([], "user")).toThrow(SettingsError);
});

test("project layer keeps three keys and reports the rest", () => {
  const { settings, diagnostics } = parseLayer(
    { max_agent_steps: 3, max_tool_result_bytes: 2048, context: false, model: "x", provider: "grok", other: 1 },
    "project",
  );
  expect(settings).toEqual({ max_agent_steps: 3, max_tool_result_bytes: 2048, context: false });
  expect(diagnostics).toEqual([
    "ignored user-only setting in .nod.json; key=model",
    "ignored user-only setting in .nod.json; key=provider",
  ]);
});

test("workspace layer drops update_channel and statusLine.workspace, keeps raw mcp fields", () => {
  const { settings, diagnostics } = parseLayer(
    {
      update_channel: "dev",
      statusLine: "tolerated",
      additional_directories: ["/a", "/b"],
      mcp_trust: { srv: "trusted" },
      enabled_servers: ["a"],
      disabled_servers: ["b"],
      permission: "allow",
    },
    "workspace",
  );
  expect(diagnostics).toEqual([]);
  expect(settings).toEqual({
    additional_directories: ["/a", "/b"],
    mcp_trust: { srv: "trusted" },
    enabled_servers: ["a"],
    disabled_servers: ["b"],
    permission: "allow",
  });
  expect(parseLayer({ statusLine: { workspace: false } }, "workspace").settings.statusline_workspace).toBeUndefined();
  const invalid = parseLayer({ additional_directories: ["rel"], fast_mode: true }, "workspace");
  expect(invalid.settings).toEqual({ fast_mode: true });
  expect(invalid.diagnostics[0]).toContain("additional_directories must be an array of at most 16");
  expect(parseLayer({ additional_directories: ["/a", "/a"] }, "workspace").diagnostics).toHaveLength(1);
  expect(parseLayer({ additional_directories: new Array(17).fill("/a") }, "workspace").diagnostics).toHaveLength(1);
});

test("readSettingsFile enforces the 64 KiB cap", () => {
  writeUser(`{"pad":"${"a".repeat(64 * 1024)}"}`);
  expect(readSettingsFile(join(home, "settings.json"))).toEqual({ kind: "oversized" });
  writeUser("{not json");
  expect(readSettingsFile(join(home, "settings.json")).kind).toBe("invalid");
  expect(readSettingsFile(join(home, "missing.json"))).toEqual({ kind: "absent" });
  expect(loadMergedSettings({ home, workspaceRoot: ws }).diagnostics).toEqual([
    "[config] layer=user cause=malformed_settings; JSON Parse error: Expected '}'",
  ]);
});

test("precedence default → project → user → workspace → env → cli with sources", () => {
  writeProject({ max_agent_steps: 5, max_tool_result_bytes: 2048, context: false, provider: "grok" });
  writeUser({
    provider: "codex",
    models: { codex: "user-model" },
    permission_mode: "ask",
    max_agent_steps: 7,
    fast_mode: true,
    context_limits: { skill_chunk_bytes: 1 },
    workspaces: {
      [ws]: { models: { codex: "ws-model" }, permission_mode: "yolo", context_limits: { skill_chunk_bytes: 2 } },
    },
  });
  const cfg = load();
  expect(cfg.diagnostics).toEqual(["[config] layer=project ignored user-only setting in .nod.json; key=provider"]);
  expect(cfg.provider).toBe("codex");
  expect(cfg.model).toBe("ws-model");
  expect(cfg.permissionMode).toBe("yolo");
  expect(cfg.maxAgentSteps).toBe(7);
  expect(cfg.maxToolResultBytes).toBe(2048);
  expect(cfg.context).toBe(false);
  expect(cfg.fastMode).toBe(true);
  expect(cfg.effort).toBe("auto");
  expect(cfg.contextLimits.skill_chunk_bytes).toEqual({ value: 2, source: "workspace settings", bytes: 2 });
  expect(cfg.sources).toMatchObject({
    provider: "user",
    model: "workspace",
    permissionMode: "workspace",
    maxAgentSteps: "user",
    maxToolResultBytes: "project",
    context: "project",
    fastMode: "user",
    effort: "default",
    updateChannel: "default",
  });
  expect(cfg.workspaceRoot).toBe(ws);

  const env = load({ NOD_MODEL: " env-model ", NOD_PERMISSION_MODE: "auto", NOD_MAX_AGENT_STEPS: "0" });
  expect(env.model).toBe("env-model");
  expect(env.permissionMode).toBe("auto");
  expect(env.maxAgentSteps).toBe(0);
  expect(env.sources).toMatchObject({ model: "env", permissionMode: "env", maxAgentSteps: "env" });

  const cli = load({ NOD_MODEL: "env-model" }, { model: "cli-model", permissionMode: "yolo" });
  expect(cli.model).toBe("cli-model");
  expect(cli.permissionMode).toBe("yolo");
  expect(cli.sources).toMatchObject({ model: "cli", permissionMode: "cli" });

  const junk = load({ NOD_MODEL: "  ", NOD_PERMISSION_MODE: "sudo", NOD_MAX_AGENT_STEPS: "abc" });
  expect(junk.model).toBe("ws-model");
  expect(junk.permissionMode).toBe("yolo");
  expect(junk.maxAgentSteps).toBe(7);
});

test("defaults and the remaining env switches", () => {
  const cfg = load();
  expect(cfg.provider).toBe("codex");
  expect(cfg.model).toBe("gpt-5.6-luna");
  expect(cfg.permissionMode).toBe("auto");
  expect(cfg.maxAgentSteps).toBe(0);
  expect(cfg.maxToolResultBytes).toBe(65536);
  expect(cfg.context).toBe(true);
  expect(cfg.firstCallToolChoice).toBe("auto");
  expect(cfg.updateChannel).toBe("stable");
  expect(cfg.autoUpgrade).toBe(true);
  expect(cfg.promptHistory).toBe(true);
  expect(cfg.statusLine).toEqual({ context: true, session: true, workspace: true });
  expect(cfg.notifications.max).toBe(false);
  expect(cfg.openBrowser).toBe(true);
  expect(cfg.theme).toBeUndefined();
  expect(cfg.additionalDirectories).toEqual([]);
  expect(cfg.permissionRules).toEqual({ user: undefined, workspace: undefined });

  writeUser({ provider: "grok" });
  expect(load().model).toBeUndefined();

  const env = load({ NOD_AUTO_UPGRADE: "0", NOD_NO_OPEN_BROWSER: "1", NOD_THEME: "dark", NOD_SOUND: "max" });
  expect(env.autoUpgrade).toBe(false);
  expect(env.openBrowser).toBe(false);
  expect(env.theme).toBe("dark");
  expect(env.notifications).toEqual({ turnEnd: true, attentionRequired: true, max: true });
  expect(load({ NOD_SOUND: "off" }).notifications).toMatchObject({ turnEnd: false, attentionRequired: false });
  expect(load({ NOD_AUTO_UPGRADE: "1" }).autoUpgrade).toBe(true);
});

test("a broken layer is dropped with a diagnostic, the others survive", () => {
  writeProject({ max_agent_steps: 9 });
  writeUser({ fast_mode: "yes", workspaces: { [ws]: { max_agent_steps: 4 } } });
  const cfg = load();
  expect(cfg.maxAgentSteps).toBe(4);
  expect(cfg.fastMode).toBe(false);
  expect(cfg.diagnostics).toEqual(['[config] layer=user cause=malformed_settings; "fast_mode" must be a boolean']);
  const merged = loadMergedSettings({ home, workspaceRoot: ws });
  expect(resolveConfig(merged, {}, {}, { home, workspaceRoot: ws }).sources.maxAgentSteps).toBe("workspace");
});

test("writeUserPatch preserves unknown keys, migrates legacy models, writes 0600 atomically", () => {
  writeUser({ codex_model: "old-codex", grok_model: "old-grok", models: { codex: "new-codex" }, custom: { keep: 1 } });
  writeUserPatch(home, { permission_mode: "yolo", models: { grok: "patched-grok" }, custom_top: undefined });
  expect(rawUser()).toEqual({
    models: { codex: "new-codex", grok: "patched-grok" },
    custom: { keep: 1 },
    permission_mode: "yolo",
  });
  expect(statSync(join(home, "settings.json")).mode & 0o777).toBe(0o600);
  expect(statSync(home).mode & 0o777).toBe(0o700);
  expect(load().permissionMode).toBe("yolo");

  writeUserPatch(home, { permission_mode: undefined, fast_mode: true });
  expect(rawUser()).toEqual({
    models: { codex: "new-codex", grok: "patched-grok" },
    custom: { keep: 1 },
    fast_mode: true,
  });

  writeUser("{broken");
  expect(() => writeUserPatch(home, { fast_mode: false })).toThrow(/not a JSON object/);
});

test("writeUserPatch creates the file from nothing", () => {
  writeUserPatch(home, { provider: "grok" });
  expect(rawUser()).toEqual({ provider: "grok" });
});

test("writeWorkspacePatch scopes to the normalized primary root", () => {
  writeUser({ fast_mode: true, workspaces: { "/other": { fast_mode: false } } });
  writeWorkspacePatch(home, `${ws}/`, { additional_directories: ["/a"], permission_mode: "full-access" });
  expect(rawUser().workspaces[ws]).toEqual({ additional_directories: ["/a"], permission_mode: "full-access" });
  expect(rawUser().workspaces["/other"]).toEqual({ fast_mode: false });
  expect(load().additionalDirectories).toEqual(["/a"]);
  writeWorkspacePatch(home, ws, { additional_directories: undefined, permission_mode: undefined });
  expect(rawUser().workspaces).toEqual({ "/other": { fast_mode: false } });
});
