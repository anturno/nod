import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport, renderUsage } from "../../src/core/usage/report.ts";
import { appendGeneration, type GenerationFact, loadUsage, UsageError, usagePath } from "../../src/core/usage/store.ts";

let home: string;
const DAY = 86_400_000;
const NOW = 40 * DAY;
beforeEach(() => {
  home = join(mkdtempSync(join(tmpdir(), "nod-usage-")), ".nod");
});
afterEach(() => rmSync(join(home, ".."), { recursive: true, force: true }));

const fact = (id: string, over: Partial<GenerationFact> = {}): GenerationFact => ({
  id,
  created_at_ms: NOW - 1,
  model: "gpt-5",
  input_tokens: 10,
  output_tokens: 5,
  cache_read_tokens: 2,
  cache_write_tokens: 0,
  reasoning_tokens: 1,
  billable_web_search_calls: 0,
  total_cost: 0,
  ...over,
});

test("append writes coverage first, dedupes, conflicts, and repairs a partial tail with an incident", () => {
  const deps = { home, now: () => NOW };
  expect(appendGeneration(deps, fact("g1"))).toBe("appended");
  expect(appendGeneration(deps, fact("g1"))).toBe("duplicate");
  expect(appendGeneration(deps, fact("g1", { output_tokens: 6 }))).toBe("conflict");
  expect(appendGeneration(deps, fact("g1", { output_tokens: 7 }))).toBe("conflict");
  const lines = readFileSync(usagePath(home), "utf8").trimEnd().split("\n");
  expect(lines[0]).toBe(`{"schema_version":1,"kind":"coverage","started_at_ms":${NOW}}`);
  expect(lines[1]).toBe(
    '{"schema_version":1,"kind":"generation","fact":{"id":"g1","created_at_ms":3455999999,"model":"gpt-5","input_tokens":10,"output_tokens":5,"cache_read_tokens":2,"cache_write_tokens":0,"reasoning_tokens":1,"billable_web_search_calls":0,"total_cost":0}}',
  );
  expect(lines).toHaveLength(3);
  writeFileSync(usagePath(home), '{"schema_version":1,"kind":"gen', { flag: "a" });
  expect(appendGeneration(deps, fact("g2"))).toBe("appended");
  const loaded = loadUsage(home);
  expect(loaded.incidents).toEqual([{ occurred_at_ms: NOW, completeness: "incomplete" }]);
  expect(loaded.facts.map((f) => f.id)).toEqual(["g1", "g1", "g2"]);
  expect(loaded.coverage_started_at_ms).toBe(NOW);
  expect(() => appendGeneration(deps, fact("bad", { cache_read_tokens: 99 }))).toThrow(UsageError);
  writeFileSync(usagePath(home), "{corrupt}\n", { flag: "a" });
  expect(() => loadUsage(home)).toThrow(expect.objectContaining({ code: "invalid_store" }));
});

test("report windows, coverage, completeness, model ordering and exact rendering", () => {
  const loaded = {
    coverage_started_at_ms: NOW - 10 * DAY,
    facts: [
      fact("a", { model: "z/model", created_at_ms: NOW - 30 * DAY, input_tokens: 3, output_tokens: 2 }),
      fact("b", { model: "b/model", created_at_ms: NOW - 1, input_tokens: 5, output_tokens: 5 }),
      fact("c", { model: "a/model", created_at_ms: NOW - 2, input_tokens: 5, output_tokens: 5 }),
      fact("d", { model: "excluded", created_at_ms: NOW, input_tokens: 100, output_tokens: 100 }),
    ],
    incidents: [],
    record_count: 5,
  };
  const r = buildReport(loaded, "30d", NOW);
  expect(r.coverage).toBe("partial");
  expect(r.models.map((m) => m.model)).toEqual(["a/model", "b/model", "z/model"]);
  expect(r.totals?.total_tokens).toBe(25);
  expect(r.totals?.request_count).toBe(3);
  expect(renderUsage(r, "text")).toBe(
    "Usage (30 days)\nTracking since Jan 31, 1970 (partial window).\nTotal tokens  25\nInput         13\nOutput        12\nCache         6 read · 0 write\nReasoning     3\nRequests      3\nSpend         $0.0000\n\nBy model\n- a/model  10 tokens  $0.0000\n- b/model  10 tokens  $0.0000\n- z/model  5 tokens  $0.0000\n",
  );
  expect(renderUsage(buildReport(loaded, "24h", NOW), "json")).toBe(
    `{"kind":"usage","schema_version":1,"period":"24h","snapshot_time_ms":${NOW},"window_start_ms":${NOW - DAY},"coverage":{"status":"full","started_at_ms":${NOW - 10 * DAY},"full_window":true},"completeness":"complete","totals":{"total_tokens":20,"input_tokens":10,"output_tokens":10,"cache_read_tokens":4,"cache_write_tokens":0,"reasoning_tokens":2,"request_count":2,"spend":0},"models":[{"model":"a/model","totals":{"total_tokens":10,"input_tokens":5,"output_tokens":5,"cache_read_tokens":2,"cache_write_tokens":0,"reasoning_tokens":1,"request_count":1,"spend":0}},{"model":"b/model","totals":{"total_tokens":10,"input_tokens":5,"output_tokens":5,"cache_read_tokens":2,"cache_write_tokens":0,"reasoning_tokens":1,"request_count":1,"spend":0}}]}`,
  );
  const none = buildReport({ coverage_started_at_ms: null, facts: [], incidents: [], record_count: 0 }, "7d", NOW);
  expect(renderUsage(none, "text")).toBe("Usage (7 days)\nTracking has not started.\n");
  expect(renderUsage(none, "json")).toContain(
    '"coverage":{"status":"not_started","started_at_ms":null,"full_window":false},"completeness":"complete","totals":null,"models":[]}',
  );
  const conflicted = buildReport(
    {
      ...loaded,
      facts: [fact("x"), fact("x", { output_tokens: 4 })],
      incidents: [{ occurred_at_ms: NOW - 1, completeness: "pending" }],
    },
    "24h",
    NOW,
  );
  expect(conflicted.completeness).toBe("incomplete");
  expect(renderUsage(conflicted, "text")).toContain("Known totals may be incomplete.\n");
});
