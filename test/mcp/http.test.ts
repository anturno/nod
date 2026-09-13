import { afterAll, describe, expect, test } from "bun:test";
import { connectClient } from "../../src/core/mcp/client.ts";
import type { JsonRpcMessage } from "../../src/core/mcp/jsonrpc.ts";
import { McpAuthError } from "../../src/core/mcp/oauth.ts";
import { createHttpTransport, McpSessionLostError } from "../../src/core/mcp/transport/http.ts";

const state = {
  sessions: 0,
  valid: new Set<string>(),
  sseTerminator: "\n",
  invalidateAfterInit: false,
  inits: 0,
  lastHeaders: {} as Record<string, string | null>,
};
const init = (id: number) => ({
  jsonrpc: "2.0",
  id,
  result: { protocolVersion: "2025-11-25", capabilities: {}, serverInfo: { name: "http", version: "1" } },
});
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/protected")
      return new Response("no", {
        status: 401,
        headers: {
          "www-authenticate":
            'Bearer realm="x", resource_metadata="http://127.0.0.1/.well-known/oauth-protected-resource", scope="a b"',
        },
      });
    if (url.pathname === "/scope")
      return new Response("no", {
        status: 403,
        headers: { "www-authenticate": 'Bearer error="insufficient_scope", scope=tools.write' },
      });
    if (url.pathname === "/boom") return new Response("err", { status: 500 });
    const m = (await req.json()) as JsonRpcMessage;
    state.lastHeaders = {
      accept: req.headers.get("accept"),
      version: req.headers.get("mcp-protocol-version"),
      session: req.headers.get("mcp-session-id"),
      key: req.headers.get("x-key"),
    };
    if (m.method === "initialize") {
      state.inits++;
      const session = `s${++state.sessions}`;
      state.valid.add(session);
      return Response.json(init(m.id as number), { headers: { "mcp-session-id": session } });
    }
    if (m.id === undefined) {
      if (m.method === "notifications/initialized" && state.invalidateAfterInit) {
        state.valid.clear();
        state.invalidateAfterInit = false;
      }
      return new Response(null, { status: 202 });
    }
    const session = req.headers.get("mcp-session-id") ?? "";
    if (!state.valid.has(session))
      return Response.json({
        jsonrpc: "2.0",
        id: m.id,
        error: { code: -32000, message: "Bad Request: Mcp-Session-Id header is required" },
      });
    if (m.method === "tools/list")
      return Response.json({
        jsonrpc: "2.0",
        id: m.id,
        result: { tools: [{ name: "t", inputSchema: { type: "object" } }] },
      });
    if (m.method === "tools/call") {
      const t = state.sseTerminator;
      const body = [
        `event: message${t}data: ${JSON.stringify({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: 1, progress: 1 } })}${t}${t}`,
        `data: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { content: [{ type: "text", text: "called" }] } })}${t}${t}`,
      ].join("");
      return new Response(body, { headers: { "content-type": "text/event-stream" } });
    }
    return Response.json({ jsonrpc: "2.0", id: m.id, result: {} });
  },
});
afterAll(() => server.stop(true));
const base = `http://127.0.0.1:${server.port}`;

const connect = (path = "/mcp", onProgress?: () => void) =>
  connectClient({
    openTransport: (h) =>
      createHttpTransport({ ...h, url: `${base}${path}`, headers: async () => ({ "x-key": "k" }), fetch }),
    operationTimeoutMs: 2000,
    startupTimeoutMs: 2000,
    version: "t",
    onProgress,
  });

describe("streamable http transport", () => {
  test("carries headers, the session id, the negotiated version, and reads JSON and SSE replies", async () => {
    for (const terminator of ["\n", "\r\n", "\r"]) {
      state.sseTerminator = terminator;
      let progress = 0;
      const c = await connect("/mcp", () => void progress++);
      expect(state.lastHeaders.accept).toBe("application/json, text/event-stream");
      expect((await c.listTools()).tools[0]?.name).toBe("t");
      expect(state.lastHeaders.session).toBe(`s${state.sessions}`);
      expect(state.lastHeaders.version).toBe("2025-11-25");
      expect(state.lastHeaders.key).toBe("k");
      const r = await c.callTool("t", {});
      expect(r.content).toEqual([{ type: "text", text: "called" }]);
      expect(progress).toBe(1);
      await c.close();
    }
  });

  test("re-initializes once when the session is lost", async () => {
    state.invalidateAfterInit = true;
    const before = state.inits;
    const c = await connect();
    expect((await c.listTools()).tools.length).toBe(1);
    expect(state.inits - before).toBe(2);
    expect(state.lastHeaders.session).toBe(`s${state.sessions}`);
    await c.close();
  });

  test("401 and 403 become auth errors with the parsed challenge; other failures are plain errors", async () => {
    const t = createHttpTransport({
      url: `${base}/protected`,
      headers: async () => ({}),
      fetch,
      onMessage() {},
      onClose() {},
    });
    const e = (await t.send({ jsonrpc: "2.0", id: 1, method: "initialize" }).catch((x) => x)) as McpAuthError;
    expect(e).toBeInstanceOf(McpAuthError);
    expect(e.status).toBe(401);
    expect(e.challenge).toEqual({
      resource_metadata: "http://127.0.0.1/.well-known/oauth-protected-resource",
      scope: "a b",
    });
    const s = createHttpTransport({
      url: `${base}/scope`,
      headers: async () => ({}),
      fetch,
      onMessage() {},
      onClose() {},
    });
    const f = (await s.send({ jsonrpc: "2.0", id: 1, method: "x" }).catch((x) => x)) as McpAuthError;
    expect(f.status).toBe(403);
    expect(f.challenge).toEqual({ error: "insufficient_scope", scope: "tools.write" });
    const b = createHttpTransport({
      url: `${base}/boom`,
      headers: async () => ({}),
      fetch,
      onMessage() {},
      onClose() {},
    });
    await expect(b.send({ jsonrpc: "2.0", id: 1, method: "x" })).rejects.toThrow("status 500");
    await expect(connect("/protected")).rejects.toThrow("requires authentication");
    expect(new McpSessionLostError("x")).toBeInstanceOf(Error);
  });
});
