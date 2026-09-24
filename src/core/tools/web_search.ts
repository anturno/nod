/** web_search: function-tool fallback that delegates to the host's search service. */
import { type Args, fail, isRecord, ok } from "./args.ts";
import { toolExecutionFailed } from "./errors.ts";
import type { DecodeResult, ToolContext, ToolResult } from "./spec.ts";

export type Input = { query: string; allowedDomains: string[]; blockedDomains: string[] };

function domains(a: Args, field: string): string[] | string {
  if (!(field in a)) return [];
  const value = a[field];
  if (!Array.isArray(value)) return `web_search field "${field}" must be an array of strings`;
  const out: string[] = [];
  for (const [index, item] of value.entries()) {
    if (typeof item !== "string") return `web_search field "${field}" item ${index} must be a string`;
    if (item.trim().length > 0) out.push(item.trim());
  }
  return out;
}

export function decode(args: unknown): DecodeResult<Input> {
  if (!isRecord(args)) return fail("web_search arguments must be an object");
  const a: Args = args;
  for (const key of Object.keys(a)) {
    if (!["query", "allowed_domains", "blocked_domains"].includes(key))
      return fail(`web_search field "${key}" is not supported`);
  }
  if (!("query" in a)) return fail('web_search field "query" is required');
  if (typeof a.query !== "string") return fail('web_search field "query" must be a string');
  if (a.query.trim().length < 2) return fail('web_search field "query" must contain at least two characters');
  const allowed = domains(a, "allowed_domains");
  if (typeof allowed === "string") return fail(allowed);
  const blocked = domains(a, "blocked_domains");
  if (typeof blocked === "string") return fail(blocked);
  if (allowed.length > 0 && blocked.length > 0) return fail("web_search accepts only one non-empty domain filter");
  return ok({ query: a.query.trim(), allowedDomains: allowed, blockedDomains: blocked });
}

export async function call(input: Input, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.webSearch) {
    return {
      status: "failure",
      output: toolExecutionFailed("web_search", "Web search is unavailable in this runtime."),
    };
  }
  try {
    return {
      status: "success",
      output: await ctx.webSearch(input.query, input.allowedDomains, input.blockedDomains, ctx.signal),
    };
  } catch (err) {
    return {
      status: "failure",
      output: toolExecutionFailed("web_search", err instanceof Error ? err.message : String(err)),
    };
  }
}

export const label = (input: Input): string => `web_search ${input.query}`;
