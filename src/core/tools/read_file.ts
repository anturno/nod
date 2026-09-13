/** read_file: bounded, line-numbered read of one UTF-8 text file. */
import { open, stat } from "node:fs/promises";
import { type Args, errorName, fail, isAccessDenied, isRecord, ok, optionalInt } from "./args.ts";
import { filesystemAccessDenied, toolExecutionFailed } from "./errors.ts";
import { type PathError, type ResolvedPath, resolvePath } from "./paths.ts";
import { MAX_READ_LINE_LEN, MAX_READ_LINES } from "./result_store.ts";
import type { DecodeResult, PermissionTarget, ToolContext, ToolResult } from "./spec.ts";

export type Input = { path: string; startLine: number; lineCount: number };

const MAX_SNAPSHOT_BYTES = 10 * 1024 * 1024;
const MAX_OUTPUT_BYTES = 256 * 1024;
const MAX_LINE_COUNT = 2000;
const LINE_TRUNCATED = "... (line truncated)";

export function decode(args: unknown): DecodeResult<Input> {
  if (!isRecord(args)) return fail("read_file arguments must be an object");
  const a: Args = args;
  if (!("path" in a)) return fail('read_file requires string field "path"');
  if (typeof a.path !== "string") return fail('read_file field "path" must be a string');
  const path = a.path.trim();
  if (path.length === 0) return fail('read_file field "path" must not be empty');
  const startLine = optionalInt(a, "start_line", 1, "read_file", "positive");
  if (typeof startLine === "object") return fail(startLine.failure);
  const lineCount = optionalInt(a, "line_count", 1, "read_file", "positive");
  if (typeof lineCount === "object") return fail(lineCount.failure);
  return ok({ path, startLine: startLine ?? 1, lineCount: Math.min(lineCount ?? MAX_READ_LINES, MAX_LINE_COUNT) });
}

function failure(path: string, err: string): ToolResult {
  if (err === "AccessDenied") return { status: "failure", output: filesystemAccessDenied("read_file", path, err) };
  if (err === "NotRegularFile") {
    return {
      status: "failure",
      output: toolExecutionFailed("read_file", "read_file requires a regular file", {
        details: { field: "path", path, error: err },
        suggestion: "Use glob_files to inspect directory contents, then choose a regular file.",
      }),
    };
  }
  return {
    status: "failure",
    output: toolExecutionFailed("read_file", "read_file failed", {
      details: { field: "path", path, error: err },
      suggestion: "Run glob_files to discover matching paths, or check the path relative to the workspace.",
    }),
  };
}

const digits = (n: number) => String(n).length;
const fatalDecoder = new TextDecoder("utf-8", { fatal: true });

export async function call(input: Input, ctx: ToolContext): Promise<ToolResult> {
  let target: ResolvedPath;
  try {
    target = resolvePath(ctx.workspaceRoot, input.path, ctx.home, ctx.additionalDirectories);
  } catch (err) {
    return failure(input.path, (err as PathError).message);
  }
  let info: Awaited<ReturnType<typeof stat>>;
  try {
    info = await stat(target.absolute);
  } catch (err) {
    return failure(target.display, isAccessDenied(err) ? "AccessDenied" : errorName(err));
  }
  if (!info.isFile()) return failure(target.display, "NotRegularFile");

  const size = info.size;
  const truncatedBySize = size > MAX_SNAPSHOT_BYTES;
  const buffer = Buffer.alloc(Math.min(size, MAX_SNAPSHOT_BYTES));
  let actual = 0;
  try {
    const handle = await open(target.absolute, "r");
    try {
      while (actual < buffer.length) {
        const { bytesRead } = await handle.read(buffer, actual, buffer.length - actual, actual);
        if (bytesRead === 0) break;
        actual += bytesRead;
      }
    } finally {
      await handle.close();
    }
  } catch (err) {
    return failure(target.display, isAccessDenied(err) ? "AccessDenied" : errorName(err));
  }
  const bytes = buffer.subarray(0, actual);
  let text: string;
  try {
    if (bytes.includes(0)) throw new Error("binary");
    text = fatalDecoder.decode(bytes);
  } catch {
    return {
      status: "success",
      output: `<path>${target.display}</path>\n<content>binary or non-utf8 file omitted (${size} bytes)</content>`,
    };
  }

  const records: { number: number; text: string }[] = [];
  let total = 0;
  let displayTruncated = false;
  let stop = false;
  let width = 1;
  let budget = 0;
  let start = 0;
  for (let n = 1; start < text.length; n++) {
    let end = text.indexOf("\n", start);
    if (end === -1) end = text.length;
    const line = text.slice(start, end);
    total = n;
    if (!stop && n >= input.startLine) {
      if (records.length >= input.lineCount) {
        displayTruncated = true;
        stop = true;
      } else {
        const w = digits(n);
        if (w > width) {
          budget += records.length * (w - width);
          width = w;
        }
        const clipped = line.length > MAX_READ_LINE_LEN;
        const shown = clipped ? line.slice(0, MAX_READ_LINE_LEN) + LINE_TRUNCATED : line;
        const rendered = budget + width + 1 + Buffer.byteLength(shown) + 1;
        if (rendered > MAX_OUTPUT_BYTES) {
          displayTruncated = true;
          stop = true;
        } else {
          if (clipped) displayTruncated = true;
          records.push({ number: n, text: shown });
          budget = rendered;
        }
      }
    }
    if (end === text.length) break;
    start = end + 1;
  }

  let out = `<path>${target.display}</path>\n<content>\n`;
  if (records.length > 0) {
    const w = digits(records[records.length - 1]!.number);
    for (const r of records) out += `${r.number}${" ".repeat(w - digits(r.number))}\t${r.text}\n`;
  } else if (total > 0 && input.startLine > total) {
    out += `... [start_line ${input.startLine} is beyond end of file; total lines ${total}]\n`;
  }
  const snapshotFull = !truncatedBySize && actual === size;
  const covers = !displayTruncated && input.startLine === 1 && records.length === total;
  if ((!covers || !snapshotFull) && (records.length > 0 || displayTruncated)) {
    out += snapshotFull
      ? `... [showing ${records.length} of ${total} lines; use start_line/line_count to read more.]\n`
      : `... [showing ${records.length} of at least ${total} lines; file snapshot was capped before EOF.]\n`;
  }
  return { status: "success", output: `${out}</content>` };
}

export function targets(input: Input, ctx: ToolContext): PermissionTarget[] {
  try {
    const t = resolvePath(ctx.workspaceRoot, input.path, ctx.home, ctx.additionalDirectories);
    return [{ permission: "read", target: t.display, kind: "path", absolute: t.absolute, external: t.external }];
  } catch {
    return [];
  }
}

export const label = (input: Input): string => `read_file ${input.path}`;
