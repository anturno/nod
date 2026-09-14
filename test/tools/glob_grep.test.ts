import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import * as glob from "../../src/core/tools/glob_files.ts";
import * as grep from "../../src/core/tools/grep_files.ts";
import { decodeFail, decodeOk, makeCtx, tempWorkspace, writeTree } from "./helpers.ts";

const ws = tempWorkspace();
const ctx = makeCtx(ws);
const many: Record<string, string> = {};
for (let i = 0; i < 120; i++) many[`many/file-${String(i).padStart(4, "0")}.txt`] = "needle\n";
writeTree(ws, {
  "src/a.ts": "const needle = 1;\nplain\nNEEDLE again\n",
  "src/b.ts": "nothing here\n",
  "src/sub/c.md": "needle in markdown\n",
  "node_modules/pkg/index.ts": "needle ignored\n",
  ".git/config": "needle ignored\n",
  "ctx.txt": "l1\nl2\nl3\nneedle\nl5\nl6\nl7\n",
  ...many,
});

describe("glob_files", () => {
  test("decode defaults", () => {
    expect(decodeFail(glob.decode({ path: "." }))).toBe('glob_files requires string field "pattern"');
    expect(decodeOk(glob.decode({ pattern: "*.ts", path: "" }))).toEqual({
      pattern: "*.ts",
      path: ".",
      mode: "matches",
    });
    expect(decodeOk(glob.decode({ pattern: "*.ts", path: 1, mode: "count" })).mode).toBe("count");
  });

  test("skips ignored directories, sorts, and reports counts", async () => {
    const result = await glob.call(decodeOk(glob.decode({ pattern: "**/*.ts" })), ctx);
    expect(result.output).toBe("[glob] 2 matches for **/*.ts\n - src/a.ts\n - src/b.ts\n");
    expect((await glob.call(decodeOk(glob.decode({ pattern: "**/*.ts", mode: "count" })), ctx)).output).toBe(
      "[glob] count 2 matches for **/*.ts\n",
    );
    expect((await glob.call(decodeOk(glob.decode({ pattern: "*.rs" })), ctx)).output).toBe(
      "[glob] no matches for *.rs\n",
    );
    expect((await glob.call(decodeOk(glob.decode({ pattern: "**/*.ts", path: "node_modules" })), ctx)).output).toBe(
      "[glob] 1 matches for **/*.ts\n - node_modules/pkg/index.ts\n",
    );
    expect((await glob.call(decodeOk(glob.decode({ pattern: "*.md", path: "src/sub" })), ctx)).output).toBe(
      "[glob] 1 matches for *.md\n - src/sub/c.md\n",
    );
  });

  test("truncates listings at 100 while count stays exact", async () => {
    const listed = (await glob.call(decodeOk(glob.decode({ pattern: "many/*.txt" })), ctx)).output;
    expect(listed.startsWith("[glob] 100 matches for many/*.txt\n - many/file-0000.txt\n")).toBe(true);
    expect(listed.endsWith(" - many/file-0099.txt\n... truncated to first 100 matches\n")).toBe(true);
    expect((await glob.call(decodeOk(glob.decode({ pattern: "many/*.txt", mode: "count" })), ctx)).output).toBe(
      "[glob] count 120 matches for many/*.txt\n",
    );
  });

  test("regular-file roots match the basename and missing roots fail", async () => {
    expect((await glob.call(decodeOk(glob.decode({ pattern: "*.ts", path: "src/a.ts" })), ctx)).output).toBe(
      "[glob] 1 matches for *.ts\n - src/a.ts\n",
    );
    expect(await glob.call(decodeOk(glob.decode({ pattern: "*.ts", path: "missing" })), ctx)).toEqual({
      status: "failure",
      output: "Unable to resolve glob search root: missing (FileNotFound)",
    });
  });
});

describe("grep_files", () => {
  test("decode clamps and validates", () => {
    expect(decodeFail(grep.decode({ pattern: "x", head_limit: 0 }))).toBe(
      'grep_files field "head_limit" must be a positive integer',
    );
    expect(decodeFail(grep.decode({ pattern: "x", offset: -1 }))).toBe(
      'grep_files field "offset" must be a non-negative integer',
    );
    expect(
      decodeOk(
        grep.decode({ pattern: "x", context_lines: 99, head_limit: 500, include: "*.ts", case_insensitive: true }),
      ),
    ).toMatchObject({
      contextLines: 5,
      headLimit: 100,
      include: "*.ts",
      caseInsensitive: true,
      mode: "matches",
    });
  });

  test("matches mode with include, case folding, and pagination", async () => {
    expect(
      (await grep.call(decodeOk(grep.decode({ pattern: "needle", include: "*.ts", path: "src" })), ctx)).output,
    ).toBe("[grep] 1 matches for needle\n - src/a.ts:1: const needle = 1;\n");
    expect(
      (
        await grep.call(
          decodeOk(grep.decode({ pattern: "needle", include: "*.ts", path: "src", case_insensitive: true })),
          ctx,
        )
      ).output,
    ).toBe("[grep] 2 matches for needle\n - src/a.ts:1: const needle = 1;\n - src/a.ts:3: NEEDLE again\n");
    const paged = (
      await grep.call(decodeOk(grep.decode({ pattern: "needle", path: "many", head_limit: 2, offset: 1 })), ctx)
    ).output;
    expect(paged).toBe(
      "[grep] 2 matches for needle (showing 2-3 of 120)\n - many/file-0001.txt:1: needle\n - many/file-0002.txt:1: needle\n... more matches available; use offset 3 to continue\n",
    );
    expect((await grep.call(decodeOk(grep.decode({ pattern: "zzz" })), ctx)).output).toBe(
      "[grep] no matches for zzz\n",
    );
    expect((await grep.call(decodeOk(grep.decode({ pattern: "needle", path: "many", offset: 500 })), ctx)).output).toBe(
      "[grep] no matches for needle at offset 500 (120 total matches)\n",
    );
  });

  test("ignored directories are skipped and other modes format correctly", async () => {
    const files = (
      await grep.call(decodeOk(grep.decode({ pattern: "needle", mode: "files_with_matches", include: "src/**" })), ctx)
    ).output;
    expect(files).toBe("[grep] 2 files with matches for needle\n - src/a.ts\n - src/sub/c.md\n");
    const count = (await grep.call(decodeOk(grep.decode({ pattern: "needle", mode: "count", path: "src" })), ctx))
      .output;
    expect(count).toBe("[grep] count 2 matching lines in 2 files for needle\n");
    const all = (await grep.call(decodeOk(grep.decode({ pattern: "ignored" })), ctx)).output;
    expect(all).toBe("[grep] no matches for ignored\n");
  });

  test("context lines surround matches without synthetic trailing lines", async () => {
    const out = (await grep.call(decodeOk(grep.decode({ pattern: "needle", path: "ctx.txt", context_lines: 2 })), ctx))
      .output;
    expect(out).toBe(
      "[grep] 1 matches for needle\n   ctx.txt:2- l2\n   ctx.txt:3- l3\n - ctx.txt:4: needle\n   ctx.txt:5- l5\n   ctx.txt:6- l6\n",
    );
    const tail = (await grep.call(decodeOk(grep.decode({ pattern: "l7", path: "ctx.txt", context_lines: 5 })), ctx))
      .output;
    expect(tail).toBe(
      "[grep] 1 matches for l7\n   ctx.txt:2- l2\n   ctx.txt:3- l3\n   ctx.txt:4- needle\n   ctx.txt:5- l5\n   ctx.txt:6- l6\n - ctx.txt:7: l7\n",
    );
  });

  test("root failures", async () => {
    expect(await grep.call(decodeOk(grep.decode({ pattern: "x", path: "missing" })), ctx)).toEqual({
      status: "failure",
      output: "Unable to resolve grep search root: missing (FileNotFound)",
    });
    expect(grep.targets(decodeOk(grep.decode({ pattern: "x", path: "src" })), ctx)).toEqual([
      { permission: "grep", target: "src", kind: "path", absolute: join(ws, "src"), external: false },
    ]);
  });
});
