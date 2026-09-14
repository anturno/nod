/** Streamable HTTP (2025-03-26+): one POST per message; JSON or SSE replies; sessions; 401/403 become auth errors. */
import { type JsonRpcMessage, validateMessage } from "../jsonrpc.ts";
import { MAX_SSE_EVENTS } from "../limits.ts";
import { McpAuthError, parseWwwAuthenticate } from "../oauth.ts";
import type { McpTransport, TransportHandlers } from "../types.ts";
import { createSseParser } from "./sse-parser.ts";

export class McpSessionLostError extends Error {}

export type HttpOptions = TransportHandlers & {
  url: string;
  headers(): Promise<Record<string, string>>;
  fetch: typeof fetch;
};

export type HttpTransport = McpTransport & { sessionId(): string | undefined };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** `-32000`/`-32600` "Mcp-Session-Id required" errors mean the session expired server-side. */
export const isSessionLost = (m: JsonRpcMessage): boolean =>
  !!m.error && (m.error.code === -32000 || m.error.code === -32600) && /mcp-session-id/i.test(m.error.message);

/** Reads every `data:` event of an SSE body as a JSON-RPC message. */
export async function readSseMessages(
  body: ReadableStream<Uint8Array> | null,
  onMessage: (m: JsonRpcMessage) => void,
): Promise<void> {
  if (!body) return;
  const parser = createSseParser();
  const decoder = new TextDecoder();
  let events = 0;
  const handle = (data: string) => {
    if (++events > MAX_SSE_EVENTS) throw new Error("MCP SSE response exceeded the event limit");
    let parsed: unknown;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    for (const item of Array.isArray(parsed) ? parsed : [parsed]) onMessage(validateMessage(item));
  };
  for await (const chunk of body) for (const e of parser.feed(decoder.decode(chunk, { stream: true }))) handle(e.data);
  for (const e of parser.end()) handle(e.data);
}

export function createHttpTransport(o: HttpOptions): HttpTransport {
  let session: string | undefined;
  let protocolVersion: string | undefined;
  let closed = false;

  const deliver = (m: JsonRpcMessage) => {
    if (isSessionLost(m)) throw new McpSessionLostError(m.error?.message ?? "Mcp-Session-Id required");
    o.onMessage(m);
  };

  return {
    sessionId: () => session,
    setProtocolVersion: (v) => void (protocolVersion = v),
    resetSession: () => void (session = undefined),
    async send(message) {
      if (closed) throw new Error("MCP transport closed");
      const headers: Record<string, string> = {
        ...(await o.headers()),
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      };
      if (protocolVersion) headers["mcp-protocol-version"] = protocolVersion;
      if (session) headers["mcp-session-id"] = session;
      const res = await o.fetch(o.url, { method: "POST", headers, body: JSON.stringify(message) });
      const newSession = res.headers.get("mcp-session-id");
      if (newSession) session = newSession;
      if (res.status === 401 || res.status === 403) {
        await res.body?.cancel().catch(() => {});
        throw new McpAuthError(res.status, parseWwwAuthenticate(res.headers.get("www-authenticate")));
      }
      if (res.status === 404 && session && message.method !== "initialize") {
        await res.body?.cancel().catch(() => {});
        throw new McpSessionLostError("Mcp-Session-Id no longer valid");
      }
      if (res.status === 202 || res.status === 204) {
        await res.body?.cancel().catch(() => {});
        return;
      }
      if (!res.ok) {
        await res.body?.cancel().catch(() => {});
        throw new Error(`MCP HTTP request failed with status ${res.status}`);
      }
      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      if (type.includes("text/event-stream")) return readSseMessages(res.body, deliver);
      if (type.includes("application/json")) {
        const json: unknown = await res.json();
        for (const item of Array.isArray(json) ? json : [json]) if (isObject(item)) deliver(validateMessage(item));
        return;
      }
      await res.body?.cancel().catch(() => {});
    },
    async close() {
      closed = true;
      // ponytail: no DELETE to end the session; servers expire idle sessions on their own.
      o.onClose();
    },
  };
}
