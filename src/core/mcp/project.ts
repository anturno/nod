/** <workspace>/.mcp.json: Claude-compatible project servers, trust choices, and ${VAR} expansion after approval. */
import { lstatSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { loadMergedSettings, writeWorkspacePatch } from "../config/settings-store.ts";
import { McpConfigError, normalizeServer } from "./config.ts";
import { MAX_EXPANDED_BYTES, MAX_PROJECT_FILE_BYTES } from "./limits.ts";
import type { McpAdmission, McpServerConfig } from "./types.ts";

export const projectConfigPath = (workspaceRoot: string): string => join(workspaceRoot, ".mcp.json");

export type Trust = { enabled: string[]; disabled: string[]; all: boolean };
export type TrustAction = "approve" | "reject" | "approve-all" | "reset";

const stringList = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

export function readTrust(home: string, workspaceRoot: string): Trust {
  const ws = loadMergedSettings({ home, workspaceRoot }).workspace;
  return {
    enabled: stringList(ws.enabled_servers),
    disabled: stringList(ws.disabled_servers),
    all: ws.mcp_trust === "all",
  };
}

export function admissionFor(name: string, trust: Trust): McpAdmission | "overlap" {
  const approved = trust.enabled.includes(name);
  const rejected = trust.disabled.includes(name);
  if (approved && rejected) return "overlap";
  if (rejected) return "rejected";
  if (approved || trust.all) return "approved";
  return "pending";
}

export function applyTrust(home: string, workspaceRoot: string, action: TrustAction, name?: string): void {
  const trust = readTrust(home, workspaceRoot);
  const without = (list: string[]) => list.filter((n) => n !== name);
  const list = (v: string[]) => (v.length ? v : undefined);
  switch (action) {
    case "approve":
      if (!name) throw new McpConfigError("approve requires a server name");
      writeWorkspacePatch(home, workspaceRoot, {
        enabled_servers: [...without(trust.enabled), name],
        disabled_servers: list(without(trust.disabled)),
      });
      return;
    case "reject":
      if (!name) throw new McpConfigError("reject requires a server name");
      writeWorkspacePatch(home, workspaceRoot, {
        enabled_servers: list(without(trust.enabled)),
        disabled_servers: [...without(trust.disabled), name],
      });
      return;
    case "approve-all":
      writeWorkspacePatch(home, workspaceRoot, { mcp_trust: "all", disabled_servers: undefined });
      return;
    case "reset":
      writeWorkspacePatch(home, workspaceRoot, {
        mcp_trust: undefined,
        enabled_servers: undefined,
        disabled_servers: undefined,
      });
      return;
  }
}

export type Expansion = { ok: true; value: string } | { ok: false; missing: string };

/** `${VAR}` and `${VAR:-default}`; anything else is literal. */
export function expandTemplate(value: string, env: Record<string, string | undefined>): Expansion {
  let missing: string | undefined;
  const out = value.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)(?::-([^}]*))?\}/g, (_m, name: string, fallback?: string) => {
    const v = env[name];
    if (v !== undefined) return v;
    if (fallback !== undefined) return fallback;
    missing ??= name;
    return "";
  });
  return missing ? { ok: false, missing } : { ok: true, value: out };
}

export type ProjectLoad = {
  servers: McpServerConfig[];
  /** Configuration issues, in fx's wording; never environment values. */
  issues: string[];
  /** Names still waiting for a trust decision. */
  pending: string[];
};

function readProjectJson(path: string): { json?: unknown; issue?: string; absent?: boolean } {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile()) return { issue: ".mcp.json was skipped: not a regular file." };
    if (stat.size > MAX_PROJECT_FILE_BYTES) return { issue: ".mcp.json was skipped: file exceeds 1 MiB." };
  } catch {
    return { absent: true };
  }
  try {
    return { json: JSON.parse(readFileSync(path, "utf8")) };
  } catch {
    return { issue: ".mcp.json was skipped: invalid_json." };
  }
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Expands one approved server; returns the diagnostic instead when a variable is missing or the budget is exceeded. */
export function expandServer(
  config: McpServerConfig,
  env: Record<string, string | undefined>,
  budget: { remaining: number },
): McpServerConfig | string {
  const out: McpServerConfig = { ...config };
  const expand = (value: string, field: string): string | undefined => {
    const r = expandTemplate(value, env);
    if (!r.ok) {
      issue = `.mcp.json server '${config.name}' field ${field} requires environment variable '${r.missing}'; set it or use \${${r.missing}:-default}.`;
      return undefined;
    }
    budget.remaining -= Buffer.byteLength(r.value);
    return r.value;
  };
  let issue: string | undefined;
  if (config.command) {
    const command: string[] = [];
    for (const [i, part] of config.command.entries()) {
      const v = expand(part, i === 0 ? "command" : `args[${i - 1}]`);
      if (v === undefined) return issue as string;
      command.push(v);
    }
    out.command = command;
  }
  const maps = [
    ["environment", config.environment, "env"],
    ["headers", config.headers, "headers"],
  ] as const;
  for (const [key, map, label] of maps) {
    if (!map) continue;
    const expanded: Record<string, string> = {};
    for (const [k, v] of Object.entries(map)) {
      const value = expand(v, `${label}.${k}`);
      if (value === undefined) return issue as string;
      expanded[k] = value;
    }
    out[key] = expanded;
  }
  if (budget.remaining < 0)
    return `.mcp.json server '${config.name}' was skipped: environment_expansion_limit_exceeded.`;
  return out;
}

/** Loads project servers with their admission; approved ones are expanded and become connectable. */
export function loadProjectServers({
  home,
  workspaceRoot,
  env,
}: {
  home: string;
  workspaceRoot: string;
  env: Record<string, string | undefined>;
}): ProjectLoad {
  const out: ProjectLoad = { servers: [], issues: [], pending: [] };
  const read = readProjectJson(projectConfigPath(workspaceRoot));
  if (read.absent) return out;
  if (read.issue) return { ...out, issues: [read.issue] };
  if (!isObject(read.json)) return { ...out, issues: [".mcp.json was skipped: root_must_be_object."] };
  const servers = read.json.mcpServers;
  if (servers === undefined) return out;
  if (!isObject(servers)) return { ...out, issues: [".mcp.json was skipped: servers_must_be_object."] };
  const trust = readTrust(home, workspaceRoot);
  const budget = { remaining: MAX_EXPANDED_BYTES };
  for (const [name, raw] of Object.entries(servers)) {
    let config: McpServerConfig;
    try {
      config = normalizeServer(name, raw, "project");
    } catch (e) {
      out.issues.push(
        `.mcp.json server '${name}' was skipped: invalid_entry (${e instanceof Error ? e.message : String(e)}).`,
      );
      continue;
    }
    const admission = admissionFor(name, trust);
    if (admission === "overlap") {
      out.issues.push(`.mcp.json server '${name}' was skipped: approved_rejected_overlap.`);
      config.admission = "pending";
      out.servers.push(config);
      out.pending.push(name);
      continue;
    }
    config.admission = admission;
    if (admission === "pending") out.pending.push(name);
    if (admission !== "approved") {
      out.servers.push(config);
      continue;
    }
    const expanded = expandServer(config, env, budget);
    if (typeof expanded === "string") out.issues.push(expanded);
    else out.servers.push(expanded);
  }
  return out;
}
