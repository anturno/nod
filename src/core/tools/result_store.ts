/** Caps, sanitization, and on-disk storage for tool results too large to inline. */
import { createHash } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { ToolResultMemory } from "../agent/types.ts";

export const DEFAULT_MAX_TOOL_RESULT_BYTES = 64 * 1024;
export const MIN_TOOL_RESULT_BYTES = 1024;
export const LARGE_RESULT_THRESHOLD = 16 * 1024;
export const PREVIEW_BYTES = 4 * 1024;
export const READ_DEFAULT_BYTES = 8 * 1024;
export const READ_MAX_BYTES = 64 * 1024;
export const MAX_LIST_ENTRIES = 100;
export const MAX_READ_LINES = 400;
export const MAX_READ_LINE_LEN = 2000;

/** Drops control characters (except tab and newline) and lone surrogates. */
export function sanitize(raw: string): string {
  const parts: string[] = [];
  let start = 0;
  for (let i = 0; i < raw.length; i++) {
    const c = raw.charCodeAt(i);
    let bad = (c < 0x20 && c !== 0x09 && c !== 0x0a) || c === 0x7f;
    if (c >= 0xd800 && c <= 0xdbff) {
      const next = raw.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        i++;
        continue;
      }
      bad = true;
    } else if (c >= 0xdc00 && c <= 0xdfff) bad = true;
    if (!bad) continue;
    parts.push(raw.slice(start, i));
    start = i + 1;
  }
  if (start === 0) return raw;
  parts.push(raw.slice(start));
  return parts.join("");
}

export function utf8BackwardBoundary(bytes: Uint8Array, index: number): number {
  let len = Math.min(index, bytes.length);
  while (len > 0 && len < bytes.length && (bytes[len]! & 0xc0) === 0x80) len--;
  return len;
}

export function utf8ForwardBoundary(bytes: Uint8Array, index: number): number {
  let i = Math.min(index, bytes.length);
  while (i < bytes.length && (bytes[i]! & 0xc0) === 0x80) i++;
  return i;
}

const decoder = new TextDecoder();

export function utf8Prefix(text: string, maxBytes: number): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  return decoder.decode(bytes.subarray(0, utf8BackwardBoundary(bytes, maxBytes)));
}

export function truncateWithMarker(tool: string, text: string, maxBytes: number): { text: string; truncated: boolean } {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  const marker = `\n... [tool result truncated for ${tool}: original ${bytes.length} bytes; cap is ${maxBytes} bytes]\n`;
  const markerBytes = Buffer.byteLength(marker);
  const prefixCap = maxBytes > markerBytes ? maxBytes - markerBytes : 0;
  const cut = utf8BackwardBoundary(bytes, prefixCap);
  if (cut === 0) return { text: marker, truncated: true };
  return { text: decoder.decode(bytes.subarray(0, cut)) + marker, truncated: true };
}

const sha16 = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);

export function makeHandle(callId: string, tool: string, text: string): string {
  let safe = "";
  for (const ch of tool) {
    if (safe.length >= 48) break;
    safe += /[A-Za-z0-9_-]/.test(ch) ? ch : "-";
  }
  return `result-${safe || "call"}-${sha16(callId)}-${sha16(text)}.txt`;
}

export function validateHandle(handle: string): void {
  if (handle.length === 0 || handle.length > 160 || handle.includes("..") || !/^[A-Za-z0-9_.-]+$/.test(handle)) {
    throw new Error("InvalidHandle");
  }
}

async function store(dir: string, handle: string, text: string): Promise<void> {
  await mkdir(dir, { recursive: true });
  const tmp = join(dir, `.${handle}.${process.pid}.tmp`);
  await writeFile(tmp, text);
  await rename(tmp, join(dir, handle));
}

async function load(dir: string, handle: string): Promise<Buffer> {
  validateHandle(handle);
  try {
    return await readFile(join(dir, handle));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") throw new Error("ResultHandleNotFound");
    throw err;
  }
}

export type PreparedResult = { output: string; memory: ToolResultMemory };

/** Sanitizes, then either inlines (capped) or stores the result and returns a preview with a handle. */
export async function prepareResult(
  dir: string | null,
  callId: string,
  tool: string,
  raw: string,
  inlineCap: number,
  kind?: "complete_skill",
): Promise<PreparedResult> {
  const text = sanitize(raw);
  const bytes = Buffer.byteLength(text);
  if (kind === "complete_skill")
    return { output: text, memory: { outputBytes: bytes, storedBytes: bytes, truncated: false } };
  if (dir && (bytes > LARGE_RESULT_THRESHOLD || bytes > inlineCap)) {
    const handle = makeHandle(callId, tool, text);
    const preview = utf8Prefix(text, PREVIEW_BYTES);
    await store(dir, handle, text);
    const output =
      `<tool_result_preview handle="${handle}" stored_bytes="${bytes}">\n${preview}\n</tool_result_preview>\n` +
      `<tool_result_handle>${handle}</tool_result_handle>\n` +
      "Full result is stored outside session JSON. Use read_tool_result with this handle to inspect a byte range or literal query.";
    return {
      output,
      memory: { outputHandle: handle, preview, outputBytes: bytes, storedBytes: bytes, truncated: true },
    };
  }
  const capped = truncateWithMarker(tool, text, inlineCap);
  return {
    output: capped.text,
    memory: { outputBytes: bytes, storedBytes: Buffer.byteLength(capped.text), truncated: capped.truncated },
  };
}

/** 1-based byte range read, snapped to UTF-8 boundaries. startByte 0 or 1 both mean the beginning. */
export async function readByRange(dir: string, handle: string, startByte: number, byteCount: number): Promise<string> {
  const bytes = await load(dir, handle);
  const start = startByte === 0 ? 0 : Math.min(startByte - 1, bytes.length);
  const requested = Math.min(byteCount === 0 ? READ_DEFAULT_BYTES : byteCount, READ_MAX_BYTES);
  const end = Math.min(bytes.length, start + requested);
  const safeStart = utf8ForwardBoundary(bytes, start);
  const safeEnd = Math.max(safeStart, utf8BackwardBoundary(bytes, end));
  const slice = decoder.decode(bytes.subarray(safeStart, safeEnd));
  return `<tool_result handle="${handle}" start_byte="${safeStart + 1}" end_byte="${safeEnd}" total_bytes="${bytes.length}">\n${slice}\n</tool_result>`;
}

export async function searchByQuery(dir: string, handle: string, query: string): Promise<string> {
  const trimmed = query.trim();
  if (trimmed.length === 0) throw new Error("InvalidQuery");
  const text = decoder.decode(await load(dir, handle));
  let out = `<tool_result_query handle="${handle}">\nquery: ${JSON.stringify(trimmed)}\n`;
  let matches = 0;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i]!.includes(trimmed)) continue;
    out += `${i + 1}|${lines[i]}\n`;
    matches++;
    if (matches >= 50 || Buffer.byteLength(out) >= READ_MAX_BYTES) break;
  }
  if (matches === 0) out += "(no matches)\n";
  return `${out}</tool_result_query>`;
}

export function unknownHandleMessage(handle: string): string {
  return `read_tool_result failed for handle ${handle}: ResultHandleNotFound. No exact match exists in the active tool-result store; handles are session-scoped and must be copied exactly from the tool result preview.`;
}
