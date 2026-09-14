/** Shared preparation and atomic write for write_file and edit_file. */
import { chmod, lstat, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { errorName, isAccessDenied } from "./args.ts";
import { filesystemAccessDenied, toolExecutionFailed } from "./errors.ts";
import { type PathError, type ResolvedPath, resolvePath } from "./paths.ts";
import type { PermissionTarget, Preparation, ToolContext, ToolResult } from "./spec.ts";

export const MAX_CONTENT_BYTES = 4 * 1024 * 1024;
export const MAX_PATH_BYTES = 4096;
export const PATH_TOO_LONG = "file mutation preparation failed: path exceeds the preparation limit";

export type Plan =
  | { ok: true; target: ResolvedPath; before: string | null; after: string; additions: number; deletions: number }
  | { ok: false; failure: string };

const splitLines = (text: string): string[] => {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
};

// ponytail: common prefix/suffix line diff; swap in a Myers diff if the counts ever need to be exact.
export function diffCounts(before: string | null, after: string): { additions: number; deletions: number } {
  const a = before === null ? [] : splitLines(before);
  const b = splitLines(after);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  return { additions: b.length - prefix - suffix, deletions: a.length - prefix - suffix };
}

export function resolveTarget(
  path: string,
  ctx: ToolContext,
): { ok: true; target: ResolvedPath } | { ok: false; failure: string } {
  let target: ResolvedPath;
  try {
    target = resolvePath(ctx.workspaceRoot, path, ctx.home, ctx.additionalDirectories);
  } catch (err) {
    return { ok: false, failure: `file mutation preparation failed: ${(err as PathError).message}` };
  }
  const name = basename(target.absolute);
  if (name === "" || name === "." || name === "..")
    return { ok: false, failure: "file mutation preparation failed: InvalidPath" };
  return { ok: true, target };
}

/** Current file text, null when absent, or a failure string. */
export async function readPreimage(
  tool: string,
  target: ResolvedPath,
): Promise<{ before: string | null } | { failure: string }> {
  let info: Awaited<ReturnType<typeof lstat>>;
  try {
    info = await lstat(target.absolute);
  } catch (err) {
    if (errorName(err) === "FileNotFound") return { before: null };
    if (isAccessDenied(err)) return { failure: filesystemAccessDenied(tool, target.display, errorName(err)) };
    return { failure: `file mutation preparation failed: ${errorName(err)}` };
  }
  if (!info.isFile()) return { failure: "file mutation preparation failed: target is not a regular file" };
  if (info.size > MAX_CONTENT_BYTES) {
    return { failure: "file mutation preparation failed: preimage exceeds the 4 MiB preparation limit" };
  }
  try {
    return { before: await readFile(target.absolute, "utf8") };
  } catch (err) {
    if (isAccessDenied(err)) return { failure: filesystemAccessDenied(tool, target.display, errorName(err)) };
    return { failure: "file mutation preparation failed: unable to read the approved preimage" };
  }
}

export function notFound(tool: string, display: string): string {
  return toolExecutionFailed(tool, `${tool} failed`, {
    details: { field: "path", path: display, error: "FileNotFound" },
    suggestion: "Run glob_files to discover matching paths, or check the path relative to the workspace.",
  });
}

export async function parentExists(absolute: string): Promise<boolean> {
  try {
    return (await stat(dirname(absolute))).isDirectory();
  } catch {
    return false;
  }
}

/** Writes via a temp file in the same directory and renames it over the target, keeping the mode. */
export async function writeAtomic(absolute: string, content: string, existed: boolean): Promise<void> {
  const tmp = join(dirname(absolute), `.${basename(absolute)}.${process.pid}.tmp`);
  let mode: number | undefined;
  if (existed) {
    try {
      mode = (await stat(absolute)).mode & 0o7777;
    } catch {}
  }
  await writeFile(tmp, content, { mode });
  if (mode !== undefined) await chmod(tmp, mode);
  await rename(tmp, absolute);
}

export function preparation(tool: string, plan: Extract<Plan, { ok: true }>): Preparation {
  return {
    title: `${tool} ${plan.target.display}`,
    diff: {
      path: plan.target.display,
      before: plan.before,
      after: plan.after,
      additions: plan.additions,
      deletions: plan.deletions,
    },
  };
}

export function editTargets(target: ResolvedPath): PermissionTarget[] {
  return [
    { permission: "edit", target: target.display, kind: "path", absolute: target.absolute, external: target.external },
  ];
}

/** Runs an approved plan: records the pre-image, writes atomically, and reports. */
export async function commit(
  plan: Extract<Plan, { ok: true }>,
  ctx: ToolContext,
  prepared: Preparation | undefined,
  success: string,
): Promise<ToolResult> {
  if (prepared?.diff && (prepared.diff.before !== plan.before || prepared.diff.after !== plan.after)) {
    return {
      status: "failure",
      output: "file mutation preparation failed: the file changed after approval; re-read it and retry",
    };
  }
  if (plan.before === plan.after) {
    return { status: "success", output: `No changes: ${plan.target.display} already matches the requested content` };
  }
  ctx.onFileMutation?.(plan.target.absolute, plan.before);
  try {
    await writeAtomic(plan.target.absolute, plan.after, plan.before !== null);
  } catch (err) {
    if (isAccessDenied(err))
      return { status: "failure", output: filesystemAccessDenied("write_file", plan.target.display, errorName(err)) };
    return { status: "failure", output: `file mutation failed: ${errorName(err)}` };
  }
  return { status: "success", output: success };
}
