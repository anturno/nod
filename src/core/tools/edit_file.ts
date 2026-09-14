/** edit_file: replace one exact occurrence of old_string with new_string. */
import { type Args, fail, isRecord, ok } from "./args.ts";
import {
  commit,
  diffCounts,
  editTargets,
  MAX_CONTENT_BYTES,
  MAX_PATH_BYTES,
  notFound,
  PATH_TOO_LONG,
  type Plan,
  preparation,
  readPreimage,
  resolveTarget,
} from "./file_mutation.ts";
import type { DecodeResult, PermissionTarget, Preparation, ToolContext, ToolResult } from "./spec.ts";

export type Input = { path: string; old_string: string; new_string: string };

export function decode(args: unknown): DecodeResult<Input> {
  if (!isRecord(args)) return fail("edit_file arguments must be an object");
  const a: Args = args;
  for (const key of ["path", "old_string", "new_string"] as const) {
    if (!(key in a)) return fail(`edit_file requires string field "${key}"`);
    if (typeof a[key] !== "string") return fail(`edit_file field "${key}" must be a string`);
  }
  const input = { path: a.path as string, old_string: a.old_string as string, new_string: a.new_string as string };
  if (Buffer.byteLength(input.path) > MAX_PATH_BYTES) return fail(PATH_TOO_LONG);
  if (Buffer.byteLength(input.old_string) > MAX_CONTENT_BYTES) {
    return fail("edit_file failed: old_string exceeds the 4 MiB preparation limit");
  }
  if (Buffer.byteLength(input.new_string) > MAX_CONTENT_BYTES) {
    return fail("edit_file failed: new_string exceeds the 4 MiB preparation limit");
  }
  return ok(input);
}

function countOccurrences(haystack: string, needle: string): number {
  if (needle.length === 0) return 0;
  let count = 0;
  let index = haystack.indexOf(needle);
  while (index !== -1) {
    count++;
    index = haystack.indexOf(needle, index + needle.length);
  }
  return count;
}

async function plan(input: Input, ctx: ToolContext): Promise<Plan> {
  if (input.old_string === input.new_string) {
    return { ok: false, failure: "edit_file failed: old_string and new_string are identical" };
  }
  const resolved = resolveTarget(input.path, ctx);
  if (!resolved.ok) return resolved;
  const pre = await readPreimage("edit_file", resolved.target);
  if ("failure" in pre) return { ok: false, failure: pre.failure };
  if (pre.before === null) return { ok: false, failure: notFound("edit_file", resolved.target.display) };
  const occurrences = countOccurrences(pre.before, input.old_string);
  if (occurrences === 0) return { ok: false, failure: "edit_file failed: old_string not found in file" };
  if (occurrences > 1) {
    return {
      ok: false,
      failure: `edit_file failed: old_string is not unique (found ${occurrences} occurrences), provide more context`,
    };
  }
  const after = pre.before.replace(input.old_string, () => input.new_string);
  if (Buffer.byteLength(after) > MAX_CONTENT_BYTES) {
    return { ok: false, failure: "edit_file failed: postimage exceeds the 4 MiB preparation limit" };
  }
  return { ok: true, target: resolved.target, before: pre.before, after, ...diffCounts(pre.before, after) };
}

export function targets(input: Input, ctx: ToolContext): PermissionTarget[] {
  const resolved = resolveTarget(input.path, ctx);
  return resolved.ok ? editTargets(resolved.target) : [];
}

export async function prepare(input: Input, ctx: ToolContext): Promise<Preparation> {
  const p = await plan(input, ctx);
  if (!p.ok) throw new Error(p.failure);
  return preparation("edit_file", p);
}

export async function call(input: Input, ctx: ToolContext, prepared?: Preparation): Promise<ToolResult> {
  const p = await plan(input, ctx);
  if (!p.ok) return { status: "failure", output: p.failure };
  return commit(p, ctx, prepared, `Edited ${p.target.display} (+${p.additions} -${p.deletions})`);
}

export const label = (input: Input, ctx: ToolContext): string => {
  const resolved = resolveTarget(input.path, ctx);
  return `edit_file ${resolved.ok ? resolved.target.display : input.path}`;
};
