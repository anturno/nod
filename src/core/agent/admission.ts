/** Turns a raw model tool call into an executable call, or into the error text the model reads instead. */
import { malformedArguments, nonObjectArguments, unknownTool } from "../tools/errors.ts";

import type { ToolContext, ToolSpec } from "../tools/spec.ts";
import type { ToolCall } from "./types.ts";

export type Admission =
  | { ok: true; call: ToolCall; spec: ToolSpec; input: unknown }
  | { ok: false; call: ToolCall; spec?: ToolSpec; failure: string; malformed: boolean };

export function admit(call: ToolCall, ctx: ToolContext, tools: ToolSpec[]): Admission {
  const spec = tools.find((t) => t.name === call.name);
  if (!spec) return { ok: false, call, failure: unknownTool(call.name), malformed: false };
  let parsed: unknown;
  try {
    parsed = JSON.parse(call.arguments.trim() === "" ? "{}" : call.arguments);
  } catch {
    return { ok: false, call, spec, failure: malformedArguments(call.name), malformed: true };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed))
    return { ok: false, call, spec, failure: nonObjectArguments(call.name), malformed: true };
  const decoded = spec.decode(parsed, ctx);
  if (!decoded.ok) return { ok: false, call, spec, failure: decoded.failure, malformed: false };
  return { ok: true, call, spec, input: decoded.input };
}
