/** ~/.nod/mcp.json: the private MCP profile, its aliases, normalization, and validation. */
import { chmodSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DEFAULT_OPERATION_TIMEOUT_MS, DEFAULT_RESTART_LIMIT, DEFAULT_STARTUP_TIMEOUT_MS } from "./limits.ts";
import type { McpOAuthConfig, McpServerConfig, McpSource, McpTransportType } from "./types.ts";

export class McpConfigError extends Error {}

export const NAME_PATTERN = /^[A-Za-z0-9_-]+$/;
export const profilePath = (home: string): string => join(home, "mcp.json");

export type ProfileWarning = {
  cause: "ignored_mcp_servers_alias" | "suspicious_server_key";
  key?: string;
  additionalMatches: number;
};

export type ProfileDocument = {
  path: string;
  servers: McpServerConfig[];
  /** Per-entry problems; the entry is dropped. */
  issues: string[];
  warning?: ProfileWarning;
  /** The file could not be read as a JSON object. */
  error?: string;
  raw: Record<string, unknown>;
};

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** Keys that look like they were meant to hold servers but are not `mcp` or `mcpServers`. */
export function isSuspiciousServerKey(key: string): boolean {
  if (key === "mcp" || key === "mcpServers") return false;
  const normalized = key.replace(/[^A-Za-z0-9]/g, "").toLowerCase();
  return [
    "mcp",
    "mcpserver",
    "mcpservers",
    "modelcontextprotocol",
    "modelcontextprotocolserver",
    "modelcontextprotocolservers",
    "servers",
  ].includes(normalized);
}

export const renderProfileWarning = (w: ProfileWarning): string =>
  `MCP config warning: ${w.cause}${w.key ? ` key=${w.key.slice(0, 128)}` : ""} additional_matches=${w.additionalMatches}`;

function stringMap(raw: unknown, where: string): Record<string, string> {
  if (!isObject(raw)) throw new McpConfigError(`${where} must be an object of strings`);
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (typeof value !== "string") throw new McpConfigError(`${where}.${key} must be a string`);
    out[key] = value;
  }
  return out;
}

function positiveInt(raw: unknown, where: string, fallback: number): number {
  if (raw === undefined) return fallback;
  if (!Number.isInteger(raw) || (raw as number) <= 0) throw new McpConfigError(`${where} must be a positive integer`);
  return raw as number;
}

/** https anywhere; http only to localhost, 127.0.0.1, or [::1] with an explicit port. */
export function validateUrl(raw: string, where: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new McpConfigError(`${where} must be a valid URL`);
  }
  if (url.username || url.password) throw new McpConfigError(`${where} must not embed credentials`);
  if (url.hash) throw new McpConfigError(`${where} must not contain a fragment`);
  if (url.protocol === "https:") return raw;
  if (url.protocol !== "http:") throw new McpConfigError(`${where} must use https or loopback http`);
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (!loopback || !url.port)
    throw new McpConfigError(
      `${where} must use https, or http with an explicit port on localhost, 127.0.0.1, or [::1]`,
    );
  return raw;
}

const TRANSPORTS: Record<string, McpTransportType> = { stdio: "stdio", local: "stdio", http: "http", sse: "sse" };

/** Turns one raw entry into the canonical config; throws McpConfigError with the reason. */
export function normalizeServer(name: string, raw: unknown, source: McpSource): McpServerConfig {
  if (!NAME_PATTERN.test(name))
    throw new McpConfigError(`MCP server name '${name}' must contain only letters, numbers, _, or -`);
  if (!isObject(raw)) throw new McpConfigError(`MCP server '${name}' must be an object`);
  const where = `MCP server '${name}'`;
  let type: McpTransportType;
  if (raw.type !== undefined) {
    const mapped = typeof raw.type === "string" ? TRANSPORTS[raw.type] : undefined;
    if (!mapped) throw new McpConfigError(`${where} type must be stdio, local, http, or sse`);
    type = mapped;
  } else type = raw.url !== undefined && raw.command === undefined ? "http" : "stdio";

  const config: McpServerConfig = {
    name,
    type,
    enabled: raw.enabled === undefined ? true : raw.enabled === true,
    required: raw.required === true,
    startup_timeout_ms: positiveInt(raw.startup_timeout_ms, `${where} startup_timeout_ms`, DEFAULT_STARTUP_TIMEOUT_MS),
    operation_timeout_ms: positiveInt(
      raw.operation_timeout_ms,
      `${where} operation_timeout_ms`,
      DEFAULT_OPERATION_TIMEOUT_MS,
    ),
    restart_limit: raw.restart_limit === undefined ? DEFAULT_RESTART_LIMIT : (raw.restart_limit as number),
    source,
  };
  if (raw.enabled !== undefined && typeof raw.enabled !== "boolean")
    throw new McpConfigError(`${where} enabled must be a boolean`);
  if (raw.required !== undefined && typeof raw.required !== "boolean")
    throw new McpConfigError(`${where} required must be a boolean`);
  if (raw.restart_limit !== undefined && (!Number.isInteger(raw.restart_limit) || (raw.restart_limit as number) < 0))
    throw new McpConfigError(`${where} restart_limit must be a non-negative integer`);

  if (type === "stdio") {
    let command: string[];
    if (typeof raw.command === "string") command = [raw.command];
    else if (Array.isArray(raw.command) && raw.command.every((c) => typeof c === "string"))
      command = [...(raw.command as string[])];
    else throw new McpConfigError(`${where} requires a command (string or array of strings)`);
    if (raw.args !== undefined) {
      if (!Array.isArray(raw.args) || !raw.args.every((a) => typeof a === "string"))
        throw new McpConfigError(`${where} args must be an array of strings`);
      command.push(...(raw.args as string[]));
    }
    if (command.length === 0 || !command[0]) throw new McpConfigError(`${where} command must not be empty`);
    config.command = command;
    const env = raw.environment !== undefined ? raw.environment : raw.env;
    if (env !== undefined) config.environment = stringMap(env, `${where} environment`);
  } else {
    if (typeof raw.url !== "string") throw new McpConfigError(`${where} requires a url`);
    config.url = validateUrl(raw.url, `${where} url`);
    if (raw.headers !== undefined) {
      config.headers = stringMap(raw.headers, `${where} headers`);
      const literalAuth = Object.keys(config.headers).find((h) => h.toLowerCase() === "authorization");
      if (literalAuth && source !== "project")
        throw new McpConfigError(
          `${where} must not set a literal Authorization header; use bearer_token_env, header_env, or oauth`,
        );
    }
    if (raw.header_env !== undefined) config.header_env = stringMap(raw.header_env, `${where} header_env`);
    if (raw.bearer_token_env !== undefined) {
      if (typeof raw.bearer_token_env !== "string" || !raw.bearer_token_env)
        throw new McpConfigError(`${where} bearer_token_env must be a string`);
      config.bearer_token_env = raw.bearer_token_env;
    }
    if (raw.oauth !== undefined) {
      if (!isObject(raw.oauth)) throw new McpConfigError(`${where} oauth must be an object`);
      const oauth: McpOAuthConfig = {};
      for (const key of ["resource", "issuer", "client_id", "client_secret_env", "client_metadata_url"] as const) {
        const v = raw.oauth[key];
        if (v === undefined) continue;
        if (typeof v !== "string" || !v) throw new McpConfigError(`${where} oauth.${key} must be a string`);
        oauth[key] = v;
      }
      if (raw.oauth.scopes !== undefined) {
        if (!Array.isArray(raw.oauth.scopes) || !raw.oauth.scopes.every((s) => typeof s === "string"))
          throw new McpConfigError(`${where} oauth.scopes must be an array of strings`);
        oauth.scopes = [...(raw.oauth.scopes as string[])];
      }
      config.oauth = oauth;
    }
  }
  if (source === "project") config.required = false;
  return config;
}

/** Reads the profile; a missing file is an empty profile. */
export function loadProfile(home: string): ProfileDocument {
  const path = profilePath(home);
  const doc: ProfileDocument = { path, servers: [], issues: [], raw: {} };
  let text: string;
  try {
    if (!statSync(path).isFile()) return { ...doc, error: "not a regular file" };
    text = readFileSync(path, "utf8");
  } catch {
    return doc;
  }
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch (e) {
    return { ...doc, error: `invalid JSON: ${(e as Error).message}` };
  }
  if (!isObject(json)) return { ...doc, error: "root must be an object" };
  doc.raw = json;
  const suspicious = Object.keys(json).filter(isSuspiciousServerKey);
  if (suspicious.length > 0)
    doc.warning = { cause: "suspicious_server_key", key: suspicious[0], additionalMatches: suspicious.length - 1 };
  else if (json.mcp !== undefined && json.mcpServers !== undefined)
    doc.warning = { cause: "ignored_mcp_servers_alias", key: "mcpServers", additionalMatches: 0 };
  const servers = json.mcp !== undefined ? json.mcp : json.mcpServers;
  if (servers === undefined) return doc;
  if (!isObject(servers)) return { ...doc, error: "mcp must be an object" };
  for (const [name, raw] of Object.entries(servers)) {
    try {
      doc.servers.push(normalizeServer(name, raw, "profile"));
    } catch (e) {
      doc.issues.push(e instanceof McpConfigError ? e.message : String(e));
    }
  }
  return doc;
}

function writeProfile(home: string, raw: Record<string, unknown>) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = profilePath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(raw, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** A profile with a suspicious key blocks writes so nod never overwrites an ambiguous file. */
function writableRaw(home: string): {
  raw: Record<string, unknown>;
  servers: Record<string, unknown>;
  warning?: ProfileWarning;
} {
  const doc = loadProfile(home);
  if (doc.error) throw new McpConfigError(`cannot update ${doc.path}: ${doc.error}`);
  if (doc.warning?.cause === "suspicious_server_key")
    throw new McpConfigError(`${renderProfileWarning(doc.warning)}; profile mutations are blocked`);
  const raw = doc.raw;
  // `mcp` wins and is what nod writes; a lone `mcpServers` alias is migrated.
  if (!isObject(raw.mcp)) raw.mcp = isObject(raw.mcpServers) ? raw.mcpServers : {};
  delete raw.mcpServers;
  return { raw, servers: raw.mcp as Record<string, unknown>, warning: doc.warning };
}

export type AddIntent = { name: string; command: string[] } | { name: string; url: string };

/** Adds or replaces one entry; returns the warning that was present before the write, if any. */
export function saveProfileServer(home: string, intent: AddIntent): ProfileWarning | undefined {
  if (!NAME_PATTERN.test(intent.name))
    throw new McpConfigError(`MCP server name '${intent.name}' must contain only letters, numbers, _, or -`);
  const entry: Record<string, unknown> =
    "url" in intent
      ? { type: "http", url: validateUrl(intent.url, `MCP server '${intent.name}' url`) }
      : { type: "local", command: intent.command };
  normalizeServer(intent.name, entry, "profile");
  const { raw, servers, warning } = writableRaw(home);
  servers[intent.name] = entry;
  writeProfile(home, raw);
  return warning;
}

export function removeProfileServer(home: string, name: string): boolean {
  const { raw, servers } = writableRaw(home);
  if (!(name in servers)) return false;
  delete servers[name];
  writeProfile(home, raw);
  return true;
}

/** Same-name profile entries win over project entries. */
export function mergeServers(profile: McpServerConfig[], project: McpServerConfig[]): McpServerConfig[] {
  const names = new Set(profile.map((s) => s.name));
  return [...profile, ...project.filter((s) => !names.has(s.name))];
}
