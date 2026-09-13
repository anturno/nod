import { describe, expect, test } from "bun:test";
import type { McpService } from "../../src/core/mcp/types.ts";
import type { SkillService } from "../../src/core/skills/types.ts";
import * as mcp from "../../src/core/tools/mcp_tools.ts";
import * as skills from "../../src/core/tools/skills_tools.ts";
import { decodeOk, makeCtx, tempWorkspace } from "./helpers.ts";

const ws = tempWorkspace();
const skillService: SkillService = {
  list: () => [],
  read: async () => ({ ok: false, error: "x" }),
  install: async () => ({ installed: [] }),
  search: (query) =>
    query === "deploy"
      ? [
          {
            skill: { name: "a", description: "about deploy", dir: "/s/a", location: "/s/a", source: "user" },
            score: 0.5,
          },
        ]
      : [],
};
const service = (search: McpService["search"]): McpService => ({
  tools: () => [],
  search,
  select: async (name) =>
    name === "mcp_srv_tool"
      ? { ok: true, text: '{"name":"mcp_srv_tool"}' }
      : { ok: false, error: "tool no longer available" },
  features: async () => ({ status: "success", output: "{}" }),
  call: async () => ({ status: "success", output: "" }),
  serverNames: () => ["srv"],
});
const search = (query: string, ctx: ReturnType<typeof makeCtx>) =>
  skills.callSearch(decodeOk(skills.decodeSearch({ query })), ctx);

describe("capability_search with MCP", () => {
  test("merges skills and mcp tools into fx's combined shape and appends the notice", async () => {
    const mcpText = JSON.stringify({
      tools: [{ name: "mcp_srv_tool", server: "srv", description: "deploys" }],
      count: 1,
      total_matches: 3,
    });
    const ctx = makeCtx(ws, {
      skills: skillService,
      mcp: service(async () => ({ text: mcpText, selected: ["mcp_srv_tool"], notice: "[context] note" })),
    });
    const result = await search("deploy", ctx);
    const [json, notice] = result.output.split("\n");
    expect(JSON.parse(json as string)).toEqual({
      skills: [{ name: "a", location: "/s/a", description: "about deploy", score: 0.5 }],
      mcp_tools: [{ name: "mcp_srv_tool", server: "srv", description: "deploys" }],
      counts: { skills: 1, mcp_tools: 1 },
      total_matches: { skills: 1, mcp_tools: 3 },
    });
    expect(notice).toBe("[context] note");
  });

  test("no_match, passthrough states, and search failures", async () => {
    const none = await search(
      "zzz",
      makeCtx(ws, {
        skills: skillService,
        mcp: service(async () => ({ text: JSON.stringify({ tools: [], count: 0, total_matches: 0 }), selected: [] })),
      }),
    );
    expect(JSON.parse(none.output)).toEqual({
      skills: [],
      mcp_tools: [],
      counts: { skills: 0, mcp_tools: 0 },
      total_matches: { skills: 0, mcp_tools: 0 },
      state: "no_match",
    });
    const authText = JSON.stringify({
      tools: [],
      count: 0,
      authentication_required: { server: "srv", interactive: true, message: "m" },
      state: "server_not_found",
      context_limit: { name: "x" },
    });
    const auth = JSON.parse(
      (
        await search(
          "zzz",
          makeCtx(ws, { skills: skillService, mcp: service(async () => ({ text: authText, selected: [] })) }),
        )
      ).output,
    );
    expect(auth.authentication_required).toEqual({ server: "srv", interactive: true, message: "m" });
    expect(auth.mcp_state).toBe("server_not_found");
    expect(auth.mcp_context_limit).toEqual({ name: "x" });
    expect(auth.state).toBeUndefined();
    const failed = JSON.parse(
      (
        await search(
          "zzz",
          makeCtx(ws, {
            mcp: service(async () => {
              throw new Error("down");
            }),
          }),
        )
      ).output,
    );
    expect(failed.mcp_error).toBe("down");
    expect(failed.state).toBeUndefined();
    expect(JSON.parse((await search("zzz", makeCtx(ws))).output).state).toBe("no_match");
  });
});

describe("mcp_select_tool with a service", () => {
  test("passes the schema text through and surfaces stale aliases", async () => {
    const ctx = makeCtx(ws, { mcp: service(async () => ({ text: "", selected: [] })) });
    expect(await mcp.callSelect({ name: "mcp_srv_tool" }, ctx)).toEqual({
      status: "success",
      output: '{"name":"mcp_srv_tool"}',
    });
    const stale = await mcp.callSelect({ name: "mcp_srv_old" }, ctx);
    expect(JSON.parse(stale.output).error.message).toBe("tool no longer available");
    expect(await mcp.callFeatures({ request: { action: "resource_list", server: "srv" } }, ctx)).toEqual({
      status: "success",
      output: "{}",
    });
  });
});
