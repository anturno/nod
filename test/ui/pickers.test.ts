import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createEditor, reduceEditor } from "../../src/ui/core/composer.ts";
import { activeQuery, buildFileIndex, dismissQuery, matchPaths, subsequenceScore } from "../../src/ui/core/pickers.ts";

test("activeQuery sees / at the start, @ and $ tokens under the cursor, and nothing elsewhere", () => {
  expect(activeQuery(createEditor("/mod"))).toEqual({ kind: "slash", prefix: "/mod" });
  expect(activeQuery(createEditor("/model x"))).toBeNull();
  expect(activeQuery(createEditor("see @src/a"))).toEqual({ kind: "file", tokenStart: 4, query: "src/a" });
  expect(activeQuery(createEditor("run $rev"))).toEqual({ kind: "skill", tokenStart: 4, query: "rev" });
  expect(activeQuery(createEditor("mail me@x"))).toBeNull();
  expect(activeQuery(createEditor('"@quoted'))).toEqual({ kind: "file", tokenStart: 1, query: "quoted" });
  const moved = reduceEditor(createEditor("@abc def"), { type: "move", kind: "line_start" });
  expect(activeQuery(moved)).toBeNull();
});

test("esc dismisses the current token only; editing it re-arms the picker", () => {
  const e = createEditor("@src");
  const q = activeQuery(e);
  const dismissed = dismissQuery(q!);
  expect(activeQuery(e, dismissed)).toBeNull();
  const edited = reduceEditor(e, { type: "insert", text: "/" });
  expect(activeQuery(edited, dismissed)).toEqual({ kind: "file", tokenStart: 0, query: "src/" });
  const slash = createEditor("/he");
  const gone = dismissQuery(activeQuery(slash)!);
  expect(activeQuery(slash, gone)).toBeNull();
  expect(activeQuery(reduceEditor(slash, { type: "insert", text: "l" }), gone)?.kind).toBe("slash");
});

test("subsequence matching folds case and prefers contiguous spans and basenames", () => {
  expect(subsequenceScore("xyz", "src/app.ts")).toBeNull();
  const contiguous = subsequenceScore("app", "src/app.ts") as number;
  const scattered = subsequenceScore("app", "a/p/p.ts") as number;
  expect(contiguous).toBeGreaterThan(scattered);
  expect(subsequenceScore("APP", "src/app.ts")).toBe(contiguous);
  const rows = matchPaths(["src/ui/index.tsx", "src/agent.ts", "README.md", "src/index.ts"], "index");
  expect(rows[0]).toBe("src/index.ts");
  expect(rows).not.toContain("README.md");
  expect(matchPaths(["a", "b", "c"], "", 2)).toEqual(["a", "b"]);
});

test("the file index walks the workspace without .git when git is absent", () => {
  const dir = mkdtempSync(join(tmpdir(), "nod-ui-files-"));
  try {
    mkdirSync(join(dir, ".git", "objects"), { recursive: true });
    writeFileSync(join(dir, ".git", "HEAD"), "ref");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "");
    writeFileSync(join(dir, "b.md"), "");
    const index = buildFileIndex(dir);
    expect(index).toEqual(["b.md", "src/a.ts"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
