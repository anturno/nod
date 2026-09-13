/** mcp_select_tool and mcp_features: thin wrappers over the MCP service. */
import { type Args, fail, isRecord, ok } from "./args.ts";
import { toolExecutionFailed } from "./errors.ts";
import type { DecodeResult, ToolContext, ToolResult } from "./spec.ts";

export type SelectInput = { name: string };
export type FeaturesInput = { request: Record<string, unknown> & { action: string; server: string } };

export const FEATURE_ACTIONS = [
  "resource_list",
  "resource_templates",
  "resource_read",
  "prompt_list",
  "prompt_get",
  "prompt_complete",
  "resource_complete",
] as const;

const NO_SERVERS = "No MCP servers are configured.";

export function decodeSelect(args: unknown): DecodeResult<SelectInput> {
  if (!isRecord(args)) return fail("Invalid mcp_select_tool arguments.");
  if (typeof args.name !== "string" || args.name.length === 0)
    return fail("mcp_select_tool requires an exact dynamic tool name.");
  return ok({ name: args.name });
}

export async function callSelect(input: SelectInput, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.mcp) return { status: "failure", output: toolExecutionFailed("mcp_select_tool", NO_SERVERS) };
  const result = await ctx.mcp.select(input.name);
  if (!result.ok) return { status: "failure", output: toolExecutionFailed("mcp_select_tool", result.error) };
  return { status: "success", output: result.text };
}

export function decodeFeatures(args: unknown): DecodeResult<FeaturesInput> {
  if (!isRecord(args)) return fail("mcp_features arguments must be an object");
  const a: Args = args;
  if (typeof a.action !== "string" || !(FEATURE_ACTIONS as readonly string[]).includes(a.action)) {
    return fail(`mcp_features field "action" must be one of ${FEATURE_ACTIONS.join(", ")}`);
  }
  if (typeof a.server !== "string" || a.server.length === 0) return fail('mcp_features requires string field "server"');
  return ok({ request: { ...a, action: a.action, server: a.server } });
}

export async function callFeatures(input: FeaturesInput, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.mcp) return { status: "failure", output: toolExecutionFailed("mcp_features", NO_SERVERS) };
  return ctx.mcp.features(input.request, ctx.signal);
}

export const selectLabel = (input: SelectInput): string => `mcp_select_tool ${input.name}`;
export const featuresLabel = (input: FeaturesInput): string =>
  `mcp_features ${input.request.action} ${input.request.server}`;
