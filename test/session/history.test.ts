import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendPromptHistory, historyPath, loadPromptHistory } from "../../src/core/session/history.ts";

let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nod-history-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("append, dedupe, filter by workspace newest-first, size cap, enabled flag", () => {
  let t = 0;
  const d = { home: join(root, ".nod"), now: () => ++t };
  expect(appendPromptHistory(d, "/a", "one")).toBe("appended");
  expect(appendPromptHistory(d, "/a", "one")).toBe("duplicate");
  expect(appendPromptHistory(d, "/b", "other")).toBe("appended");
  expect(appendPromptHistory(d, "/a", "two")).toBe("appended");
  expect(appendPromptHistory(d, "/a", "x".repeat(256 * 1024))).toBe("record_too_large");
  expect(loadPromptHistory(d, "/a")).toEqual(["two", "one"]);
  expect(loadPromptHistory(d, "/a", 1)).toEqual(["two"]);
  expect(loadPromptHistory(d, "/b")).toEqual(["other"]);
  expect(readFileSync(historyPath(d.home), "utf8").split("\n")[0]).toBe(
    '{"schema_version":1,"timestamp_ms":1,"workspace_root":"/a","text":"one"}',
  );
  writeFileSync(historyPath(d.home), '{"schema_version":1,"timestamp_ms":9,"workspace_root":"/a","te', { flag: "a" });
  expect(loadPromptHistory(d, "/a")).toEqual(["two", "one"]);
  expect(appendPromptHistory({ ...d, enabled: false }, "/a", "z")).toBe("disabled");
  expect(loadPromptHistory({ ...d, enabled: false }, "/a")).toEqual([]);
});
