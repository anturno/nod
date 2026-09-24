/** skill, install_skill, and capability_search: thin wrappers over the skill and MCP services. */
import { type Args, fail, isRecord, ok } from "./args.ts";
import { toolExecutionFailed } from "./errors.ts";
import type { DecodeResult, PermissionTarget, ToolContext, ToolResult } from "./spec.ts";

export type SkillInput = { location: string; resource?: string };
export type InstallInput = { source: string; skill?: string };
export type SearchInput = { query: string; server?: string };

const MAX_QUERY_BYTES = 256;

export function decodeSkill(args: unknown): DecodeResult<SkillInput> {
  if (!isRecord(args)) return fail("skill arguments must be an object");
  const a: Args = args;
  if (!("location" in a)) return fail("skill requires an advertised location");
  if (typeof a.location !== "string") return fail('skill field "location" must be a string');
  if ("resource" in a && typeof a.resource !== "string") return fail('skill field "resource" must be a string');
  const resource = typeof a.resource === "string" && a.resource.length > 0 ? a.resource : undefined;
  if (resource && (resource.startsWith("/") || resource.split("/").includes(".."))) {
    return fail('skill field "resource" must be a relative path inside the skill');
  }
  return ok({ location: a.location, resource });
}

export async function callSkill(input: SkillInput, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.skills)
    return { status: "failure", output: toolExecutionFailed("skill", "Skills are unavailable in this runtime.") };
  const read = await ctx.skills.read(input.location, input.resource);
  if (!read.ok) {
    return {
      status: "failure",
      output: `skill failed: ${read.error}. Refresh available skills and retry with an exact advertised location.`,
    };
  }
  if (Buffer.byteLength(read.text) > ctx.maxToolResultBytes) {
    return {
      status: "failure",
      output: `skill failed: resource exceeds the ${ctx.maxToolResultBytes} byte tool result limit`,
    };
  }
  return { status: "success", output: read.text, kind: "complete_skill" };
}

export const skillTargets = (input: SkillInput): PermissionTarget[] => [
  { permission: "skill", target: input.location, kind: "other" },
];
export const skillLabel = (input: SkillInput): string =>
  `skill ${input.location}${input.resource ? ` ${input.resource}` : ""}`;

export function decodeInstall(args: unknown): DecodeResult<InstallInput> {
  if (!isRecord(args)) return fail("install_skill arguments must be an object");
  const a: Args = args;
  if (!("source" in a)) return fail('install_skill field "source" is required');
  if (typeof a.source !== "string") return fail('install_skill field "source" must be a string');
  if ("skill" in a && typeof a.skill !== "string") return fail('install_skill field "skill" must be a string');
  return ok({ source: a.source, skill: typeof a.skill === "string" && a.skill.length > 0 ? a.skill : undefined });
}

export async function callInstall(input: InstallInput, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.skills) return { status: "failure", output: "Skill installation is unavailable in this runtime." };
  const result = await ctx.skills.install(input.source, input.skill);
  if (result.error) return { status: "failure", output: `install_skill failed: ${result.error}` };
  if (result.installed.length === 0) {
    return { status: "success", output: `No matching skills were installed into nod from ${input.source}.` };
  }
  return {
    status: "success",
    output: `Installed ${result.installed.length} skill(s) into nod.\n${result.installed.map((name) => `- ${name}`).join("\n")}`,
  };
}

export const installTargets = (input: InstallInput): PermissionTarget[] => [
  { permission: "skill", target: input.source, kind: "other" },
];
export const installLabel = (input: InstallInput): string => `install_skill ${input.source}`;

export function decodeSearch(args: unknown): DecodeResult<SearchInput> {
  if (!isRecord(args)) return fail("capability_search arguments must be an object");
  const a: Args = args;
  if (typeof a.query !== "string") return fail('capability_search requires string field "query"');
  if (a.query.length === 0 || Buffer.byteLength(a.query) > MAX_QUERY_BYTES) {
    return fail(`capability_search field "query" must contain 1-${MAX_QUERY_BYTES} bytes`);
  }
  if ("server" in a && (typeof a.server !== "string" || a.server.length === 0)) {
    return fail('capability_search field "server" must be a non-empty string');
  }
  return ok({ query: a.query, server: typeof a.server === "string" ? a.server : undefined });
}

type McpSearchJson = {
  tools?: unknown[];
  total_matches?: number;
  state?: string;
  authentication_required?: unknown;
  context_limit?: unknown;
};

/** Merges the skill hits and the MCP search into the combined shape: skills, mcp_tools, counts, total_matches, state. */
export async function callSearch(input: SearchInput, ctx: ToolContext): Promise<ToolResult> {
  const hits = ctx.skills?.search(input.query) ?? [];
  const skills = hits.map(({ skill, score }) => ({
    name: skill.name,
    location: skill.location,
    description: skill.description,
    score,
  }));
  let mcp: McpSearchJson = {};
  let notice: string | undefined;
  let mcpError: string | undefined;
  if (ctx.mcp) {
    try {
      const result = await ctx.mcp.search(input.query, input.server);
      notice = result.notice;
      mcp = JSON.parse(result.text) as McpSearchJson;
    } catch (err) {
      mcpError = err instanceof Error ? err.message : String(err);
    }
  }
  const mcpTools = Array.isArray(mcp.tools) ? mcp.tools : [];
  const mcpTotal = typeof mcp.total_matches === "number" ? mcp.total_matches : mcpTools.length;
  const out: Record<string, unknown> = {
    skills,
    mcp_tools: mcpTools,
    counts: { skills: skills.length, mcp_tools: mcpTools.length },
    total_matches: { skills: skills.length, mcp_tools: mcpTotal },
  };
  if (skills.length === 0 && mcpTotal === 0 && !mcp.state && !mcp.authentication_required && !mcpError)
    out.state = "no_match";
  if (mcp.authentication_required !== undefined) out.authentication_required = mcp.authentication_required;
  if (mcp.state !== undefined) out.mcp_state = mcp.state;
  if (mcpError !== undefined) out.mcp_error = mcpError;
  if (mcp.context_limit !== undefined) out.mcp_context_limit = mcp.context_limit;
  return { status: "success", output: `${JSON.stringify(out)}${notice ? `\n${notice}` : ""}` };
}

export const searchLabel = (input: SearchInput): string => `capability_search ${input.query}`;
