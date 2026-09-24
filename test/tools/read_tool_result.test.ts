import { describe, expect, test } from "bun:test";
import type { ShellManager } from "../../src/core/shell/types.ts";
import { call, decode } from "../../src/core/tools/read_tool_result.ts";
import { prepareResult, unknownHandleMessage } from "../../src/core/tools/result_store.ts";
import { decodeFail, decodeOk, makeCtx, tempWorkspace } from "./helpers.ts";

describe("read_tool_result", () => {
  test("decode handles nested requests, ranges, and suffix restoration", () => {
    expect(decodeOk(decode({ handle: "h.txt", start_byte: 2, byte_count: 9 }))).toEqual({
      handle: "h.txt",
      startByte: 2,
      byteCount: 9,
    });
    expect(decodeOk(decode({ request: { handle: "h.txt", query: "needle" } }))).toMatchObject({
      handle: "h.txt",
      query: "needle",
    });
    expect(decodeOk(decode({ handle: "h.txt", query: "" })).query).toBeUndefined();
    expect(decodeOk(decode({ handle: "result-web_fetch-1705079ba6e278c4-553514ccf082aeb9" })).handle).toBe(
      "result-web_fetch-1705079ba6e278c4-553514ccf082aeb9.txt",
    );
    expect(decodeOk(decode({ handle: " nod-command-1.log " })).handle).toBe("nod-command-1.log");
    expect(decodeOk(decode({ handle: "h", byte_count: 1_000_000 })).byteCount).toBe(64 * 1024);
    expect(decodeFail(decode({ handle: "  " }))).toBe('read_tool_result field "handle" must not be empty');
    expect(decodeFail(decode({ handle: "h", start_byte: 0 }))).toBe(
      'read_tool_result field "start_byte" must be a positive integer',
    );
    expect(decodeFail(decode({ request: 1 }))).toBe('read_tool_result field "request" must be an object');
    expect(decodeFail(decode({}))).toBe('read_tool_result requires string field "handle"');
  });

  test("dispatches to the result store or the shell's retained output", async () => {
    const ws = tempWorkspace();
    const ctx = makeCtx(ws);
    const stored = await prepareResult(
      ctx.resultDir,
      "call_search",
      "web_search",
      `search preview\nneedle from full search result\n${"x".repeat(17_000)}`,
      1024,
    );
    const handle = stored.memory.outputHandle!;
    const found = await call(decodeOk(decode({ handle, query: "needle" })), ctx);
    expect(found.status).toBe("success");
    expect(found.output).toContain("2|needle from full search result");
    expect((await call(decodeOk(decode({ handle, byte_count: 14 })), ctx)).output).toContain("\nsearch preview\n");
    expect(
      await call(decodeOk(decode({ handle: "unknown-dogfood-handle", start_byte: 1, byte_count: 64 })), ctx),
    ).toEqual({
      status: "failure",
      output: unknownHandleMessage("unknown-dogfood-handle"),
    });
    expect((await call(decodeOk(decode({ handle: "../x" })), ctx)).output).toBe(
      "read_tool_result failed for handle ../x: InvalidHandle",
    );

    const shell = {
      readRetained: async (h: string, start: number, count: number) =>
        h === "nod-command-7.log" ? `page ${start} ${count}` : null,
      searchRetained: async (h: string, q: string) => (h === "nod-command-7.log" ? `hits ${q}` : null),
    } as unknown as ShellManager;
    const shellCtx = makeCtx(ws, { shell });
    expect(
      (await call(decodeOk(decode({ handle: "nod-command-7.log", start_byte: 3, byte_count: 5 })), shellCtx)).output,
    ).toBe("page 3 5");
    expect((await call(decodeOk(decode({ handle: "nod-command-7.log", query: "q" })), shellCtx)).output).toBe("hits q");
    expect((await call(decodeOk(decode({ handle: "nod-command-8.log" })), shellCtx)).output).toBe(
      unknownHandleMessage("nod-command-8.log"),
    );
    expect((await call(decodeOk(decode({ handle: "nod-command-7.log" })), ctx)).output).toBe(
      unknownHandleMessage("nod-command-7.log"),
    );
  });
});
