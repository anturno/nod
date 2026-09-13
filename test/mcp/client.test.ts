import { describe, expect, test } from "bun:test";
import { connectClient, contentText, type ElicitationRequest, validateToolDef } from "../../src/core/mcp/client.ts";
import type { JsonRpcMessage } from "../../src/core/mcp/jsonrpc.ts";
import { fakeTransport, initResult } from "./helpers.ts";

const connect = (
  handler: Parameters<typeof fakeTransport>[0],
  extra: Partial<Parameters<typeof connectClient>[0]> = {},
  log?: JsonRpcMessage[],
) => {
  const fake = fakeTransport(handler, { log });
  const client = connectClient({
    openTransport: fake.open,
    operationTimeoutMs: 2000,
    startupTimeoutMs: 2000,
    version: "t",
    ...extra,
  });
  return { fake, client };
};

describe("mcp client", () => {
  test("negotiates 2025-11-25 first, falls back on -32022, and sends initialized", async () => {
    const log: JsonRpcMessage[] = [];
    const { client } = connect(
      (method, params) => {
        if (method === "initialize") {
          const v = (params as { protocolVersion: string }).protocolVersion;
          if (v !== "2025-03-26") throw Object.assign(new Error("unsupported"), { code: -32022 });
          return initResult(v, { instructions: "x".repeat(5000) });
        }
        return {};
      },
      { instructionsBytes: 2048 },
      log,
    );
    const c = await client;
    expect(c.protocolVersion).toBe("2025-03-26");
    expect(
      log
        .filter((m) => m.method === "initialize")
        .map((m) => (m.params as { protocolVersion: string }).protocolVersion),
    ).toEqual(["2025-11-25", "2025-06-18", "2025-03-26"]);
    expect((log[0] as JsonRpcMessage).params).toMatchObject({ clientInfo: { name: "nod" } });
    expect(log.find((m) => m.method === "notifications/initialized")).toBeDefined();
    expect(c.instructions?.length).toBe(2048);
    expect(c.serverInfo).toEqual({ name: "fake", version: "1" });
    await c.close();
  });

  test("accepts a supported downgrade offered by the server and rejects unknown versions", async () => {
    const down = await connect((m) => (m === "initialize" ? initResult("2024-11-05") : {})).client;
    expect(down.protocolVersion).toBe("2024-11-05");
    await down.close();
    await expect(connect((m) => (m === "initialize" ? initResult("1999-01-01") : {})).client).rejects.toThrow(
      "no supported protocol version",
    );
  });

  test("tools/list paginates, validates schemas, and rejects bad cursors", async () => {
    let mode = "ok";
    const { client } = connect((method, params) => {
      if (method === "initialize") return initResult();
      if (method !== "tools/list") return {};
      const cursor = (params as { cursor?: string }).cursor;
      if (mode === "repeat") return { tools: [], nextCursor: "same" };
      if (mode === "long") return { tools: [], nextCursor: "x".repeat(5000) };
      if (mode === "many") return { tools: [], nextCursor: `${Number(cursor ?? "0") + 1}` };
      if (!cursor)
        return {
          tools: [
            { name: "a", description: "A", inputSchema: { type: "object", properties: {} } },
            { name: "bad", inputSchema: { type: "string" } },
            { name: "", inputSchema: { type: "object" } },
          ],
          nextCursor: "p2",
        };
      return { tools: [{ name: "b", inputSchema: { type: "object" } }] };
    });
    const c = await client;
    const { tools, rejected } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(["a", "b"]);
    expect(rejected).toBe(2);
    mode = "repeat";
    await expect(c.listTools()).rejects.toThrow("repeated a cursor");
    mode = "long";
    await expect(c.listTools()).rejects.toThrow("invalid cursor");
    mode = "many";
    await expect(c.listTools()).rejects.toThrow("exceeded 64 pages");
    await c.close();
    let deep: Record<string, unknown> = { type: "object" };
    for (let i = 0; i < 70; i++) deep = { type: "object", properties: { n: deep } };
    expect(validateToolDef({ name: "d", inputSchema: deep })).toBeUndefined();
    expect(validateToolDef({ name: "d", inputSchema: { type: "object" } })?.description).toBe("");
  });

  test("tools/call sends a progressToken and maps content, structured output, and isError", async () => {
    const log: JsonRpcMessage[] = [];
    const progress: string[] = [];
    const { client, fake } = connect(
      (method, params, ctx) => {
        if (method === "initialize") return initResult();
        if (method === "tools/call") {
          const token = (params as { _meta: { progressToken: number } })._meta.progressToken;
          ctx.push({
            jsonrpc: "2.0",
            method: "notifications/progress",
            params: { progressToken: token, progress: 1, total: 2, message: "half" },
          });
          return {
            content: [
              { type: "text", text: "hi" },
              { type: "image", data: "AAAA", mimeType: "image/png" },
              { type: "resource", resource: { uri: "file:///a", text: "res" } },
              { type: "resource_link", uri: "file:///b", name: "b" },
              { type: "bogus" },
            ],
            structuredContent: { ok: true },
            isError: true,
          };
        }
        return {};
      },
      { onProgress: (p) => void progress.push(`${p.progressToken}:${p.progress}/${p.total}:${p.message}`) },
      log,
    );
    const c = await client;
    const r = await c.callTool("x", { a: 1 });
    expect(log.find((m) => m.method === "tools/call")?.params).toMatchObject({ _meta: { progressToken: 1 } });
    expect(r.isError).toBe(true);
    expect(r.structuredContent).toEqual({ ok: true });
    expect(r.content.length).toBe(4);
    expect(contentText(r.content)).toBe(
      'hi\n<image mimeType="image/png"/>\nres\n<resource_link uri="file:///b" name="b"/>',
    );
    expect(progress).toEqual(["1:1/2:half"]);
    fake.push({ jsonrpc: "2.0", method: "notifications/progress", params: { progressToken: 9, progress: 5 } });
    expect(progress.length).toBe(2);
    await c.close();
  });

  test("list_changed notifications, ping, and elicitation forms round-trip", async () => {
    const changed: string[] = [];
    const asked: ElicitationRequest[] = [];
    const sent: JsonRpcMessage[] = [];
    const { client, fake } = connect(
      (method) => (method === "initialize" ? initResult() : {}),
      {
        onListChanged: (k) => void changed.push(k),
        onElicitation: async (req) => {
          asked.push(req);
          return { action: "accept", content: { name: "n" } };
        },
      },
      sent,
    );
    const c = await client;
    for (const kind of ["tools", "resources", "prompts"])
      fake.push({ jsonrpc: "2.0", method: `notifications/${kind}/list_changed` });
    expect(changed).toEqual(["tools", "resources", "prompts"]);
    fake.push({ jsonrpc: "2.0", id: "p", method: "ping" });
    fake.push({
      jsonrpc: "2.0",
      id: "e",
      method: "elicitation/create",
      params: {
        message: "Who?",
        requestedSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
      },
    });
    fake.push({
      jsonrpc: "2.0",
      id: "u",
      method: "elicitation/create",
      params: { message: "Go", mode: "url", url: "https://x" },
    });
    fake.push({ jsonrpc: "2.0", id: "z", method: "unknown/thing" });
    await new Promise((r) => setTimeout(r, 10));
    expect(sent.find((m) => m.id === "p")).toEqual({ jsonrpc: "2.0", id: "p", result: {} });
    expect(sent.find((m) => m.id === "e")?.result).toEqual({ action: "accept", content: { name: "n" } });
    expect(asked[0]).toEqual({
      message: "Who?",
      mode: "form",
      url: undefined,
      requestedSchema: { properties: { name: { type: "string" } }, required: ["name"] },
    });
    expect(asked[1]?.mode).toBe("url");
    expect(sent.find((m) => m.id === "z")?.error?.code).toBe(-32601);
    await c.ping();
    await c.close();
  });

  test("resources, prompts, completions, and transport loss", async () => {
    const { client, fake } = connect((method, params) => {
      switch (method) {
        case "initialize":
          return initResult();
        case "resources/list":
          return { resources: [{ uri: "file:///a", name: "a", mimeType: "text/plain" }, { nope: 1 }] };
        case "resources/templates/list":
          return { resourceTemplates: [{ uriTemplate: "file:///{p}", name: "t" }] };
        case "resources/read":
          return { contents: [{ uri: (params as { uri: string }).uri, text: "body" }] };
        case "prompts/list":
          return { prompts: [{ name: "p", arguments: [{ name: "a", required: true }] }] };
        case "prompts/get":
          return {
            description: "d",
            messages: [
              { role: "user", content: { type: "text", text: "hello" } },
              { role: "x", content: 1 },
            ],
          };
        case "completion/complete":
          return { completion: { values: ["v1", 2], total: 1, hasMore: false } };
        default:
          return {};
      }
    });
    const c = await client;
    expect(await c.listResources()).toEqual([
      { uri: "file:///a", name: "a", title: undefined, description: undefined, mimeType: "text/plain" },
    ]);
    expect((await c.listResourceTemplates())[0]?.uriTemplate).toBe("file:///{p}");
    expect(contentText(await c.readResource("file:///a"))).toBe("body");
    expect((await c.listPrompts())[0]?.arguments).toEqual([{ name: "a", description: undefined, required: true }]);
    const got = await c.getPrompt("p", { a: "1" });
    expect(got.messages).toEqual([{ role: "user", content: { type: "text", text: "hello" } }]);
    expect(await c.complete({ type: "ref/prompt", name: "p" }, { name: "a", value: "v" }, { b: "2" })).toEqual({
      values: ["v1"],
      total: 1,
      hasMore: false,
    });
    const closes: (Error | undefined)[] = [];
    const { client: c2, fake: f2 } = connect((m) => (m === "initialize" ? initResult() : new Promise(() => {})), {
      onClose: (r) => void closes.push(r),
    });
    const cc = await c2;
    const hanging = cc.ping();
    f2.drop(new Error("gone"));
    await expect(hanging).rejects.toThrow("gone");
    expect(closes[0]?.message).toBe("gone");
    void fake;
    await c.close();
  });
});
