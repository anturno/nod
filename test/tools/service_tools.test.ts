import { describe, expect, test } from "bun:test";
import type { SkillService } from "../../src/core/skills/types.ts";
import * as mcp from "../../src/core/tools/mcp_tools.ts";
import * as skills from "../../src/core/tools/skills_tools.ts";
import * as webSearch from "../../src/core/tools/web_search.ts";
import { decodeFail, decodeOk, makeCtx, tempWorkspace } from "./helpers.ts";

const ws = tempWorkspace();

describe("web_search", () => {
  test("decode messages", () => {
    expect(decodeFail(webSearch.decode({}))).toBe('web_search field "query" is required');
    expect(decodeFail(webSearch.decode({ query: "a" }))).toBe(
      'web_search field "query" must contain at least two characters',
    );
    expect(decodeFail(webSearch.decode({ query: "ab", extra: 1 }))).toBe('web_search field "extra" is not supported');
    expect(decodeFail(webSearch.decode({ query: "ab", allowed_domains: "x" }))).toBe(
      'web_search field "allowed_domains" must be an array of strings',
    );
    expect(decodeFail(webSearch.decode({ query: "ab", blocked_domains: [1] }))).toBe(
      'web_search field "blocked_domains" item 0 must be a string',
    );
    expect(decodeFail(webSearch.decode({ query: "ab", allowed_domains: ["a.com"], blocked_domains: ["b.com"] }))).toBe(
      "web_search accepts only one non-empty domain filter",
    );
    expect(decodeOk(webSearch.decode({ query: " ab ", allowed_domains: ["a.com", " "] }))).toEqual({
      query: "ab",
      allowedDomains: ["a.com"],
      blockedDomains: [],
    });
  });

  test("call delegates or fails structurally", async () => {
    const input = decodeOk(webSearch.decode({ query: "bun test" }));
    expect(JSON.parse((await webSearch.call(input, makeCtx(ws))).output).error.type).toBe("tool_execution_failed");
    const ctx = makeCtx(ws, { webSearch: async (q, allowed) => `results ${q} ${allowed.length}` });
    expect(await webSearch.call(input, ctx)).toEqual({ status: "success", output: "results bun test 0" });
  });
});

describe("skills tools", () => {
  const service: SkillService = {
    list: () => [],
    read: async (location, resource) =>
      location === "/skills/a"
        ? { ok: true, text: `doc ${resource ?? "SKILL.md"}` }
        : { ok: false, error: "StaleSkillLocation" },
    install: async (source) => (source === "owner/repo" ? { installed: ["one", "two"] } : { installed: [] }),
    search: (query) => [
      {
        skill: { name: "a", description: `about ${query}`, dir: "/skills/a", location: "/skills/a", source: "user" },
        score: 0.5,
      },
    ],
  };

  test("skill reads complete documents and rejects escaping resources", async () => {
    expect(decodeFail(skills.decodeSkill({}))).toBe("skill requires an advertised location");
    expect(decodeFail(skills.decodeSkill({ location: "/skills/a", resource: null }))).toBe(
      'skill field "resource" must be a string',
    );
    expect(decodeFail(skills.decodeSkill({ location: "/skills/a", resource: "../x" }))).toContain("relative path");
    const ctx = makeCtx(ws, { skills: service });
    expect(await skills.callSkill(decodeOk(skills.decodeSkill({ location: "/skills/a", resource: "" })), ctx)).toEqual({
      status: "success",
      output: "doc SKILL.md",
      kind: "complete_skill",
    });
    expect((await skills.callSkill(decodeOk(skills.decodeSkill({ location: "/skills/zzz" })), ctx)).output).toBe(
      "skill failed: StaleSkillLocation. Refresh available skills and retry with an exact advertised location.",
    );
    expect(
      JSON.parse((await skills.callSkill(decodeOk(skills.decodeSkill({ location: "/skills/a" })), makeCtx(ws))).output)
        .error.tool_name,
    ).toBe("skill");
  });

  test("install_skill output strings", async () => {
    expect(decodeFail(skills.decodeInstall({}))).toBe('install_skill field "source" is required');
    expect(decodeFail(skills.decodeInstall({ source: 1 }))).toBe('install_skill field "source" must be a string');
    const ctx = makeCtx(ws, { skills: service });
    expect((await skills.callInstall(decodeOk(skills.decodeInstall({ source: "owner/repo" })), ctx)).output).toBe(
      "Installed 2 skill(s) into nod.\n- one\n- two",
    );
    expect((await skills.callInstall(decodeOk(skills.decodeInstall({ source: "x/y" })), ctx)).output).toBe(
      "No matching skills were installed into nod from x/y.",
    );
    expect((await skills.callInstall(decodeOk(skills.decodeInstall({ source: "x/y" })), makeCtx(ws))).output).toBe(
      "Skill installation is unavailable in this runtime.",
    );
  });

  test("capability_search lists skills and mcp selections", async () => {
    expect(decodeFail(skills.decodeSearch({ query: "" }))).toBe(
      'capability_search field "query" must contain 1-256 bytes',
    );
    const ctx = makeCtx(ws, {
      skills: service,
      mcp: {
        tools: () => [],
        search: async () => ({ text: "", selected: ["mcp_srv_tool"] }),
        select: async () => ({ ok: false, error: "no" }),
        features: async () => ({ status: "success", output: "" }),
        call: async () => ({ status: "success", output: "" }),
        serverNames: () => ["srv"],
      },
    });
    const result = await skills.callSearch(decodeOk(skills.decodeSearch({ query: "deploy" })), ctx);
    expect(JSON.parse(result.output)).toEqual({
      skills: [{ name: "a", location: "/skills/a", description: "about deploy", score: 0.5 }],
      count: 1,
      total_matches: 1,
      more_available: false,
      next_cursor: null,
      tools: ["mcp_srv_tool"],
      tool_count: 1,
    });
  });
});

describe("mcp tools", () => {
  test("decode and absent runtime", async () => {
    expect(decodeFail(mcp.decodeSelect([]))).toBe("Invalid mcp_select_tool arguments.");
    expect(decodeFail(mcp.decodeSelect({}))).toBe("mcp_select_tool requires an exact dynamic tool name.");
    expect(decodeFail(mcp.decodeFeatures({ action: "nope", server: "s" }))).toContain('mcp_features field "action"');
    expect(decodeFail(mcp.decodeFeatures({ action: "resource_list" }))).toBe(
      'mcp_features requires string field "server"',
    );
    const ctx = makeCtx(ws);
    const select = await mcp.callSelect(decodeOk(mcp.decodeSelect({ name: "mcp_a_b" })), ctx);
    expect(JSON.parse(select.output).error).toMatchObject({
      tool_name: "mcp_select_tool",
      message: "No MCP servers are configured.",
    });
    const features = await mcp.callFeatures(
      decodeOk(mcp.decodeFeatures({ action: "resource_list", server: "s" })),
      ctx,
    );
    expect(JSON.parse(features.output).error.message).toBe("No MCP servers are configured.");
  });
});
