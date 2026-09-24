import { describe, expect, test } from "bun:test";
import { chmodSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import * as edit from "../../src/core/tools/edit_file.ts";
import { diffCounts } from "../../src/core/tools/file_mutation.ts";
import * as write from "../../src/core/tools/write_file.ts";
import { decodeFail, decodeOk, makeCtx, tempWorkspace, writeTree } from "./helpers.ts";

const ws = tempWorkspace();
writeTree(ws, { "a.txt": "alpha\nbeta\ngamma\n", "dup.txt": "x\nx\n", "mode.sh": "#!/bin/sh\necho hi\n" });
chmodSync(join(ws, "mode.sh"), 0o755);

describe("edit_file", () => {
  test("decode messages and limits", () => {
    expect(decodeFail(edit.decode([]))).toBe("edit_file arguments must be an object");
    expect(decodeFail(edit.decode({ old_string: "a", new_string: "b" }))).toBe(
      'edit_file requires string field "path"',
    );
    expect(decodeFail(edit.decode({ path: 1, old_string: "a", new_string: "b" }))).toBe(
      'edit_file field "path" must be a string',
    );
    expect(decodeFail(edit.decode({ path: "x", old_string: "a" }))).toBe(
      'edit_file requires string field "new_string"',
    );
    expect(decodeFail(edit.decode({ path: "p".repeat(4097), old_string: "a", new_string: "b" }))).toBe(
      "file mutation preparation failed: path exceeds the preparation limit",
    );
    const huge = "x".repeat(4 * 1024 * 1024 + 1);
    expect(decodeFail(edit.decode({ path: "x", old_string: huge, new_string: "b" }))).toBe(
      "edit_file failed: old_string exceeds the 4 MiB preparation limit",
    );
    expect(decodeFail(edit.decode({ path: "x", old_string: "a", new_string: huge }))).toBe(
      "edit_file failed: new_string exceeds the 4 MiB preparation limit",
    );
  });

  test("semantic failures use the documented messages", async () => {
    const ctx = makeCtx(ws);
    const run = (args: object) => edit.call(decodeOk(edit.decode(args)), ctx);
    expect((await run({ path: "a.txt", old_string: "beta", new_string: "beta" })).output).toBe(
      "edit_file failed: old_string and new_string are identical",
    );
    expect((await run({ path: "a.txt", old_string: "zeta", new_string: "b" })).output).toBe(
      "edit_file failed: old_string not found in file",
    );
    expect((await run({ path: "dup.txt", old_string: "x", new_string: "y" })).output).toBe(
      "edit_file failed: old_string is not unique (found 2 occurrences), provide more context",
    );
    const missing = await run({ path: "missing.txt", old_string: "a", new_string: "b" });
    expect(JSON.parse(missing.output).error).toMatchObject({
      tool_name: "edit_file",
      details: { error: "FileNotFound" },
    });
  });

  test("prepare shows the diff before the edit and call writes atomically", async () => {
    const mutations: [string, string | null][] = [];
    const ctx = makeCtx(ws, { onFileMutation: (path, before) => mutations.push([path, before]) });
    const input = decodeOk(edit.decode({ path: "a.txt", old_string: "beta\n", new_string: "b1\nb2\n" }));
    const prepared = await edit.prepare(input, ctx);
    expect(prepared).toEqual({
      title: "edit_file a.txt",
      diff: {
        path: "a.txt",
        before: "alpha\nbeta\ngamma\n",
        after: "alpha\nb1\nb2\ngamma\n",
        additions: 2,
        deletions: 1,
      },
    });
    expect(edit.targets(input, ctx)).toEqual([
      { permission: "edit", target: "a.txt", kind: "path", absolute: join(ws, "a.txt"), external: false },
    ]);
    expect(await edit.call(input, ctx, prepared)).toEqual({ status: "success", output: "Edited a.txt (+2 -1)" });
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toBe("alpha\nb1\nb2\ngamma\n");
    expect(mutations).toEqual([[join(ws, "a.txt"), "alpha\nbeta\ngamma\n"]]);
    expect(readdirSync(ws).filter((n) => n.includes(".tmp"))).toEqual([]);
  });

  test("a file changed after approval is not overwritten", async () => {
    const ctx = makeCtx(ws);
    const input = decodeOk(edit.decode({ path: "a.txt", old_string: "gamma", new_string: "delta" }));
    const prepared = await edit.prepare(input, ctx);
    prepared.diff!.before = "stale";
    expect((await edit.call(input, ctx, prepared)).status).toBe("failure");
    expect(readFileSync(join(ws, "a.txt"), "utf8")).toContain("gamma");
  });

  test("mode is preserved and special-character replacements are literal", async () => {
    const ctx = makeCtx(ws);
    const result = await edit.call(
      decodeOk(edit.decode({ path: "mode.sh", old_string: "echo hi", new_string: "echo $& '$1'" })),
      ctx,
    );
    expect(result.output).toBe("Edited mode.sh (+1 -1)");
    expect(readFileSync(join(ws, "mode.sh"), "utf8")).toBe("#!/bin/sh\necho $& '$1'\n");
    expect(statSync(join(ws, "mode.sh")).mode & 0o777).toBe(0o755);
  });
});

describe("write_file", () => {
  test("decode messages", () => {
    expect(decodeFail(write.decode({ content: "x" }))).toBe('write_file requires string field "path"');
    expect(decodeFail(write.decode({ path: "x" }))).toBe('write_file requires string field "content"');
    expect(decodeFail(write.decode({ path: "x", content: 1 }))).toBe('write_file field "content" must be a string');
    expect(decodeFail(write.decode({ path: "x", content: "x".repeat(4 * 1024 * 1024 + 1) }))).toBe(
      "write_file failed: content exceeds the 4 MiB preparation limit",
    );
  });

  test("creates, reports no-ops, and requires an existing parent", async () => {
    const mutations: [string, string | null][] = [];
    const ctx = makeCtx(ws, { onFileMutation: (path, before) => mutations.push([path, before]) });
    const input = decodeOk(write.decode({ path: "new.txt", content: "hello\nworld\n" }));
    expect(await write.prepare(input, ctx)).toEqual({
      title: "write_file new.txt",
      diff: { path: "new.txt", before: null, after: "hello\nworld\n", additions: 2, deletions: 0 },
    });
    expect(await write.call(input, ctx)).toEqual({ status: "success", output: "Wrote new.txt (12 bytes)" });
    expect(mutations).toEqual([[join(ws, "new.txt"), null]]);
    expect(await write.call(input, ctx)).toEqual({
      status: "success",
      output: "No changes: new.txt already matches the requested content",
    });
    const nested = await write.call(decodeOk(write.decode({ path: "no/such/dir.txt", content: "x" })), ctx);
    expect(nested).toEqual({
      status: "failure",
      output: "write_file failed: parent directory does not exist for no/such/dir.txt",
    });
    await expect(write.prepare(decodeOk(write.decode({ path: ".", content: "x" })), ctx)).rejects.toThrow(
      "file mutation preparation failed: target is not a regular file",
    );
  });

  test("diff counts", () => {
    expect(diffCounts("a\nb\nc\n", "a\nX\nc\n")).toEqual({ additions: 1, deletions: 1 });
    expect(diffCounts(null, "a\nb")).toEqual({ additions: 2, deletions: 0 });
    expect(diffCounts("a\nb\n", "")).toEqual({ additions: 0, deletions: 2 });
    expect(diffCounts("same\n", "same\n")).toEqual({ additions: 0, deletions: 0 });
  });
});
