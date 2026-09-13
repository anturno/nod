/** write_file: create or overwrite a file with complete contents. */
import { type Args, fail, isRecord, ok } from "./args.ts";
import {
  commit,
  diffCounts,
  editTargets,
  MAX_CONTENT_BYTES,
  MAX_PATH_BYTES,
  PATH_TOO_LONG,
  type Plan,
  parentExists,
  preparation,
  readPreimage,
  resolveTarget,
} from "./file_mutation.ts";
import type { DecodeResult, PermissionTarget, Preparation, ToolContext, ToolResult } from "./spec.ts";

export type Input = { path: string; content: string };

export function decode(args: unknown): DecodeResult<Input> {
  if (!isRecord(args)) return fail("write_file arguments must be an object");
  const a: Args = args;
  if (!("path" in a)) return fail('write_file requires string field "path"');
  if (typeof a.path !== "string") return fail('write_file field "path" must be a string');
  if (!("content" in a)) return fail('write_file requires string field "content"');
  if (typeof a.content !== "string") return fail('write_file field "content" must be a string');
  if (Buffer.byteLength(a.path) > MAX_PATH_BYTES) return fail(PATH_TOO_LONG);
  if (Buffer.byteLength(a.content) > MAX_CONTENT_BYTES) {
    return fail("write_file failed: content exceeds the 4 MiB preparation limit");
  }
  return ok({ path: a.path, content: a.content });
}

async function plan(input: Input, ctx: ToolContext): Promise<Plan> {
  const resolved = resolveTarget(input.path, ctx);
  if (!resolved.ok) return resolved;
  if (!(await parentExists(resolved.target.absolute))) {
    return { ok: false, failure: `write_file failed: parent directory does not exist for ${resolved.target.display}` };
  }
  const pre = await readPreimage("write_file", resolved.target);
  if ("failure" in pre) return { ok: false, failure: pre.failure };
  return {
    ok: true,
    target: resolved.target,
    before: pre.before,
    after: input.content,
    ...diffCounts(pre.before, input.content),
  };
}

export function targets(input: Input, ctx: ToolContext): PermissionTarget[] {
  const resolved = resolveTarget(input.path, ctx);
  return resolved.ok ? editTargets(resolved.target) : [];
}

export async function prepare(input: Input, ctx: ToolContext): Promise<Preparation> {
  const p = await plan(input, ctx);
  if (!p.ok) throw new Error(p.failure);
  return preparation("write_file", p);
}

export async function call(input: Input, ctx: ToolContext, prepared?: Preparation): Promise<ToolResult> {
  const p = await plan(input, ctx);
  if (!p.ok) return { status: "failure", output: p.failure };
  return commit(p, ctx, prepared, `Wrote ${p.target.display} (${Buffer.byteLength(input.content)} bytes)`);
}

export const label = (input: Input, ctx: ToolContext): string => {
  const resolved = resolveTarget(input.path, ctx);
  return `write_file ${resolved.ok ? resolved.target.display : input.path}`;
};
