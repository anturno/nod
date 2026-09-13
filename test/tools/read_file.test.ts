import { describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { call, decode } from "../../src/core/tools/read_file.ts";
import { decodeFail, decodeOk, makeCtx, tempWorkspace, writeTree } from "./helpers.ts";

describe("read_file", () => {
  const ws = tempWorkspace();
  const ctx = makeCtx(ws);
  writeTree(ws, {
    "a.txt": "one\ntwo\nthree\n",
    "empty.txt": "",
    "long.txt": `${"x".repeat(2500)}\nshort\n`,
  });
  writeFileSync(join(ws, "bin.dat"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
  writeFileSync(join(ws, "many.txt"), Array.from({ length: 12 }, (_, i) => `line ${i + 1}`).join("\n"));

  test("decode messages", () => {
    expect(decodeFail(decode([]))).toBe("read_file arguments must be an object");
    expect(decodeFail(decode({}))).toBe('read_file requires string field "path"');
    expect(decodeFail(decode({ path: 1 }))).toBe('read_file field "path" must be a string');
    expect(decodeFail(decode({ path: "  " }))).toBe('read_file field "path" must not be empty');
    expect(decodeFail(decode({ path: "a", start_line: 0 }))).toBe(
      'read_file field "start_line" must be a positive integer',
    );
    expect(decodeOk(decode({ path: " a.txt ", line_count: 5000 }))).toEqual({
      path: "a.txt",
      startLine: 1,
      lineCount: 2000,
    });
    expect(decodeOk(decode({ path: "a.txt" })).lineCount).toBe(400);
  });

  test("full read uses fx's numbered format", async () => {
    const result = await call(decodeOk(decode({ path: "a.txt" })), ctx);
    expect(result).toEqual({
      status: "success",
      output: "<path>a.txt</path>\n<content>\n1\tone\n2\ttwo\n3\tthree\n</content>",
    });
  });

  test("ranges pad line numbers and add the sentinel", async () => {
    const result = await call(decodeOk(decode({ path: "many.txt", start_line: 9, line_count: 2 })), ctx);
    expect(result.output).toBe(
      "<path>many.txt</path>\n<content>\n9 \tline 9\n10\tline 10\n... [showing 2 of 12 lines; use start_line/line_count to read more.]\n</content>",
    );
  });

  test("start_line beyond EOF and empty files", async () => {
    expect((await call(decodeOk(decode({ path: "a.txt", start_line: 9 })), ctx)).output).toBe(
      "<path>a.txt</path>\n<content>\n... [start_line 9 is beyond end of file; total lines 3]\n</content>",
    );
    expect((await call(decodeOk(decode({ path: "empty.txt" })), ctx)).output).toBe(
      "<path>empty.txt</path>\n<content>\n</content>",
    );
  });

  test("binary files are omitted and long lines clipped", async () => {
    expect((await call(decodeOk(decode({ path: "bin.dat" })), ctx)).output).toBe(
      "<path>bin.dat</path>\n<content>binary or non-utf8 file omitted (6 bytes)</content>",
    );
    const long = (await call(decodeOk(decode({ path: "long.txt" })), ctx)).output;
    expect(long).toContain(`1\t${"x".repeat(2000)}... (line truncated)\n2\tshort\n`);
    expect(long).toContain("... [showing 2 of 2 lines;");
  });

  test("missing paths and directories return structured failures", async () => {
    const missing = await call(decodeOk(decode({ path: "nope.txt" })), ctx);
    expect(missing.status).toBe("failure");
    expect(JSON.parse(missing.output).error).toMatchObject({
      type: "tool_execution_failed",
      tool_name: "read_file",
      message: "read_file failed",
      details: { field: "path", path: "nope.txt", error: "FileNotFound" },
    });
    const dir = await call(decodeOk(decode({ path: "." })), ctx);
    expect(JSON.parse(dir.output).error.message).toBe("read_file requires a regular file");
    expect(JSON.parse(dir.output).error.suggestion).toBe(
      "Use glob_files to inspect directory contents, then choose a regular file.",
    );
  });

  test("external absolute paths display absolutely", async () => {
    const other = tempWorkspace();
    writeFileSync(join(other, "o.txt"), "o\n");
    const result = await call(decodeOk(decode({ path: join(other, "o.txt") })), ctx);
    expect(result.output).toBe(`<path>${join(other, "o.txt")}</path>\n<content>\n1\to\n</content>`);
  });
});
