import { describe, expect, test } from "bun:test";
import { SCHEMA_BUDGET_NOTICE, type SearchCandidate, scoreCandidate, searchTools } from "../../src/core/mcp/search.ts";

const cand = (alias: string, description: string, extra: Partial<SearchCandidate> = {}): SearchCandidate => ({
  alias,
  server: "srv",
  tool: { name: alias.slice(8), description, inputSchema: { type: "object", properties: { path: {} } } },
  schemaBytes: 100,
  ...extra,
});
const limits = { descriptionBytes: 1024, resultBytes: 16 * 1024, selectedSchemaBytes: 64 * 1024 };

describe("mcp search", () => {
  test("weights name over description over schema and instructions", () => {
    expect(scoreCandidate("deploy", cand("mcp_srv_deploy", "ship it"))).toBe(3);
    expect(scoreCandidate("deploy", cand("mcp_srv_ship", "deploy to prod"))).toBe(2);
    expect(scoreCandidate("path", cand("mcp_srv_ship", "x"))).toBe(1);
    expect(scoreCandidate("hello", cand("mcp_srv_ship", "x", { instructions: "say hello" }))).toBe(1);
    expect(scoreCandidate("", cand("mcp_srv_ship", "x"))).toBe(0);
  });

  test("ranks, caps at 20, bounds output bytes, and auto-selects within the schema budget", () => {
    const many = Array.from({ length: 25 }, (_, i) => cand(`mcp_srv_tool${i}`, "deploy things"));
    many.push(cand("mcp_srv_deploy", "deploy now"));
    const r = searchTools("deploy", many, limits);
    const out = JSON.parse(r.output);
    expect(out.tools[0].name).toBe("mcp_srv_deploy");
    expect(out.count).toBe(20);
    expect(out.total_matches).toBe(26);
    expect(r.selected.length).toBe(20);
    expect(r.notice).toBeUndefined();

    const bounded = searchTools("deploy", many, { ...limits, resultBytes: 400 });
    const b = JSON.parse(bounded.output);
    expect(b.count).toBeLessThan(20);
    expect(b.context_limit.name).toBe("mcp_search_result_bytes");
    expect(b.context_limit.omitted_count).toBe(20 - b.count);
    expect(Buffer.byteLength(bounded.output)).toBeLessThanOrEqual(400);

    const budget = searchTools("deploy", many, { ...limits, selectedSchemaBytes: 250 });
    expect(budget.selected).toEqual(["mcp_srv_deploy", "mcp_srv_tool0"]);
    expect(budget.notice).toBe(SCHEMA_BUDGET_NOTICE);
    expect(budget.notice).toBe(
      "[context] Additional MCP schemas exceed the search loading budget; narrow the search or select a tool explicitly.",
    );
  });

  test("truncates descriptions and reports no matches", () => {
    const r = searchTools("zzz", [cand("mcp_srv_a", "b")], limits);
    expect(JSON.parse(r.output)).toEqual({
      tools: [],
      count: 0,
      total_matches: 0,
      more_available: false,
      next_cursor: null,
    });
    const long = searchTools("srv", [cand("mcp_srv_a", "é".repeat(600))], { ...limits, descriptionBytes: 11 });
    expect(JSON.parse(long.output).tools[0].description).toBe("é".repeat(5));
  });
});
