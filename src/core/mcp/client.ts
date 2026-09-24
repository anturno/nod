/** One connected MCP server: initialize negotiation, tools/resources/prompts/completions, server requests. */
import { abortError, createJsonRpcPeer, type JsonRpcPeer, JsonRpcRemoteError } from "./jsonrpc.ts";
import { MAX_CURSOR_BYTES, MAX_LIST_PAGES, MAX_SCHEMA_DEPTH, PROTOCOL_VERSIONS } from "./limits.ts";
import { McpSessionLostError } from "./transport/http.ts";
import type { McpContent, McpToolCallResult, McpToolDef, McpTransport, TransportHandlers } from "./types.ts";

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const UNSUPPORTED_VERSION = -32022;

export type ElicitationRequest = {
  message: string;
  mode: "form" | "url";
  url?: string;
  requestedSchema?: { properties: Record<string, Record<string, unknown>>; required: string[] };
};
export type ElicitationResult = { action: "accept" | "decline" | "cancel"; content?: Record<string, unknown> };

export type ProgressEvent = { progressToken: number | string; progress: number; total?: number; message?: string };

export type ConnectOptions = {
  openTransport(handlers: TransportHandlers): McpTransport & { connect?(): Promise<void> };
  operationTimeoutMs: number;
  startupTimeoutMs: number;
  /** nod's version for clientInfo. */
  version: string;
  instructionsBytes?: number;
  onListChanged?(kind: "tools" | "resources" | "prompts"): void;
  onProgress?(event: ProgressEvent): void;
  onElicitation?(request: ElicitationRequest): Promise<ElicitationResult>;
  onClose?(reason?: Error): void;
};

export type ServerCapabilities = {
  tools?: { listChanged?: boolean };
  resources?: { listChanged?: boolean; subscribe?: boolean };
  prompts?: { listChanged?: boolean };
  completions?: Record<string, unknown>;
};

export type McpResource = { uri: string; name: string; title?: string; description?: string; mimeType?: string };
export type McpResourceTemplate = {
  uriTemplate: string;
  name: string;
  title?: string;
  description?: string;
  mimeType?: string;
};
export type McpPrompt = {
  name: string;
  title?: string;
  description?: string;
  arguments?: { name: string; description?: string; required?: boolean }[];
};
export type McpPromptMessage = { role: string; content: McpContent };
export type CompletionRef = { type: "ref/prompt"; name: string } | { type: "ref/resource"; uri: string };

export type McpClient = {
  protocolVersion: string;
  serverInfo: { name: string; version: string };
  capabilities: ServerCapabilities;
  instructions?: string;
  /** True when the server sent notifications/tools/list_changed since the last listTools. */
  listTools(signal?: AbortSignal): Promise<{ tools: McpToolDef[]; rejected: number }>;
  callTool(name: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<McpToolCallResult>;
  listResources(signal?: AbortSignal): Promise<McpResource[]>;
  listResourceTemplates(signal?: AbortSignal): Promise<McpResourceTemplate[]>;
  readResource(uri: string, signal?: AbortSignal): Promise<McpContent[]>;
  listPrompts(signal?: AbortSignal): Promise<McpPrompt[]>;
  getPrompt(
    name: string,
    args?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ description?: string; messages: McpPromptMessage[] }>;
  complete(
    ref: CompletionRef,
    argument: { name: string; value: string },
    context?: Record<string, string>,
    signal?: AbortSignal,
  ): Promise<{ values: string[]; total?: number; hasMore?: boolean }>;
  ping(signal?: AbortSignal): Promise<void>;
  stderrTail(): string[];
  close(): Promise<void>;
};

/** Object schemas only, nested at most 64 levels. */
export function validateToolDef(raw: unknown): McpToolDef | undefined {
  if (!isObject(raw) || typeof raw.name !== "string" || raw.name.length === 0) return undefined;
  const schema = raw.inputSchema;
  if (!isObject(schema) || schema.type !== "object") return undefined;
  const depth = (v: unknown, d: number): boolean => {
    if (d > MAX_SCHEMA_DEPTH) return false;
    if (Array.isArray(v)) return v.every((x) => depth(x, d + 1));
    if (isObject(v)) return Object.values(v).every((x) => depth(x, d + 1));
    return true;
  };
  if (!depth(schema, 1)) return undefined;
  return {
    name: raw.name,
    title: typeof raw.title === "string" ? raw.title : undefined,
    description: typeof raw.description === "string" ? raw.description : "",
    inputSchema: schema,
  };
}

function parseContent(raw: unknown): McpContent[] {
  if (!Array.isArray(raw)) return [];
  const out: McpContent[] = [];
  for (const item of raw) {
    if (!isObject(item)) continue;
    if (item.type === "text" && typeof item.text === "string") out.push({ type: "text", text: item.text });
    else if (
      (item.type === "image" || item.type === "audio") &&
      typeof item.data === "string" &&
      typeof item.mimeType === "string"
    )
      out.push({ type: item.type, data: item.data, mimeType: item.mimeType });
    else if (item.type === "resource" && isObject(item.resource) && typeof item.resource.uri === "string")
      out.push({
        type: "resource",
        resource: {
          uri: item.resource.uri,
          text: typeof item.resource.text === "string" ? item.resource.text : undefined,
          blob: typeof item.resource.blob === "string" ? item.resource.blob : undefined,
          mimeType: typeof item.resource.mimeType === "string" ? item.resource.mimeType : undefined,
        },
      });
    else if (item.type === "resource_link" && typeof item.uri === "string")
      out.push({
        type: "resource_link",
        uri: item.uri,
        name: typeof item.name === "string" ? item.name : undefined,
        description: typeof item.description === "string" ? item.description : undefined,
        mimeType: typeof item.mimeType === "string" ? item.mimeType : undefined,
      });
  }
  return out;
}

/** Text the model sees for a content list: text blocks, resource text, links; images are attachments. */
export function contentText(content: McpContent[]): string {
  const parts: string[] = [];
  for (const c of content) {
    if (c.type === "text") parts.push(c.text);
    else if (c.type === "resource")
      parts.push(c.resource.text ?? `<resource uri="${c.resource.uri}" mimeType="${c.resource.mimeType ?? ""}" blob/>`);
    else if (c.type === "resource_link")
      parts.push(`<resource_link uri="${c.uri}"${c.name ? ` name="${c.name}"` : ""}/>`);
    else if (c.type === "image") parts.push(`<image mimeType="${c.mimeType}"/>`);
    else parts.push(`<audio mimeType="${c.mimeType}"/>`);
  }
  return parts.join("\n");
}

const str = (v: unknown, fallback = ""): string => (typeof v === "string" ? v : fallback);
const opt = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export async function connectClient(o: ConnectOptions): Promise<McpClient> {
  let peer!: JsonRpcPeer;
  let closed = false;
  const transport = o.openTransport({
    onMessage: (m) => peer.receive(m),
    onClose: (reason) => {
      peer.fail(reason ?? new Error("MCP transport closed"));
      if (!closed) o.onClose?.(reason);
      closed = true;
    },
  });
  peer = createJsonRpcPeer({
    send: (m) => transport.send(m),
    defaultTimeoutMs: o.operationTimeoutMs,
    onNotification(method, params) {
      if (method === "notifications/tools/list_changed") o.onListChanged?.("tools");
      else if (method === "notifications/resources/list_changed") o.onListChanged?.("resources");
      else if (method === "notifications/prompts/list_changed") o.onListChanged?.("prompts");
      else if (method === "notifications/progress" && isObject(params) && typeof params.progress === "number")
        o.onProgress?.({
          progressToken: (typeof params.progressToken === "string" || typeof params.progressToken === "number"
            ? params.progressToken
            : "") as string,
          progress: params.progress,
          total: typeof params.total === "number" ? params.total : undefined,
          message: opt(params.message),
        });
    },
    async onRequest(method, params) {
      if (method === "ping") return {};
      if (method === "elicitation/create") {
        if (!o.onElicitation) throw new JsonRpcRemoteError(-32601, "elicitation is unavailable in this session");
        const p = isObject(params) ? params : {};
        const mode = p.mode === "url" || typeof p.url === "string" ? "url" : "form";
        const schema = isObject(p.requestedSchema) ? p.requestedSchema : undefined;
        return o.onElicitation({
          message: str(p.message),
          mode,
          url: opt(p.url),
          requestedSchema: schema
            ? {
                properties: isObject(schema.properties)
                  ? (schema.properties as Record<string, Record<string, unknown>>)
                  : {},
                required: Array.isArray(schema.required)
                  ? schema.required.filter((r): r is string => typeof r === "string")
                  : [],
              }
            : undefined,
        });
      }
      throw new JsonRpcRemoteError(-32601, `Method not found: ${method}`);
    },
  });

  const startup = { timeoutMs: o.startupTimeoutMs };
  const initialize = async (version: string) =>
    peer.request(
      "initialize",
      {
        protocolVersion: version,
        capabilities: { elicitation: { form: {} } },
        clientInfo: { name: "nod", version: o.version },
      },
      startup,
    );

  let negotiated: string | undefined;
  let init: Record<string, unknown> = {};
  try {
    if (transport.connect) await transport.connect();
    for (const version of PROTOCOL_VERSIONS) {
      let result: unknown;
      try {
        result = await initialize(version);
      } catch (e) {
        if (e instanceof JsonRpcRemoteError && e.code === UNSUPPORTED_VERSION) {
          transport.resetSession?.();
          continue;
        }
        throw e;
      }
      const offered = isObject(result) ? result.protocolVersion : undefined;
      if (typeof offered === "string" && (PROTOCOL_VERSIONS as readonly string[]).includes(offered)) {
        negotiated = offered;
        init = result as Record<string, unknown>;
        break;
      }
      transport.resetSession?.();
    }
    if (!negotiated) throw new Error("MCP server offered no supported protocol version");
    transport.setProtocolVersion?.(negotiated);
    await peer.notify("notifications/initialized");
  } catch (e) {
    closed = true;
    await transport.close().catch(() => {});
    throw e;
  }

  const serverInfo = isObject(init.serverInfo) ? init.serverInfo : {};
  const instructions = opt(init.instructions);
  const cap = o.instructionsBytes ?? 2048;
  const client: McpClient = {
    protocolVersion: negotiated,
    serverInfo: { name: str(serverInfo.name, "unknown"), version: str(serverInfo.version, "unknown") },
    capabilities: isObject(init.capabilities) ? (init.capabilities as ServerCapabilities) : {},
    instructions: instructions === undefined ? undefined : Buffer.from(instructions).subarray(0, cap).toString(),
    async listTools(signal) {
      const items = await paginate("tools/list", {}, "tools", signal);
      const tools: McpToolDef[] = [];
      let rejected = 0;
      for (const raw of items) {
        const tool = validateToolDef(raw);
        if (tool) tools.push(tool);
        else rejected++;
      }
      return { tools, rejected };
    },
    async callTool(name, args, signal) {
      const progressToken = ++progressCounter;
      const result = await request("tools/call", { name, arguments: args, _meta: { progressToken } }, signal);
      const r = isObject(result) ? result : {};
      return { content: parseContent(r.content), structuredContent: r.structuredContent, isError: r.isError === true };
    },
    listResources: async (signal) =>
      (await paginate("resources/list", {}, "resources", signal))
        .filter((r): r is Record<string, unknown> => isObject(r) && typeof r.uri === "string")
        .map((r) => ({
          uri: r.uri as string,
          name: str(r.name, r.uri as string),
          title: opt(r.title),
          description: opt(r.description),
          mimeType: opt(r.mimeType),
        })),
    listResourceTemplates: async (signal) =>
      (await paginate("resources/templates/list", {}, "resourceTemplates", signal))
        .filter((r): r is Record<string, unknown> => isObject(r) && typeof r.uriTemplate === "string")
        .map((r) => ({
          uriTemplate: r.uriTemplate as string,
          name: str(r.name, r.uriTemplate as string),
          title: opt(r.title),
          description: opt(r.description),
          mimeType: opt(r.mimeType),
        })),
    async readResource(uri, signal) {
      const result = await request("resources/read", { uri }, signal);
      const contents = isObject(result) && Array.isArray(result.contents) ? result.contents : [];
      return parseContent(contents.map((c) => ({ type: "resource", resource: c })));
    },
    listPrompts: async (signal) =>
      (await paginate("prompts/list", {}, "prompts", signal))
        .filter((p): p is Record<string, unknown> => isObject(p) && typeof p.name === "string")
        .map((p) => ({
          name: p.name as string,
          title: opt(p.title),
          description: opt(p.description),
          arguments: Array.isArray(p.arguments)
            ? p.arguments
                .filter((a): a is Record<string, unknown> => isObject(a) && typeof a.name === "string")
                .map((a) => ({
                  name: a.name as string,
                  description: opt(a.description),
                  required: a.required === true,
                }))
            : undefined,
        })),
    async getPrompt(name, args, signal) {
      const result = await request("prompts/get", { name, ...(args ? { arguments: args } : {}) }, signal);
      const r = isObject(result) ? result : {};
      const messages = Array.isArray(r.messages)
        ? r.messages
            .filter((m): m is Record<string, unknown> => isObject(m) && isObject(m.content))
            .map((m) => ({ role: str(m.role, "user"), content: parseContent([m.content])[0] as McpContent }))
            .filter((m) => m.content !== undefined)
        : [];
      return { description: opt(r.description), messages };
    },
    async complete(ref, argument, context, signal) {
      const result = await request(
        "completion/complete",
        { ref, argument, ...(context ? { context: { arguments: context } } : {}) },
        signal,
      );
      const completion = isObject(result) && isObject(result.completion) ? result.completion : {};
      return {
        values: Array.isArray(completion.values)
          ? completion.values.filter((v): v is string => typeof v === "string")
          : [],
        total: typeof completion.total === "number" ? completion.total : undefined,
        hasMore: typeof completion.hasMore === "boolean" ? completion.hasMore : undefined,
      };
    },
    async ping(signal) {
      await request("ping", undefined, signal);
    },
    stderrTail: () => transport.stderrTail?.() ?? [],
    async close() {
      if (closed) return;
      closed = true;
      peer.fail(abortError());
      await transport.close().catch(() => {});
    },
  };

  let progressCounter = 0;
  let reinitializing = false;

  /** A lost streamable-HTTP session is re-initialized once, then the request is retried. */
  async function request(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    try {
      return await peer.request(method, params, { signal });
    } catch (e) {
      if (!(e instanceof McpSessionLostError) || reinitializing || !transport.resetSession) throw e;
      reinitializing = true;
      try {
        transport.resetSession();
        await initialize(negotiated as string);
        await peer.notify("notifications/initialized");
      } finally {
        reinitializing = false;
      }
      return peer.request(method, params, { signal });
    }
  }

  async function paginate(
    method: string,
    params: Record<string, unknown>,
    key: string,
    signal?: AbortSignal,
  ): Promise<unknown[]> {
    const items: unknown[] = [];
    const seen = new Set<string>();
    let cursor: string | undefined;
    for (let page = 0; ; page++) {
      if (page >= MAX_LIST_PAGES) throw new Error(`MCP ${method} exceeded ${MAX_LIST_PAGES} pages`);
      const result = await request(method, cursor === undefined ? params : { ...params, cursor }, signal);
      const r = isObject(result) ? result : {};
      if (Array.isArray(r[key])) items.push(...(r[key] as unknown[]));
      const next = r.nextCursor;
      if (next === undefined || next === null) return items;
      if (typeof next !== "string" || Buffer.byteLength(next) > MAX_CURSOR_BYTES)
        throw new Error(`MCP ${method} returned an invalid cursor`);
      if (seen.has(next)) throw new Error(`MCP ${method} repeated a cursor`);
      seen.add(next);
      cursor = next;
    }
  }

  return client;
}
