import { describe, expect, test } from "bun:test";
import { createSseParser, parseSse } from "../../src/core/mcp/transport/sse-parser.ts";

describe("sse parser", () => {
  test("joins data lines and accepts every line terminator", () => {
    expect(parseSse("data: a\ndata: b\n\n")).toEqual([{ event: "message", data: "a\nb" }]);
    expect(parseSse("event: endpoint\r\ndata: /x\r\n\r\n")).toEqual([{ event: "endpoint", data: "/x" }]);
    expect(parseSse("data: r\r\r")).toEqual([{ event: "message", data: "r" }]);
    expect(parseSse(": comment\nid: 7\ndata:{}\n\n")).toEqual([{ event: "message", data: "{}", id: "7" }]);
    expect(parseSse("data: tail")).toEqual([{ event: "message", data: "tail" }]);
    expect(parseSse("\n\n")).toEqual([]);
  });

  test("streams across chunk boundaries, including a split CRLF", () => {
    const p = createSseParser();
    expect(p.feed("data: one\r")).toEqual([]);
    expect(p.feed("\n\r\ndata: tw")).toEqual([{ event: "message", data: "one" }]);
    expect(p.feed("o\n\n")).toEqual([{ event: "message", data: "two" }]);
    expect(p.end()).toEqual([]);
  });
});
