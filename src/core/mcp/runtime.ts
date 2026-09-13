/** The MCP runtime: loads profile + project servers, connects them, and serves tools/search/select/features/call. */
import { DEFAULT_LIMITS, type ResolvedLimits } from "../context/limits.ts";
import { fail, isRecord, ok } from "../tools/args.ts";
import { toolExecutionFailed } from "../tools/errors.ts";
import type { AskUser, ToolResult, ToolSpec } from "../tools/spec.ts";
import {
  connectClient,
  contentText,
  type ElicitationRequest,
  type ElicitationResult,
  type McpClient,
} from "./client.ts";
import { loadProfile, mergeServers, renderProfileWarning } from "./config.ts";
import { isAbortError } from "./jsonrpc.ts";
import { MAX_SCOPE_RETRIES } from "./limits.ts";
import { createNameRegistry } from "./names.ts";
import {
  type AuthChallenge,
  authorize,
  McpAuthError,
  type McpCredentials,
  needsRefresh,
  readCredentials,
  refreshCredentials,
  revokeCredentials,
  storeCredentials,
} from "./oauth.ts";
import { loadProjectServers } from "./project.ts";
import { type SearchCandidate, searchTools, truncateBytes } from "./search.ts";
import { createHttpTransport } from "./transport/http.ts";
import { createSseTransport } from "./transport/sse.ts";
import { spawnStdio } from "./transport/stdio.ts";
import type {
  McpRuntime,
  McpServerConfig,
  McpServerHealth,
  McpServerState,
  McpToolDef,
  TransportHandlers,
} from "./types.ts";

export type McpRuntimeDeps = {
  home: string;
  workspaceRoot: string;
  limits?: ResolvedLimits;
  openUrl(url: string): void | Promise<void>;
  askUser?: AskUser;
  interactive: boolean;
  env: Record<string, string | undefined>;
  now?: () => number;
  fetch?: typeof fetch;
  /** nod's version for clientInfo. */
  version?: string;
  /** Explicit server set (ACP); when absent, start() reads the profile and the project file. */
  servers?: McpServerConfig[];
  /** Tool names that MCP aliases must not shadow (the built-ins). */
  reservedNames?: Iterable<string>;
  onProgress?(server: string, message: string): void;
  /** Delay before a crashed stdio server is restarted, and between shutdown signals. */
  retryDelayMs?: number;
  graceMs?: number;
  authTimeoutMs?: number;
};

type Entry = {
  config: McpServerConfig;
  state: McpServerState;
  client?: McpClient;
  failure?: string;
  restarts: number;
  retryInMs?: number;
  catalog: Map<string, McpToolDef>;
  stale: boolean;
  counts: McpServerHealth["counts"];
  challenge?: AuthChallenge;
  connecting?: Promise<void>;
  closedByUs: boolean;
};

const redact = (text: string): string => text.replace(/https?:\/\/\S+/g, "<url>");
const message = (e: unknown): string => redact(e instanceof Error ? e.message : String(e));
const NOT_AVAILABLE = "tool no longer available";

export function createMcpRuntime(deps: McpRuntimeDeps): McpRuntime {
  const now = deps.now ?? Date.now;
  const fetcher = deps.fetch ?? fetch;
  const limits = {
    descriptionBytes: deps.limits?.mcp_description_bytes.bytes ?? DEFAULT_LIMITS.mcp_description_bytes,
    resultBytes: deps.limits?.mcp_search_result_bytes.bytes ?? DEFAULT_LIMITS.mcp_search_result_bytes,
    instructionsBytes: deps.limits?.mcp_server_instructions_bytes.bytes ?? DEFAULT_LIMITS.mcp_server_instructions_bytes,
    selectedSchemaBytes: deps.limits?.mcp_selected_schema_bytes.bytes ?? DEFAULT_LIMITS.mcp_selected_schema_bytes,
  };
  const names = createNameRegistry(deps.reservedNames ?? []);
  const selected = new Set<string>();
  let entries = new Map<string, Entry>();
  let diagnostics: string[] = [];
  let imageIds = 0;

  const authDeps = { fetch: fetcher, openUrl: deps.openUrl, env: deps.env, now, timeoutMs: deps.authTimeoutMs };

  function load(next?: McpServerConfig[]): { servers: McpServerConfig[]; diagnostics: string[] } {
    if (next) return { servers: next, diagnostics: [] };
    const profile = loadProfile(deps.home);
    const project = loadProjectServers({ home: deps.home, workspaceRoot: deps.workspaceRoot, env: deps.env });
    const out: string[] = [];
    if (profile.error) out.push(`MCP config error: ${profile.error}`);
    if (profile.warning) out.push(renderProfileWarning(profile.warning));
    out.push(...profile.issues, ...project.issues);
    return { servers: mergeServers(profile.servers, project.servers), diagnostics: out };
  }

  const initialState = (c: McpServerConfig): McpServerState =>
    !c.enabled
      ? "disabled"
      : c.admission === "pending"
        ? "pending"
        : c.admission === "rejected"
          ? "rejected"
          : "starting";
  const makeEntry = (config: McpServerConfig): Entry => ({
    config,
    state: initialState(config),
    restarts: 0,
    catalog: new Map(),
    stale: false,
    counts: {},
    closedByUs: false,
  });
  const connectable = (e: Entry) => e.state !== "disabled" && e.state !== "pending" && e.state !== "rejected";

  async function headersFor(entry: Entry): Promise<Record<string, string>> {
    const c = entry.config;
    const headers: Record<string, string> = { ...(c.headers ?? {}) };
    for (const [name, variable] of Object.entries(c.header_env ?? {})) {
      const value = deps.env[variable];
      if (value === undefined) throw new Error(`header_env ${name} requires environment variable '${variable}'`);
      headers[name] = value;
    }
    if (c.bearer_token_env) {
      const token = deps.env[c.bearer_token_env];
      if (token === undefined)
        throw new Error(`bearer_token_env requires environment variable '${c.bearer_token_env}'`);
      headers.authorization = `Bearer ${token}`;
      return headers;
    }
    let creds: McpCredentials | undefined = readCredentials(deps.home).entries[c.name];
    if (creds && needsRefresh(creds, now())) {
      creds = await refreshCredentials(creds, c, authDeps);
      storeCredentials(deps.home, c.name, creds);
    }
    if (creds) headers.authorization = `Bearer ${creds.access_token}`;
    return headers;
  }

  async function elicit(entry: Entry, request: ElicitationRequest): Promise<ElicitationResult> {
    if (!deps.askUser || !deps.interactive) return { action: "decline" };
    const prefix = `MCP server '${entry.config.name}'`;
    if (request.mode === "url") {
      const answer = await deps.askUser([
        {
          question: `${prefix} asks to open ${request.url ?? "a URL"}: ${request.message}`,
          options: [{ label: "Open" }, { label: "Decline" }],
        },
      ]);
      if (!answer) return { action: "cancel" };
      if (answer.answers[0]?.answer !== "Open") return { action: "decline" };
      if (request.url) await deps.openUrl(request.url);
      return { action: "accept" };
    }
    const props = Object.entries(request.requestedSchema?.properties ?? {});
    // ponytail: every property is one question; empty options means free text for the UI.
    const questions = props.map(([name, schema]) => ({
      question: `${prefix}: ${request.message} — ${typeof schema.title === "string" ? schema.title : name}${typeof schema.description === "string" ? ` (${schema.description})` : ""}`,
      options: Array.isArray(schema.enum)
        ? schema.enum.map((v) => ({ label: String(v) }))
        : schema.type === "boolean"
          ? [{ label: "true" }, { label: "false" }]
          : [],
    }));
    const answer = await deps.askUser(
      questions.length
        ? questions
        : [{ question: `${prefix}: ${request.message}`, options: [{ label: "Accept" }, { label: "Decline" }] }],
    );
    if (!answer) return { action: "cancel" };
    if (questions.length === 0) return { action: answer.answers[0]?.answer === "Accept" ? "accept" : "decline" };
    const content: Record<string, unknown> = {};
    props.forEach(([name, schema], i) => {
      const raw = answer.answers[i]?.answer;
      if (raw === undefined || raw === "") return;
      content[name] =
        schema.type === "number" || schema.type === "integer"
          ? Number(raw)
          : schema.type === "boolean"
            ? raw === "true"
            : raw;
    });
    return { action: "accept", content };
  }

  function openTransport(entry: Entry) {
    const c = entry.config;
    return (handlers: TransportHandlers) => {
      if (c.type === "stdio")
        return spawnStdio({
          ...handlers,
          command: c.command ?? [],
          env: { ...deps.env, ...(c.environment ?? {}) },
          cwd: deps.workspaceRoot,
          graceMs: deps.graceMs,
        });
      const remote = { ...handlers, url: c.url ?? "", headers: () => headersFor(entry), fetch: fetcher };
      return c.type === "sse" ? createSseTransport(remote) : createHttpTransport(remote);
    };
  }

  /** Runs one operation, answering 401/403 challenges with OAuth when the session is interactive. */
  async function withAuth<T>(entry: Entry, fn: () => Promise<T>): Promise<T> {
    let scopeRetries = 0;
    let unauthorized = 0;
    for (;;) {
      try {
        return await fn();
      } catch (e) {
        if (!(e instanceof McpAuthError)) throw e;
        entry.challenge = e.challenge;
        if (!deps.interactive || entry.config.bearer_token_env) {
          entry.state = "unauthenticated";
          throw new Error("authentication required");
        }
        if (e.status === 403 && (e.challenge.error !== "insufficient_scope" || scopeRetries++ >= MAX_SCOPE_RETRIES))
          throw e;
        if (e.status === 401 && unauthorized++ >= 1) {
          entry.state = "unauthenticated";
          throw new Error("authentication required");
        }
        storeCredentials(deps.home, entry.config.name, await authorize(entry.config, e.challenge, authDeps));
      }
    }
  }

  async function connect(entry: Entry): Promise<void> {
    if (entry.connecting) return entry.connecting;
    entry.connecting = (async () => {
      entry.state = "starting";
      entry.failure = undefined;
      entry.retryInMs = undefined;
      const deadline = new Promise<never>((_, reject) =>
        setTimeout(
          () => reject(new Error(`MCP server did not become ready within ${entry.config.startup_timeout_ms} ms`)),
          entry.config.startup_timeout_ms,
        ).unref?.(),
      );
      try {
        await Promise.race([
          withAuth(entry, async () => {
            const client = await connectClient({
              openTransport: openTransport(entry),
              operationTimeoutMs: entry.config.operation_timeout_ms,
              startupTimeoutMs: entry.config.startup_timeout_ms,
              version: deps.version ?? "0.0.0",
              instructionsBytes: limits.instructionsBytes,
              onListChanged: (kind) => {
                if (kind === "tools") entry.stale = true;
                else entry.counts = { ...entry.counts, [kind]: undefined };
              },
              onProgress: (p) =>
                deps.onProgress?.(entry.config.name, p.message ?? `${p.progress}${p.total ? `/${p.total}` : ""}`),
              onElicitation: (req) => elicit(entry, req),
              onClose: (reason) => void onClosed(entry, client, reason),
            });
            entry.client = client;
            await refreshCatalog(entry);
          }),
          deadline,
        ]);
        entry.state = "ready";
      } catch (e) {
        const tail = entry.client?.stderrTail() ?? [];
        if (entry.client) await entry.client.close().catch(() => {});
        entry.client = undefined;
        if ((entry.state as McpServerState) !== "unauthenticated") entry.state = "failed";
        entry.failure = message(e);
        if (tail.length) entry.failure += ` (stderr: ${redact(tail.slice(-3).join(" | "))})`;
      } finally {
        entry.connecting = undefined;
      }
    })();
    return entry.connecting;
  }

  async function onClosed(entry: Entry, client: McpClient, reason?: Error) {
    if (entry.client !== client || entry.closedByUs) return;
    entry.client = undefined;
    entry.catalog.clear();
    if (entry.config.type !== "stdio" || entry.restarts >= entry.config.restart_limit) {
      entry.state = "failed";
      entry.failure =
        entry.config.type === "stdio" ? "MCP restart limit reached" : message(reason ?? new Error("connection closed"));
      return;
    }
    entry.restarts++;
    entry.state = "starting";
    entry.retryInMs = deps.retryDelayMs ?? 500;
    entry.failure = message(reason ?? new Error("connection closed"));
    await new Promise((r) => setTimeout(r, entry.retryInMs));
    if (!entry.closedByUs) await connect(entry);
  }

  async function refreshCatalog(entry: Entry): Promise<void> {
    if (!entry.client) return;
    const { tools } = await entry.client.listTools();
    entry.catalog = new Map(tools.map((t) => [names.name(entry.config.name, t.name), t]));
    entry.counts = { ...entry.counts, tools: tools.length };
    entry.stale = false;
  }

  async function ensureFresh(entry: Entry) {
    if (entry.state === "ready" && entry.stale && entry.client) await refreshCatalog(entry).catch(() => {});
  }

  const ready = () => [...entries.values()].filter((e) => e.state === "ready" && e.client);

  function schemaText(entry: Entry, tool: McpToolDef): { description: string; inputSchema: Record<string, unknown> } {
    const instructions = entry.client?.instructions
      ? truncateBytes(entry.client.instructions, limits.instructionsBytes)
      : undefined;
    const description = `${truncateBytes(tool.description, limits.descriptionBytes)}${instructions ? `\n\nServer instructions: ${instructions}` : ""}`;
    return { description, inputSchema: tool.inputSchema };
  }

  function toolSpec(entry: Entry, alias: string, tool: McpToolDef): ToolSpec {
    const { description, inputSchema } = schemaText(entry, tool);
    return {
      name: alias,
      description,
      parameters: inputSchema,
      activity: "command",
      requiresApproval: true,
      permissionTarget: "none",
      decode: (args) => (isRecord(args) ? ok(args) : fail(`${alias} arguments must be a JSON object`)),
      targets: () => [{ permission: alias, target: "*", kind: "other" }],
      call: (input, ctx) => runtime.call(alias, input as Record<string, unknown>, ctx.signal),
      readsOnly: () => false,
      label: () => alias,
    };
  }

  function locate(alias: string): { entry: Entry; tool: McpToolDef } | undefined {
    const id = names.identity(alias);
    if (!id) return undefined;
    const entry = entries.get(id.server);
    const tool = entry?.catalog.get(alias);
    return entry && tool ? { entry, tool } : undefined;
  }

  const failure = (tool: string, msg: string): ToolResult => ({
    status: "failure",
    output: toolExecutionFailed(tool, msg),
  });

  async function connectAll(map: Map<string, Entry>, awaitOptional: boolean) {
    const targets = [...map.values()].filter(connectable);
    const required = targets.filter((e) => e.config.required).map(connect);
    const optional = targets.filter((e) => !e.config.required).map(connect);
    await Promise.all(required);
    if (awaitOptional) await Promise.all(optional);
  }

  const runtime: McpRuntime = {
    async start() {
      const loaded = load(deps.servers);
      diagnostics = loaded.diagnostics;
      entries = new Map(loaded.servers.map((c) => [c.name, makeEntry(c)]));
      await connectAll(entries, false);
      return { diagnostics };
    },
    async reload(next) {
      const loaded = load(next);
      const fresh = new Map(loaded.servers.map((c) => [c.name, makeEntry(c)]));
      const old = entries;
      for (const e of old.values()) if (e.state === "ready") e.state = "reloading";
      await connectAll(fresh, true);
      const requiredFailed = [...fresh.values()].filter((e) => e.config.required && e.state !== "ready");
      if (requiredFailed.length > 0) {
        for (const e of fresh.values()) {
          e.closedByUs = true;
          await e.client?.close().catch(() => {});
        }
        for (const e of old.values()) if (e.state === "reloading") e.state = "ready";
        return {
          ok: false,
          diagnostics: [
            ...loaded.diagnostics,
            ...requiredFailed.map((e) => `required MCP server '${e.config.name}' failed: ${e.failure ?? "unknown"}`),
          ],
        };
      }
      entries = fresh;
      diagnostics = loaded.diagnostics;
      for (const e of old.values()) {
        e.closedByUs = true;
        await e.client?.close().catch(() => {});
      }
      for (const alias of [...selected]) if (!locate(alias)) selected.delete(alias);
      return { ok: true, diagnostics };
    },
    health: () =>
      [...entries.values()].map((e) => ({
        name: e.config.name,
        transport: e.config.type,
        source: e.config.source,
        required: e.config.required,
        state: e.state,
        admission: e.config.admission,
        protocolVersion: e.client?.protocolVersion,
        serverName: e.client?.serverInfo.name,
        serverVersion: e.client?.serverInfo.version,
        counts: { ...e.counts },
        failure: e.failure,
        retryInMs: e.retryInMs,
        restarts: e.restarts,
      })),
    async settle() {
      await Promise.all([...entries.values()].map((e) => e.connecting));
    },
    diagnostics: () => [...diagnostics],
    server: (name) => entries.get(name)?.client,
    serverNames: () => [...entries.keys()],
    tools() {
      const out: ToolSpec[] = [];
      for (const alias of selected) {
        const hit = locate(alias);
        if (hit && hit.entry.state === "ready") out.push(toolSpec(hit.entry, alias, hit.tool));
      }
      return out;
    },
    async search(query, server) {
      const empty = { tools: [], count: 0, total_matches: 0, more_available: false, next_cursor: null };
      if (server !== undefined && !entries.has(server))
        return { text: JSON.stringify({ ...empty, state: "server_not_found" }), selected: [] };
      const mentioned = (e: Entry) =>
        e.config.name === server ||
        new RegExp(
          `(^|[^A-Za-z0-9_-])${e.config.name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^A-Za-z0-9_-])`,
          "i",
        ).test(query);
      for (const e of entries.values()) {
        if (!mentioned(e)) continue;
        if (e.state === "unauthenticated")
          return {
            text: JSON.stringify({
              tools: [],
              count: 0,
              authentication_required: {
                server: e.config.name,
                interactive: true,
                message: `Run /mcp auth ${e.config.name} --open in an interactive nod session.`,
              },
            }),
            selected: [],
          };
        if (e.state === "failed" && e.config.bearer_token_env && deps.env[e.config.bearer_token_env] === undefined)
          return {
            text: JSON.stringify({
              tools: [],
              count: 0,
              authentication_required: {
                server: e.config.name,
                interactive: false,
                environment: e.config.bearer_token_env,
                message: "Set this environment variable before starting nod.",
              },
            }),
            selected: [],
          };
      }
      const candidates: SearchCandidate[] = [];
      for (const e of ready()) {
        if (server !== undefined && e.config.name !== server) continue;
        await ensureFresh(e);
        for (const [alias, tool] of e.catalog)
          candidates.push({
            alias,
            server: e.config.name,
            tool,
            instructions: e.client?.instructions,
            schemaBytes: Buffer.byteLength(JSON.stringify(schemaText(e, tool))),
          });
      }
      const result = searchTools(query, candidates, limits);
      for (const alias of result.selected) selected.add(alias);
      return { text: result.output, selected: result.selected, notice: result.notice };
    },
    async select(name) {
      for (const e of ready()) await ensureFresh(e);
      const hit = locate(name);
      if (hit?.entry.state !== "ready")
        return { ok: false, error: names.identity(name) ? NOT_AVAILABLE : `Unknown MCP tool: ${name}` };
      const schema = schemaText(hit.entry, hit.tool);
      const bytes = Buffer.byteLength(JSON.stringify(schema));
      if (bytes > limits.selectedSchemaBytes)
        return {
          ok: false,
          error: JSON.stringify({
            context_limit_rejection: {
              name: "mcp_selected_schema_bytes",
              tool: name,
              action: "rejected",
              observed_bytes: bytes,
              effective_bytes: limits.selectedSchemaBytes,
              override: "--context-limit mcp_selected_schema_bytes=BYTES|off",
            },
          }),
        };
      selected.add(name);
      return { ok: true, text: JSON.stringify({ name, ...schema }) };
    },
    async features(request, signal) {
      const action = String(request.action);
      const entry = entries.get(String(request.server));
      if (!entry) return failure("mcp_features", `Unknown MCP server: ${String(request.server)}`);
      if (entry.state !== "ready" || !entry.client)
        return failure(
          "mcp_features",
          `MCP server '${entry.config.name}' is ${entry.state}${entry.failure ? `: ${entry.failure}` : ""}`,
        );
      const client = entry.client;
      const s = (key: string): string | undefined =>
        typeof request[key] === "string" ? (request[key] as string) : undefined;
      const stringMap = (key: string): Record<string, string> | undefined =>
        isRecord(request[key])
          ? Object.fromEntries(Object.entries(request[key] as Record<string, unknown>).map(([k, v]) => [k, String(v)]))
          : undefined;
      try {
        const body = await withAuth(entry, async () => {
          switch (action) {
            case "resource_list":
              return { resources: await client.listResources(signal) };
            case "resource_templates":
              return { templates: await client.listResourceTemplates(signal) };
            case "resource_read": {
              const uri = s("uri");
              if (!uri) throw new Error("resource_read requires uri");
              const contents = await client.readResource(uri, signal);
              return {
                uri,
                untrusted_external: true,
                contents: contents.map((c) => (c.type === "resource" ? c.resource : c)),
              };
            }
            case "prompt_list":
              return { prompts: await client.listPrompts(signal) };
            case "prompt_get": {
              const prompt = s("prompt");
              if (!prompt) throw new Error("prompt_get requires prompt");
              const got = await client.getPrompt(prompt, stringMap("arguments"), signal);
              return {
                prompt,
                untrusted_external: true,
                description: got.description,
                messages: got.messages.map((m) => ({ role: m.role, text: contentText([m.content]) })),
              };
            }
            case "prompt_complete":
            case "resource_complete": {
              const argument = s("argument");
              if (!argument) throw new Error(`${action} requires argument`);
              const ref =
                action === "prompt_complete"
                  ? { type: "ref/prompt" as const, name: s("prompt") ?? "" }
                  : { type: "ref/resource" as const, uri: s("uri_template") ?? "" };
              if (!("name" in ref ? ref.name : ref.uri))
                throw new Error(`${action} requires ${action === "prompt_complete" ? "prompt" : "uri_template"}`);
              return await client.complete(
                ref,
                { name: argument, value: s("value") ?? "" },
                stringMap("context"),
                signal,
              );
            }
            default:
              throw new Error(`unsupported action ${action}`);
          }
        });
        return { status: "success", output: JSON.stringify({ server: entry.config.name, ...body }) };
      } catch (e) {
        if (isAbortError(e)) throw e;
        return failure("mcp_features", message(e));
      }
    },
    async call(alias, args, signal) {
      const hit = locate(alias);
      if (hit?.entry.state !== "ready") return failure(alias, NOT_AVAILABLE);
      const { entry, tool } = hit;
      const client = entry.client;
      if (!client) return failure(alias, NOT_AVAILABLE);
      try {
        const result = await withAuth(entry, () => client.callTool(tool.name, args, signal));
        const text = [
          contentText(result.content),
          result.structuredContent !== undefined ? JSON.stringify(result.structuredContent) : "",
        ]
          .filter(Boolean)
          .join("\n");
        const images = result.content
          .filter((c): c is Extract<typeof c, { type: "image" }> => c.type === "image")
          .map((c) => ({ id: ++imageIds, mime: c.mimeType, data: c.data }));
        if (result.isError)
          return { status: "failure", output: toolExecutionFailed(alias, text || "MCP tool reported an error") };
        return { status: "success", output: text, ...(images.length ? { images } : {}) };
      } catch (e) {
        if (isAbortError(e)) throw e;
        return failure(alias, message(e));
      }
    },
    async close() {
      for (const e of entries.values()) {
        e.closedByUs = true;
        await e.client?.close().catch(() => {});
      }
    },
  };
  return runtime;
}

/** Interactive `/mcp auth`: runs the OAuth flow for one configured remote server and reconnects it. */
export async function authenticateServer(runtime: McpRuntime, name: string, deps: McpRuntimeDeps): Promise<void> {
  const health = runtime.health().find((h) => h.name === name);
  if (!health) throw new Error(`MCP server '${name}' not found`);
  const config = [
    ...loadProfile(deps.home).servers,
    ...loadProjectServers({ home: deps.home, workspaceRoot: deps.workspaceRoot, env: deps.env }).servers,
  ].find((c) => c.name === name);
  if (!config?.url) throw new Error(`MCP server '${name}' is not a remote server`);
  const creds = await authorize(
    config,
    {},
    {
      fetch: deps.fetch ?? fetch,
      openUrl: deps.openUrl,
      env: deps.env,
      now: deps.now ?? Date.now,
      timeoutMs: deps.authTimeoutMs,
    },
  );
  storeCredentials(deps.home, name, creds);
  await runtime.reload();
}

/** `/mcp logout`: drops stored credentials, tries remote revocation, purges malformed entries. */
export async function logoutServer(
  home: string,
  name: string,
  fetcher: typeof fetch = fetch,
): Promise<{ found: boolean; revoked: boolean; purged: number }> {
  const { entries } = readCredentials(home);
  const creds = entries[name];
  if (!creds) return { found: false, revoked: false, purged: 0 };
  const revoked = await revokeCredentials(creds, { fetch: fetcher });
  return { found: true, revoked, purged: storeCredentials(home, name, undefined) };
}
