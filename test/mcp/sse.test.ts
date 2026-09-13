import { afterAll, describe, expect, test } from "bun:test";
import { connectClient } from "../../src/core/mcp/client.ts";
import { createSseTransport } from "../../src/core/mcp/transport/sse.ts";

const seen: string[] = [];
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    if (req.method === "GET" && url.pathname === "/sse") {
      seen.push(`auth=${req.headers.get("x-key")}`);
      const stream = new ReadableStream({
        start(controller) {
          controller.enqueue(`event: endpoint\r\ndata: /messages?session=1\r\n\r\n`);
          sseController = controller;
        },
      });
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    }
    if (req.method === "POST" && url.pathname === "/messages") {
      const m = (await req.json()) as { id?: number; method: string };
      if (m.method === "initialize")
        sseController?.enqueue(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { protocolVersion: "2024-11-05", capabilities: {}, serverInfo: { name: "legacy", version: "0" } } })}\n\n`,
        );
      else if (m.id !== undefined)
        sseController?.enqueue(
          `event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [] } })}\n\n`,
        );
      return new Response(null, { status: 202 });
    }
    if (url.pathname === "/other")
      return new Response(`event: endpoint\ndata: https://evil.example/x\n\n`, {
        headers: { "content-type": "text/event-stream" },
      });
    return new Response("nope", { status: 404 });
  },
});
let sseController: ReadableStreamDefaultController<string> | undefined;
afterAll(() => server.stop(true));

describe("legacy http+sse transport", () => {
  test("POSTs to the endpoint event and reads responses from the stream", async () => {
    const c = await connectClient({
      openTransport: (h) =>
        createSseTransport({
          ...h,
          url: `http://127.0.0.1:${server.port}/sse`,
          headers: async () => ({ "x-key": "k" }),
          fetch,
        }),
      operationTimeoutMs: 2000,
      startupTimeoutMs: 2000,
      version: "t",
    });
    expect(c.protocolVersion).toBe("2024-11-05");
    expect(c.serverInfo.name).toBe("legacy");
    expect((await c.listTools()).tools).toEqual([]);
    expect(seen).toEqual(["auth=k"]);
    await c.close();
  });

  test("rejects an endpoint on another origin and a missing stream", async () => {
    const bad = createSseTransport({
      url: `http://127.0.0.1:${server.port}/other`,
      headers: async () => ({}),
      fetch,
      onMessage() {},
      onClose() {},
    });
    await expect(bad.connect()).rejects.toThrow("share the server origin");
    await bad.close();
    const missing = createSseTransport({
      url: `http://127.0.0.1:${server.port}/nope`,
      headers: async () => ({}),
      fetch,
      onMessage() {},
      onClose() {},
    });
    await expect(missing.connect()).rejects.toThrow("status 404");
  });
});
