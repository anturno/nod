/** grep_files: literal substring search with matches, files_with_matches, and count modes. */
import { readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { type Args, errorName, fail, isAccessDenied, isRecord, ok, optionalInt } from "./args.ts";
import { filesystemAccessDenied } from "./errors.ts";
import { isIgnored, MAX_PATTERN_BYTES } from "./glob_files.ts";
import { type PathError, type ResolvedPath, resolvePath } from "./paths.ts";
import { MAX_LIST_ENTRIES, MAX_READ_LINE_LEN } from "./result_store.ts";
import type { DecodeResult, PermissionTarget, ToolContext, ToolResult } from "./spec.ts";

export type Mode = "matches" | "files_with_matches" | "count";
export type Input = {
  pattern: string;
  path: string;
  include?: string;
  caseInsensitive: boolean;
  mode: Mode;
  headLimit: number;
  offset: number;
  contextLines: number;
};

export const CONTEXT_LINES_CAP = 5;
export const COLLECTION_CAP = 10_000;
const CONTEXT_FILE_BYTE_CAP = 200 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const BINARY_PROBE_BYTES = 8 * 1024;

export function decode(args: unknown): DecodeResult<Input> {
  if (!isRecord(args)) return fail("grep_files arguments must be an object");
  const a: Args = args;
  if (!("pattern" in a)) return fail('grep_files requires string field "pattern"');
  if (typeof a.pattern !== "string") return fail('grep_files field "pattern" must be a string');
  const headLimit = optionalInt(a, "head_limit", 1, "grep_files", "positive");
  if (typeof headLimit === "object") return fail(headLimit.failure);
  const offset = optionalInt(a, "offset", 0, "grep_files", "non-negative");
  if (typeof offset === "object") return fail(offset.failure);
  const contextLines = optionalInt(a, "context_lines", 0, "grep_files", "non-negative");
  if (typeof contextLines === "object") return fail(contextLines.failure);
  const mode: Mode = a.mode === "count" || a.mode === "files_with_matches" ? a.mode : "matches";
  return ok({
    pattern: a.pattern,
    path: typeof a.path === "string" && a.path.length > 0 ? a.path : ".",
    include: typeof a.include === "string" ? a.include : undefined,
    caseInsensitive: a.case_insensitive === true,
    mode,
    headLimit: Math.min(headLimit ?? MAX_LIST_ENTRIES, MAX_LIST_ENTRIES),
    offset: offset ?? 0,
    contextLines: Math.min(contextLines ?? 0, CONTEXT_LINES_CAP),
  });
}

type Match = { absolute: string; display: string; line: number; text: string };
type Scan = { matches: Match[]; matchingLines: number; matchingFiles: number; capped: boolean };

const fatal = new TextDecoder("utf-8", { fatal: true });

/** Lines of a text file without the synthetic empty line after a final newline. */
export function realLines(text: string): string[] {
  const lines = text.split("\n");
  if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

async function readText(absolute: string): Promise<string | null> {
  let bytes: Buffer;
  try {
    bytes = await readFile(absolute);
  } catch {
    return null;
  }
  if (bytes.length > MAX_FILE_BYTES || bytes.subarray(0, BINARY_PROBE_BYTES).includes(0)) return null;
  try {
    return fatal.decode(bytes);
  } catch {
    return null;
  }
}

async function scan(root: ResolvedPath, isDir: boolean, input: Input): Promise<Scan> {
  const include = input.include ? new Bun.Glob(input.include) : null;
  const needle = input.caseInsensitive ? input.pattern.toLowerCase() : input.pattern;
  const files: { absolute: string; display: string }[] = [];
  if (isDir) {
    const rels: string[] = [];
    for await (const rel of new Bun.Glob("**/*").scan({
      cwd: root.absolute,
      onlyFiles: true,
      dot: true,
      followSymlinks: false,
    })) {
      if (isIgnored(rel, input.include ?? "")) continue;
      if (include && !include.match(rel) && !include.match(basename(rel))) continue;
      rels.push(rel);
    }
    rels.sort();
    for (const rel of rels) {
      files.push({ absolute: join(root.absolute, rel), display: root.display === "." ? rel : join(root.display, rel) });
    }
  } else if (!include || include.match(basename(root.absolute))) {
    files.push({ absolute: root.absolute, display: root.display });
  }
  const result: Scan = { matches: [], matchingLines: 0, matchingFiles: 0, capped: false };
  for (const file of files) {
    const text = await readText(file.absolute);
    if (text === null) continue;
    let hit = false;
    const lines = realLines(text);
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]!;
      const haystack = input.caseInsensitive ? line.toLowerCase() : line;
      if (!haystack.includes(needle)) continue;
      hit = true;
      result.matchingLines++;
      if (input.mode === "count") continue;
      if (result.matches.length >= COLLECTION_CAP) {
        result.capped = true;
        return result;
      }
      result.matches.push({ absolute: file.absolute, display: file.display, line: i + 1, text: line });
    }
    if (hit) result.matchingFiles++;
  }
  return result;
}

const clip = (line: string) => (line.length > MAX_READ_LINE_LEN ? `${line.slice(0, MAX_READ_LINE_LEN)}...` : line);

async function contextFor(absolute: string, cache: Map<string, string[] | null>): Promise<string[] | null> {
  if (cache.has(absolute)) return cache.get(absolute)!;
  let lines: string[] | null = null;
  try {
    const info = await stat(absolute);
    if (info.size <= CONTEXT_FILE_BYTE_CAP) {
      const text = await readText(absolute);
      if (text !== null) lines = realLines(text);
    }
  } catch {}
  cache.set(absolute, lines);
  return lines;
}

function paginate<T>(items: T[], input: Input): { start: number; end: number; page: T[] } {
  const start = Math.min(input.offset, items.length);
  const end = Math.min(start + input.headLimit, items.length);
  return { start, end, page: items.slice(start, end) };
}

async function formatMatches(scanned: Scan, input: Input): Promise<string> {
  const { matches } = scanned;
  const { start, end, page } = paginate(matches, input);
  let out: string;
  if (matches.length === 0) out = `[grep] no matches for ${input.pattern}\n`;
  else if (page.length === 0) {
    out = `[grep] no matches for ${input.pattern} at offset ${input.offset} (${matches.length} total matches)\n`;
  } else {
    out =
      start === 0 && end === matches.length
        ? `[grep] ${page.length} matches for ${input.pattern}\n`
        : `[grep] ${page.length} matches for ${input.pattern} (showing ${start + 1}-${end} of ${matches.length})\n`;
    const cache = new Map<string, string[] | null>();
    for (const m of page) {
      const context = input.contextLines > 0 ? await contextFor(m.absolute, cache) : null;
      const emit = (from: number, to: number) => {
        for (let n = Math.max(1, from); n < to && n <= (context?.length ?? 0); n++) {
          out += `   ${m.display}:${n}- ${clip(context![n - 1]!)}\n`;
        }
      };
      if (context) emit(m.line - input.contextLines, m.line);
      out += ` - ${m.display}:${m.line}: ${clip(m.text)}\n`;
      if (context) emit(m.line + 1, m.line + input.contextLines + 1);
    }
  }
  if (end < matches.length) out += `... more matches available; use offset ${end} to continue\n`;
  if (scanned.capped) {
    out += `... match collection cap reached at ${COLLECTION_CAP} matches before all candidate files were scanned\n`;
  }
  return out;
}

function formatFiles(scanned: Scan, input: Input): string {
  const files = [...new Set(scanned.matches.map((m) => m.display))];
  const { start, end, page } = paginate(files, input);
  let out: string;
  if (files.length === 0) out = `[grep] no files with matches for ${input.pattern}\n`;
  else if (page.length === 0) {
    out = `[grep] no files with matches for ${input.pattern} at offset ${input.offset} (${files.length} total files)\n`;
  } else {
    out =
      start === 0 && end === files.length
        ? `[grep] ${page.length} files with matches for ${input.pattern}\n`
        : `[grep] ${page.length} files with matches for ${input.pattern} (showing ${start + 1}-${end} of ${files.length})\n`;
    for (const path of page) out += ` - ${path}\n`;
  }
  if (end < files.length) out += `... more files available; use offset ${end} to continue\n`;
  if (scanned.capped) {
    out += `... match collection cap reached at ${COLLECTION_CAP} matches before all candidate files were scanned\n`;
  }
  return out;
}

export async function call(input: Input, ctx: ToolContext): Promise<ToolResult> {
  let root: ResolvedPath;
  try {
    root = resolvePath(ctx.workspaceRoot, input.path, ctx.home, ctx.additionalDirectories);
  } catch (err) {
    return {
      status: "failure",
      output: `Unable to resolve grep search root: ${input.path} (${(err as PathError).message})`,
    };
  }
  if (input.include && Buffer.byteLength(input.include) > MAX_PATTERN_BYTES) {
    return { status: "failure", output: `grep_files field "include" must be at most ${MAX_PATTERN_BYTES} bytes` };
  }
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(root.absolute);
  } catch (err) {
    if (isAccessDenied(err))
      return { status: "failure", output: filesystemAccessDenied("grep_files", root.display, errorName(err)) };
    return { status: "failure", output: `Unable to resolve grep search root: ${input.path} (${errorName(err)})` };
  }
  if (!info.isDirectory() && !info.isFile()) {
    return { status: "failure", output: `Not a regular file or directory: ${root.absolute}` };
  }
  let scanned: Scan;
  try {
    scanned = await scan(root, info.isDirectory(), input);
  } catch (err) {
    if (isAccessDenied(err))
      return { status: "failure", output: filesystemAccessDenied("grep_files", root.display, errorName(err)) };
    return { status: "failure", output: `Unable to walk grep search root: ${root.absolute} (${errorName(err)})` };
  }
  if (input.mode === "count") {
    return {
      status: "success",
      output: `[grep] count ${scanned.matchingLines} matching lines in ${scanned.matchingFiles} files for ${input.pattern}\n`,
    };
  }
  return {
    status: "success",
    output: input.mode === "matches" ? await formatMatches(scanned, input) : formatFiles(scanned, input),
  };
}

export function targets(input: Input, ctx: ToolContext): PermissionTarget[] {
  try {
    const t = resolvePath(ctx.workspaceRoot, input.path, ctx.home, ctx.additionalDirectories);
    return [{ permission: "grep", target: t.display, kind: "path", absolute: t.absolute, external: t.external }];
  } catch {
    return [];
  }
}

export const label = (input: Input): string => `grep_files ${input.pattern}`;
