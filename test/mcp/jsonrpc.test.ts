import { describe, expect, test } from "bun:test";
import {
  createJsonRpcPeer,
  encodeFrame,
  type JsonRpcMessage,
  JsonRpcRemoteError,
  parseFrame,
  validateMessage,
} from "../../src/core/mcp/jsonrpc.ts";

describe("jsonrpc envelope", () => {
  test("validates requests, notifications and responses", () => {
    expect(validateMessage({ jsonrpc: "2.0", id: 1, method: "x" }).method).toBe("x");
    expect(validateMessage({ jsonrpc: "2.0", method: "n", params: { a: 1 } }).id).toBeUndefined();
    expect(validateMessage({ jsonrpc: "2.0", id: "a", result: null }).id).toBe("a");
    expect(() => validateMessage({ id: 1, result: 1 })).toThrow('requires "jsonrpc":"2.0"');
    expect(() => validateMessage({ jsonrpc: "2.0", id: 1, result: 1, error: { code: 1, message: "m" } })).toThrow(
      "exactly one of result or error",
    );
    expect(() => validateMessage({ jsonrpc: "2.0", id: 1 })).toThrow("exactly one of result or error");
    expect(() => validateMessage({ jsonrpc: "2.0", id: 1, error: { code: "x" } })).toThrow("numeric code");
    expect(() => validateMessage({ jsonrpc: "2.0", id: {}, method: "x" })).toThrow("id must be");
    expect(() => validateMessage({ jsonrpc: "2.0", method: "x", params: 1 })).toThrow("params must be");
    expect(() => validateMessage({ jsonrpc: "2.0", result: 1 })).toThrow("requires an id");
  });

  test("frame parsing enforces the byte cap", () => {
    expect(parseFrame(encodeFrame({ jsonrpc: "2.0", id: 1, result: {} }).trim()).id).toBe(1);
    expect(() => parseFrame("{nope")).toThrow("not valid JSON");
    expect(() => parseFrame("x".repeat(20), 10)).toThrow("request frame too large");
    expect(() => parseFrame("x".repeat(8 * 1024 * 1024 + 1))).toThrow("request frame too large");
  });
});

describe("jsonrpc peer", () => {
  test("requests get incremental ids and resolve on matching responses", async () => {
    const sent: JsonRpcMessage[] = [];
    const peer = createJsonRpcPeer({ send: (m) => void sent.push(m) });
    const a = peer.request("a", { x: 1 });
    const b = peer.request("b");
    expect(sent.map((m) => m.id)).toEqual([1, 2]);
    expect(sent[1]).not.toHaveProperty("params");
    peer.receive({ jsonrpc: "2.0", id: 2, result: "B" });
    peer.receive({ jsonrpc: "2.0", id: 1, error: { code: -1, message: "boom", data: { d: 1 } } });
    expect(await b).toBe("B");
    const err = (await a.catch((e) => e)) as JsonRpcRemoteError;
    expect(err).toBeInstanceOf(JsonRpcRemoteError);
    expect(err.code).toBe(-1);
    expect(err.data).toEqual({ d: 1 });
    expect(peer.pending()).toBe(0);
    peer.receive({ jsonrpc: "2.0", id: 99, result: 1 }); // unknown id is ignored
  });

  test("timeouts and aborts reject and send notifications/cancelled", async () => {
    const sent: JsonRpcMessage[] = [];
    const peer = createJsonRpcPeer({ send: (m) => void sent.push(m), defaultTimeoutMs: 20 });
    await expect(peer.request("slow")).rejects.toThrow("MCP request slow timed out after 20 ms");
    expect(sent[1]).toEqual({
      jsonrpc: "2.0",
      method: "notifications/cancelled",
      params: { requestId: 1, reason: "timeout" },
    });
    const ac = new AbortController();
    const p = peer.request("x", undefined, { timeoutMs: 0, signal: ac.signal });
    ac.abort();
    const e = (await p.catch((err) => err)) as Error;
    expect(e.name).toBe("AbortError");
    expect(sent.at(-1)?.params).toEqual({ requestId: 2, reason: "client cancelled" });
    peer.receive({ jsonrpc: "2.0", id: 2, result: 1 }); // late response is ignored
  });

  test("send failures, fail(), notifications and server requests", async () => {
    const sent: JsonRpcMessage[] = [];
    const notes: string[] = [];
    const peer = createJsonRpcPeer({
      send: (m) => {
        if (m.method === "bad") throw new Error("pipe closed");
        sent.push(m);
      },
      onNotification: (method) => void notes.push(method),
      onRequest: async (method) => {
        if (method === "ping") return {};
        throw new JsonRpcRemoteError(-32601, "nope");
      },
    });
    await expect(peer.request("bad")).rejects.toThrow("pipe closed");
    const hanging = peer.request("hang");
    peer.fail(new Error("closed"));
    await expect(hanging).rejects.toThrow("closed");
    peer.receive({ jsonrpc: "2.0", method: "notifications/x" });
    expect(notes).toEqual(["notifications/x"]);
    peer.receive({ jsonrpc: "2.0", id: "s1", method: "ping" });
    peer.receive({ jsonrpc: "2.0", id: "s2", method: "other" });
    await new Promise((r) => setTimeout(r, 5));
    expect(sent.filter((m) => m.id === "s1")[0]).toEqual({ jsonrpc: "2.0", id: "s1", result: {} });
    expect(sent.filter((m) => m.id === "s2")[0]?.error?.code).toBe(-32601);
  });
});
