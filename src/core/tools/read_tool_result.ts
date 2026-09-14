/** read_tool_result: page or search a stored tool result or retained command output by handle. */
import { type Args, fail, isRecord, ok } from "./args.ts";
import {
  READ_DEFAULT_BYTES,
  READ_MAX_BYTES,
  readByRange,
  searchByQuery,
  unknownHandleMessage,
} from "./result_store.ts";
import type { DecodeResult, ToolContext, ToolResult } from "./spec.ts";

export type Input = { handle: string; startByte: number; byteCount: number; query?: string };

export const COMMAND_HANDLE_PREFIX = "nod-command-";

export function decode(args: unknown): DecodeResult<Input> {
  if (!isRecord(args)) return fail("read_tool_result arguments must be an object");
  let a: Args = args;
  if ("request" in a) {
    if (!isRecord(a.request)) return fail('read_tool_result field "request" must be an object');
    a = a.request;
  }
  if (!("handle" in a)) return fail('read_tool_result requires string field "handle"');
  if (typeof a.handle !== "string") return fail('read_tool_result field "handle" must be a string');
  const input: Input = { handle: a.handle, startByte: 1, byteCount: READ_DEFAULT_BYTES };
  if ("start_byte" in a) {
    if (!Number.isInteger(a.start_byte) || (a.start_byte as number) < 1) {
      return fail('read_tool_result field "start_byte" must be a positive integer');
    }
    input.startByte = a.start_byte as number;
  }
  if ("byte_count" in a) {
    if (!Number.isInteger(a.byte_count) || (a.byte_count as number) < 1) {
      return fail('read_tool_result field "byte_count" must be a positive integer');
    }
    input.byteCount = Math.min(a.byte_count as number, READ_MAX_BYTES);
  }
  if ("query" in a) {
    if (typeof a.query !== "string") return fail('read_tool_result field "query" must be a string');
    if (a.query.length > 0) input.query = a.query;
  }
  const trimmed = input.handle.trim();
  if (trimmed.length === 0) return fail('read_tool_result field "handle" must not be empty');
  input.handle = trimmed.startsWith("result-") && !trimmed.includes(".") ? `${trimmed}.txt` : trimmed;
  return ok(input);
}

export async function call(input: Input, ctx: ToolContext): Promise<ToolResult> {
  const { handle } = input;
  try {
    let output: string | null;
    if (handle.startsWith(COMMAND_HANDLE_PREFIX)) {
      if (!ctx.shell) return { status: "failure", output: unknownHandleMessage(handle) };
      output = input.query
        ? await ctx.shell.searchRetained(handle, input.query)
        : await ctx.shell.readRetained(handle, input.startByte, input.byteCount);
    } else {
      output = input.query
        ? await searchByQuery(ctx.resultDir, handle, input.query)
        : await readByRange(ctx.resultDir, handle, input.startByte, input.byteCount);
    }
    if (output === null) return { status: "failure", output: unknownHandleMessage(handle) };
    return { status: "success", output };
  } catch (err) {
    const name = err instanceof Error ? err.message : String(err);
    if (name === "ResultHandleNotFound") return { status: "failure", output: unknownHandleMessage(handle) };
    return { status: "failure", output: `read_tool_result failed for handle ${handle}: ${name}` };
  }
}

export const label = (input: Input): string => `read_tool_result ${input.handle}`;
