/** glob_files: list or count paths matching a glob under a search root. */
import { stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { type Args, errorName, fail, isAccessDenied, isRecord, ok } from "./args.ts";
import { filesystemAccessDenied } from "./errors.ts";
import { type PathError, type ResolvedPath, resolvePath } from "./paths.ts";
import { MAX_LIST_ENTRIES } from "./result_store.ts";
import type { DecodeResult, PermissionTarget, ToolContext, ToolResult } from "./spec.ts";

export type Input = { pattern: string; path: string; mode: "matches" | "count" };

export const IGNORED_DIRECTORY_NAMES = new Set([
  ".git",
  ".zig-cache",
  "zig-out",
  "node_modules",
  ".next",
  "dist",
  "build",
  "coverage",
]);
export const MAX_PATTERN_BYTES = 4096;

export function decode(args: unknown): DecodeResult<Input> {
  if (!isRecord(args)) return fail("glob_files arguments must be an object");
  const a: Args = args;
  if (!("pattern" in a)) return fail('glob_files requires string field "pattern"');
  if (typeof a.pattern !== "string") return fail('glob_files field "pattern" must be a string');
  const path = typeof a.path === "string" && a.path.length > 0 ? a.path : ".";
  return ok({ pattern: a.pattern, path, mode: a.mode === "count" ? "count" : "matches" });
}

/** Candidates inside ignored directories are skipped unless the pattern names that directory itself. */
export function isIgnored(relative: string, pattern: string): boolean {
  const named = new Set(pattern.split("/").filter((c) => IGNORED_DIRECTORY_NAMES.has(c)));
  return relative
    .split("/")
    .slice(0, -1)
    .some((c) => IGNORED_DIRECTORY_NAMES.has(c) && !named.has(c));
}

const hasHiddenComponent = (path: string) => path.split("/").some((c) => c.startsWith(".") && c !== "." && c !== "..");

export async function listMatches(root: ResolvedPath, pattern: string): Promise<string[] | { failure: string }> {
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(root.absolute);
  } catch (err) {
    if (isAccessDenied(err)) return { failure: filesystemAccessDenied("glob_files", root.display, errorName(err)) };
    return { failure: `Unable to resolve glob search root: ${root.display} (${errorName(err)})` };
  }
  const cleaned = pattern.replace(/^(\.\/)+/, "");
  const glob = new Bun.Glob(cleaned);
  if (!info.isDirectory()) return glob.match(basename(root.absolute)) ? [root.display] : [];
  const matches: string[] = [];
  try {
    for await (const rel of glob.scan({
      cwd: root.absolute,
      onlyFiles: true,
      followSymlinks: false,
      dot: hasHiddenComponent(cleaned) || hasHiddenComponent(root.display),
    })) {
      if (isIgnored(rel, cleaned)) continue;
      matches.push(root.display === "." ? rel : join(root.display, rel));
    }
  } catch (err) {
    if (isAccessDenied(err)) return { failure: filesystemAccessDenied("glob_files", root.display, errorName(err)) };
    return { failure: `Unable to discover glob candidates: ${root.display} (${errorName(err)})` };
  }
  return matches.sort();
}

// ponytail: full filesystem walk via Bun.Glob; switch to `git ls-files` candidates if large repos feel slow.
export async function call(input: Input, ctx: ToolContext): Promise<ToolResult> {
  if (Buffer.byteLength(input.pattern) > MAX_PATTERN_BYTES) {
    return { status: "failure", output: `glob_files field "pattern" must be at most ${MAX_PATTERN_BYTES} bytes` };
  }
  let root: ResolvedPath;
  try {
    root = resolvePath(ctx.workspaceRoot, input.path, ctx.home, ctx.additionalDirectories);
  } catch (err) {
    return {
      status: "failure",
      output: `Unable to resolve glob search root: ${input.path} (${(err as PathError).message})`,
    };
  }
  const found = await listMatches(root, input.pattern);
  if (!Array.isArray(found)) return { status: "failure", output: found.failure };
  if (input.mode === "count")
    return { status: "success", output: `[glob] count ${found.length} matches for ${input.pattern}\n` };
  if (found.length === 0) return { status: "success", output: `[glob] no matches for ${input.pattern}\n` };
  const shown = found.slice(0, MAX_LIST_ENTRIES);
  let out = `[glob] ${shown.length} matches for ${input.pattern}\n`;
  for (const match of shown) out += ` - ${match}\n`;
  if (found.length > shown.length) out += `... truncated to first ${MAX_LIST_ENTRIES} matches\n`;
  return { status: "success", output: out };
}

export function targets(input: Input, ctx: ToolContext): PermissionTarget[] {
  try {
    const t = resolvePath(ctx.workspaceRoot, input.path, ctx.home, ctx.additionalDirectories);
    return [{ permission: "glob", target: t.display, kind: "path", absolute: t.absolute, external: t.external }];
  } catch {
    return [];
  }
}

export const label = (input: Input): string => `glob_files ${input.pattern}`;
