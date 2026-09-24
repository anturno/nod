/** OAuth for remote MCP servers: metadata discovery, client id, PKCE + loopback callback, tokens, and the credential file. */
import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { LOGIN_TIMEOUT_MS, listenForCallback, pkce, withTimeout } from "../../providers/auth/oauth.ts";
import { REFRESH_EARLY_MS } from "./limits.ts";
import type { McpServerConfig } from "./types.ts";

export type AuthChallenge = { resource_metadata?: string; scope?: string; error?: string };

export class McpAuthError extends Error {
  constructor(
    readonly status: number,
    readonly challenge: AuthChallenge,
  ) {
    super(status === 403 ? "MCP server refused the token scope" : "MCP server requires authentication");
  }
}

/** `Bearer resource_metadata="...", scope="a b", error="insufficient_scope"`. */
export function parseWwwAuthenticate(header: string | null | undefined): AuthChallenge {
  const out: AuthChallenge = {};
  if (!header) return out;
  for (const m of header.matchAll(/([A-Za-z_]+)\s*=\s*(?:"([^"]*)"|([^\s,]+))/g)) {
    const key = (m[1] as string).toLowerCase();
    const value = m[2] ?? m[3] ?? "";
    if (key === "resource_metadata") out.resource_metadata = value;
    else if (key === "scope") out.scope = value;
    else if (key === "error") out.error = value;
  }
  return out;
}

export type McpCredentials = {
  access_token: string;
  refresh_token?: string;
  expires_at_ms?: number;
  scope?: string;
  issuer: string;
  client_id: string;
  resource: string;
  token_endpoint: string;
  revocation_endpoint?: string;
};

export const credentialsPath = (home: string): string => join(home, "mcp-credentials.json");

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string" && v.length > 0;

function validCredentials(v: unknown): v is McpCredentials {
  return (
    isObject(v) &&
    str(v.access_token) &&
    str(v.issuer) &&
    str(v.client_id) &&
    str(v.resource) &&
    str(v.token_endpoint) &&
    (v.refresh_token === undefined || typeof v.refresh_token === "string") &&
    (v.expires_at_ms === undefined || typeof v.expires_at_ms === "number") &&
    (v.scope === undefined || typeof v.scope === "string")
  );
}

/** Malformed entries are ignored and reported; the caller purges them on the next successful write. */
export function readCredentials(home: string): { entries: Record<string, McpCredentials>; malformed: string[] } {
  const out: { entries: Record<string, McpCredentials>; malformed: string[] } = { entries: {}, malformed: [] };
  let json: unknown;
  try {
    json = JSON.parse(readFileSync(credentialsPath(home), "utf8"));
  } catch {
    return out;
  }
  if (!isObject(json)) return out;
  for (const [name, value] of Object.entries(json)) {
    if (validCredentials(value)) out.entries[name] = value;
    else out.malformed.push(name);
  }
  return out;
}

// ponytail: temp+rename is atomic per write; add a lock file if two nod processes authenticate the same server at once.
export function writeCredentials(home: string, entries: Record<string, McpCredentials>): void {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const path = credentialsPath(home);
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(entries, null, 2)}\n`, { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
}

/** Sets or deletes one entry and drops malformed ones; returns how many malformed entries were removed. */
export function storeCredentials(home: string, name: string, creds: McpCredentials | undefined): number {
  const { entries, malformed } = readCredentials(home);
  if (creds) entries[name] = creds;
  else delete entries[name];
  writeCredentials(home, entries);
  return malformed.length;
}

export const needsRefresh = (creds: McpCredentials, now: number): boolean =>
  creds.expires_at_ms !== undefined && now >= creds.expires_at_ms - REFRESH_EARLY_MS;

export type AuthDeps = {
  fetch: typeof fetch;
  openUrl(url: string): void | Promise<void>;
  env: Record<string, string | undefined>;
  now(): number;
  timeoutMs?: number;
  /** Loopback ports to try; [0] picks a free one. */
  ports?: number[];
};

type AsMetadata = {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  registration_endpoint?: string;
  revocation_endpoint?: string;
  scopes_supported?: string[];
  code_challenge_methods_supported?: string[];
  client_id_metadata_document_supported?: boolean;
};

const trimSlash = (u: string) => u.replace(/\/+$/, "");

async function getJson(fetcher: typeof fetch, url: string): Promise<Record<string, unknown> | undefined> {
  try {
    const res = await fetcher(url, { headers: { accept: "application/json" } });
    if (!res.ok) return undefined;
    const json: unknown = await res.json();
    return isObject(json) ? json : undefined;
  } catch {
    return undefined;
  }
}

/** Protected resource metadata (RFC 9728): the challenge URL first, then the well-known path with and without the resource path. */
export async function discoverResource(fetcher: typeof fetch, resourceUrl: string, challenge: AuthChallenge) {
  const u = new URL(resourceUrl);
  const candidates = [
    ...(challenge.resource_metadata ? [challenge.resource_metadata] : []),
    ...(u.pathname && u.pathname !== "/" ? [`${u.origin}/.well-known/oauth-protected-resource${u.pathname}`] : []),
    `${u.origin}/.well-known/oauth-protected-resource`,
  ];
  for (const url of candidates) {
    const json = await getJson(fetcher, url);
    if (!json) continue;
    const servers = Array.isArray(json.authorization_servers) ? json.authorization_servers.filter(str) : [];
    if (servers.length === 0) continue;
    return {
      authorizationServer: servers[0] as string,
      scopes: Array.isArray(json.scopes_supported) ? json.scopes_supported.filter(str) : [],
      resource: str(json.resource) ? json.resource : undefined,
    };
  }
  return undefined;
}

/** AS metadata (RFC 8414 / OIDC): path-aware well-known first, then bare; the returned issuer must match the requested one. */
export async function discoverAuthorizationServer(fetcher: typeof fetch, issuer: string): Promise<AsMetadata> {
  const u = new URL(issuer);
  const path = u.pathname && u.pathname !== "/" ? trimSlash(u.pathname) : "";
  const candidates = path
    ? [
        `${u.origin}/.well-known/oauth-authorization-server${path}`,
        `${u.origin}/.well-known/openid-configuration${path}`,
        `${u.origin}${path}/.well-known/openid-configuration`,
      ]
    : [`${u.origin}/.well-known/oauth-authorization-server`, `${u.origin}/.well-known/openid-configuration`];
  for (const url of candidates) {
    const json = await getJson(fetcher, url);
    if (!json) continue;
    if (!str(json.issuer) || trimSlash(json.issuer) !== trimSlash(issuer))
      throw new Error(`OAuth issuer mismatch: metadata at ${url} names a different issuer than ${issuer}`);
    if (!str(json.authorization_endpoint) || !str(json.token_endpoint))
      throw new Error("OAuth authorization server metadata is incomplete");
    const methods = Array.isArray(json.code_challenge_methods_supported)
      ? json.code_challenge_methods_supported
      : undefined;
    if (methods && !methods.includes("S256")) throw new Error("OAuth authorization server does not support PKCE S256");
    return {
      issuer: json.issuer,
      authorization_endpoint: json.authorization_endpoint,
      token_endpoint: json.token_endpoint,
      registration_endpoint: str(json.registration_endpoint) ? json.registration_endpoint : undefined,
      revocation_endpoint: str(json.revocation_endpoint) ? json.revocation_endpoint : undefined,
      scopes_supported: Array.isArray(json.scopes_supported) ? json.scopes_supported.filter(str) : undefined,
      code_challenge_methods_supported: methods?.filter(str),
      client_id_metadata_document_supported: json.client_id_metadata_document_supported === true,
    };
  }
  throw new Error(`OAuth authorization server metadata not found for ${issuer}`);
}

async function resolveClient(cfg: McpServerConfig, as: AsMetadata, redirectUri: string, deps: AuthDeps) {
  const oauth = cfg.oauth ?? {};
  if (oauth.client_id) {
    const secret = oauth.client_secret_env ? deps.env[oauth.client_secret_env] : undefined;
    return { clientId: oauth.client_id, clientSecret: secret };
  }
  if (oauth.client_metadata_url && as.client_id_metadata_document_supported)
    return { clientId: oauth.client_metadata_url };
  if (!as.registration_endpoint)
    throw new Error(
      "OAuth requires oauth.client_id: the authorization server does not offer dynamic client registration",
    );
  const res = await deps.fetch(as.registration_endpoint, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({
      client_name: "nod",
      redirect_uris: [redirectUri],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "none",
    }),
  });
  const json: unknown = await res.json().catch(() => undefined);
  if (!res.ok || !isObject(json) || !str(json.client_id))
    throw new Error(`OAuth dynamic client registration failed (${res.status})`);
  return { clientId: json.client_id, clientSecret: str(json.client_secret) ? json.client_secret : undefined };
}

async function tokenRequest(deps: AuthDeps, endpoint: string, form: Record<string, string>, clientSecret?: string) {
  const body = new URLSearchParams(form);
  if (clientSecret) body.set("client_secret", clientSecret);
  const res = await deps.fetch(endpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded", accept: "application/json" },
    body: body.toString(),
  });
  const json: unknown = await res.json().catch(() => undefined);
  if (!res.ok || !isObject(json) || !str(json.access_token))
    throw new Error(`OAuth token request failed (${res.status})`);
  return {
    access_token: json.access_token,
    refresh_token: str(json.refresh_token) ? json.refresh_token : undefined,
    expires_at_ms: typeof json.expires_in === "number" ? deps.now() + json.expires_in * 1000 : undefined,
    scope: str(json.scope) ? json.scope : undefined,
  };
}

const unionScopes = (...lists: (string[] | undefined)[]): string =>
  [
    ...new Set(
      lists
        .flatMap((l) => l ?? [])
        .flatMap((s) => s.split(/\s+/))
        .filter(Boolean),
    ),
  ].join(" ");

/** The full authorization-code flow; resolves with credentials the caller stores. */
export async function authorize(
  cfg: McpServerConfig,
  challenge: AuthChallenge,
  deps: AuthDeps,
): Promise<McpCredentials> {
  if (!cfg.url) throw new Error("OAuth requires a remote server url");
  const resourceUrl = cfg.oauth?.resource ?? cfg.url.replace(/#.*$/, "");
  const resourceMeta = await discoverResource(deps.fetch, cfg.url, challenge);
  const issuer = cfg.oauth?.issuer ?? resourceMeta?.authorizationServer ?? new URL(cfg.url).origin;
  const as = await discoverAuthorizationServer(deps.fetch, issuer);
  const { verifier, challenge: codeChallenge, state } = await pkce();
  const callback = listenForCallback({ ports: deps.ports ?? [0], path: "/callback", state, redirectHost: "127.0.0.1" });
  try {
    const client = await resolveClient(cfg, as, callback.redirectUri, deps);
    const scope = unionScopes(
      challenge.scope ? [challenge.scope] : [],
      cfg.oauth?.scopes,
      resourceMeta?.scopes,
      as.scopes_supported,
    );
    const url = new URL(as.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", client.clientId);
    url.searchParams.set("redirect_uri", callback.redirectUri);
    url.searchParams.set("code_challenge", codeChallenge);
    url.searchParams.set("code_challenge_method", "S256");
    url.searchParams.set("state", state);
    url.searchParams.set("resource", resourceUrl);
    if (scope) url.searchParams.set("scope", scope);
    await deps.openUrl(url.toString());
    const code = await withTimeout(
      callback.code,
      deps.timeoutMs ?? LOGIN_TIMEOUT_MS,
      "MCP authentication timed out waiting for the browser callback",
    );
    const token = await tokenRequest(
      deps,
      as.token_endpoint,
      {
        grant_type: "authorization_code",
        code,
        redirect_uri: callback.redirectUri,
        client_id: client.clientId,
        code_verifier: verifier,
        resource: resourceUrl,
      },
      client.clientSecret,
    );
    return {
      ...token,
      scope: token.scope ?? (scope || undefined),
      issuer: as.issuer,
      client_id: client.clientId,
      resource: resourceUrl,
      token_endpoint: as.token_endpoint,
      revocation_endpoint: as.revocation_endpoint,
    };
  } finally {
    callback.stop();
  }
}

export async function refreshCredentials(
  creds: McpCredentials,
  cfg: McpServerConfig,
  deps: AuthDeps,
): Promise<McpCredentials> {
  if (!creds.refresh_token) throw new Error("MCP credentials expired and cannot be refreshed");
  const secret = cfg.oauth?.client_secret_env ? deps.env[cfg.oauth.client_secret_env] : undefined;
  const token = await tokenRequest(
    deps,
    creds.token_endpoint,
    {
      grant_type: "refresh_token",
      refresh_token: creds.refresh_token,
      client_id: creds.client_id,
      resource: creds.resource,
    },
    secret,
  );
  return {
    ...creds,
    ...token,
    refresh_token: token.refresh_token ?? creds.refresh_token,
    scope: token.scope ?? creds.scope,
  };
}

/** Best-effort RFC 7009 revocation; false when the server has no endpoint or refused. */
export async function revokeCredentials(creds: McpCredentials, deps: Pick<AuthDeps, "fetch">): Promise<boolean> {
  if (!creds.revocation_endpoint) return false;
  try {
    const res = await deps.fetch(creds.revocation_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: creds.refresh_token ?? creds.access_token,
        client_id: creds.client_id,
      }).toString(),
    });
    return res.ok;
  } catch {
    return false;
  }
}
