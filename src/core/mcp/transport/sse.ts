/** Legacy HTTP+SSE (2024-11-05): a GET stream whose first `endpoint` event names where to POST. */
import { type JsonRpcMessage, validateMessage } from "../jsonrpc.ts";
import { McpAuthError, parseWwwAuthenticate } from "../oauth.ts";
import type { McpTransport, TransportHandlers } from "../types.ts";
import { createSseParser } from "./sse-parser.ts";

export type SseOptions = TransportHandlers & {
  url: string;
  headers(): Promise<Record<string, string>>;
  fetch: typeof fetch;
};

export type SseTransport = McpTransport & { connect(): Promise<void> };

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

export function createSseTransport(o: SseOptions): SseTransport {
  const abort = new AbortController();
  let endpoint: string | undefined;
  let closed = false;
  let resolveEndpoint!: () => void;
  let rejectEndpoint!: (e: Error) => void;
  const ready = new Promise<void>((res, rej) => ((resolveEndpoint = res), (rejectEndpoint = rej)));
  ready.catch(() => {});

  const handleEvent = (event: string, data: string) => {
    if (event === "endpoint") {
      const target = new URL(data, o.url);
      if (target.origin !== new URL(o.url).origin)
        return rejectEndpoint(new Error("MCP SSE endpoint must share the server origin"));
      endpoint = target.toString();
      return resolveEndpoint();
    }
    if (event !== "message") return;
    try {
      const parsed: unknown = JSON.parse(data);
      for (const item of Array.isArray(parsed) ? parsed : [parsed])
        if (isObject(item)) o.onMessage(validateMessage(item));
    } catch {
      // Ignore malformed events.
    }
  };

  const pump = async () => {
    let res: Response;
    try {
      res = await o.fetch(o.url, {
        method: "GET",
        headers: { ...(await o.headers()), accept: "text/event-stream" },
        signal: abort.signal,
      });
    } catch (e) {
      const err = e instanceof Error ? e : new Error(String(e));
      rejectEndpoint(err);
      return o.onClose(closed ? undefined : err);
    }
    if (res.status === 401 || res.status === 403) {
      const err = new McpAuthError(res.status, parseWwwAuthenticate(res.headers.get("www-authenticate")));
      rejectEndpoint(err);
      return o.onClose(err);
    }
    if (!res.ok || !res.body) {
      const err = new Error(`MCP SSE connection failed with status ${res.status}`);
      rejectEndpoint(err);
      return o.onClose(err);
    }
    const parser = createSseParser();
    const decoder = new TextDecoder();
    try {
      for await (const chunk of res.body)
        for (const e of parser.feed(decoder.decode(chunk, { stream: true }))) handleEvent(e.event, e.data);
      for (const e of parser.end()) handleEvent(e.event, e.data);
    } catch (e) {
      if (!closed) return o.onClose(e instanceof Error ? e : new Error(String(e)));
    }
    rejectEndpoint(new Error("MCP SSE stream ended before the endpoint event"));
    o.onClose(closed ? undefined : new Error("MCP SSE stream ended"));
  };

  return {
    connect() {
      void pump();
      return ready;
    },
    async send(message: JsonRpcMessage) {
      await ready;
      if (closed || !endpoint) throw new Error("MCP transport closed");
      const res = await o.fetch(endpoint, {
        method: "POST",
        headers: {
          ...(await o.headers()),
          "content-type": "application/json",
          accept: "application/json, text/event-stream",
        },
        body: JSON.stringify(message),
      });
      if (res.status === 401 || res.status === 403)
        throw new McpAuthError(res.status, parseWwwAuthenticate(res.headers.get("www-authenticate")));
      if (!res.ok) throw new Error(`MCP HTTP request failed with status ${res.status}`);
      const type = (res.headers.get("content-type") ?? "").toLowerCase();
      if (type.includes("application/json")) {
        const json: unknown = await res.json().catch(() => undefined);
        for (const item of Array.isArray(json) ? json : [json])
          if (isObject(item) && item.jsonrpc === "2.0") o.onMessage(validateMessage(item));
        return;
      }
      await res.body?.cancel().catch(() => {});
    },
    async close() {
      closed = true;
      abort.abort();
    },
  };
}
