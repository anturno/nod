/** subagent: delegate one task to a temporary child or message a named persistent child. */
import { isRecord } from "./args.ts";
import type { DecodeResult, ToolContext, ToolResult } from "./spec.ts";

export type Input =
  | { action: "run"; task: string; model?: string; effort?: string }
  | { action: "message"; agent: string; message: string; instructions?: string; model?: string; effort?: string };

const EFFORTS = new Set(["auto", "none", "minimal", "low", "medium", "high", "xhigh", "max"]);
const AGENT_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

class DecodeError extends Error {}
const reject = (code: string): never => {
  throw new DecodeError(code);
};

export const encodeResult = (value: Record<string, unknown>): string => JSON.stringify(value);

function requiredString(object: Record<string, unknown>, key: string): string {
  if (!(key in object)) reject("missing_field");
  const value = object[key];
  return typeof value === "string" ? value : reject("invalid_field_type");
}

function optionalString(object: Record<string, unknown>, key: string): string | undefined {
  if (!(key in object)) return undefined;
  const value = object[key];
  return typeof value === "string" ? value : reject("invalid_field_type");
}

function rejectUnknown(object: Record<string, unknown>, allowed: string[]): void {
  for (const key of Object.keys(object)) if (!allowed.includes(key)) reject("unknown_field");
}

function parseRoot(args: unknown): Input {
  if (!isRecord(args)) reject("invalid_field_type");
  const root = args as Record<string, unknown>;
  let request = root;
  if ("request" in root) {
    rejectUnknown(root, ["request"]);
    if (!isRecord(root.request)) reject("invalid_field_type");
    request = root.request as Record<string, unknown>;
  }
  const action = requiredString(request, "action");
  if (action === "run") {
    rejectUnknown(request, ["action", "task", "model", "effort"]);
    return {
      action,
      task: requiredString(request, "task"),
      model: optionalString(request, "model"),
      effort: optionalString(request, "effort"),
    };
  }
  if (action === "message") {
    rejectUnknown(request, ["action", "agent", "instructions", "message", "model", "effort"]);
    return {
      action,
      agent: requiredString(request, "agent"),
      instructions: optionalString(request, "instructions"),
      message: requiredString(request, "message"),
      model: optionalString(request, "model"),
      effort: optionalString(request, "effort"),
    };
  }
  return reject("invalid_enum");
}

function validate(input: Input): void {
  if (input.action === "run") {
    if (input.task.trim().length === 0) reject("invalid_task");
  } else {
    if (!AGENT_NAME.test(input.agent)) reject("invalid_agent");
    if (input.instructions !== undefined && input.instructions.trim().length === 0) reject("invalid_instructions");
    if (input.message.trim().length === 0) reject("invalid_message");
  }
  if (input.model !== undefined && input.model.trim().length === 0) reject("invalid_model");
  if (input.effort !== undefined && !EFFORTS.has(input.effort)) reject("invalid_effort");
}

export function decode(args: unknown): DecodeResult<Input> {
  try {
    const input = parseRoot(args);
    validate(input);
    return { ok: true, input };
  } catch (err) {
    if (err instanceof DecodeError) return { ok: false, failure: encodeResult({ ok: false, error_code: err.message }) };
    throw err;
  }
}

export async function call(input: Input, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.subagents) return { status: "failure", output: encodeResult({ ok: false, error_code: "host_unavailable" }) };
  const opts = { model: input.model, effort: input.effort };
  const outcome =
    input.action === "run"
      ? await ctx.subagents.run(input.task, opts, ctx.signal)
      : await ctx.subagents.message(
          input.agent,
          input.message,
          { ...opts, instructions: input.instructions },
          ctx.signal,
        );
  if (!outcome.ok) {
    const body: Record<string, unknown> = { ok: false, error_code: outcome.error_code };
    if (outcome.message) body.message = outcome.message;
    return { status: "failure", output: encodeResult(body) };
  }
  const body: Record<string, unknown> = { ok: true };
  if (input.action === "message") body.agent = input.agent;
  body.result = outcome.result;
  body.tool_calls = outcome.toolCalls;
  return { status: "success", output: encodeResult(body) };
}

export const label = (input: Input): string =>
  input.action === "run" ? "subagent.run" : `subagent.message ${input.agent}`;
