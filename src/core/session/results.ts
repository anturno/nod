/** Tool outputs: inline in the event when ≤16 KiB, otherwise results/<call_id>.txt beside the log. */
import { closeSync, openSync, readSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SessionError, validateSessionId } from "./id.ts";
import { ensurePrivateDir, RESULTS_DIR } from "./layout.ts";

export const INLINE_LIMIT_BYTES = 16 * 1024;
export const MAX_READ_BYTES = 64 * 1024;

export type StoredResult =
  | { inline_output: string; output_bytes: number; stored_bytes: number }
  | { artifact_ref: string; output_bytes: number; stored_bytes: number };

/** Writes large outputs to disk. call_id must be path-safe (same charset as session ids). */
export function storeToolResult(dir: string, callId: string, output: string): StoredResult {
  const output_bytes = Buffer.byteLength(output);
  if (output_bytes <= INLINE_LIMIT_BYTES) return { inline_output: output, output_bytes, stored_bytes: output_bytes };
  ensurePrivateDir(join(dir, RESULTS_DIR));
  const artifact_ref = `${RESULTS_DIR}/${validateSessionId(callId)}.txt`;
  writeFileSync(join(dir, artifact_ref), output, { mode: 0o600 });
  return { artifact_ref, output_bytes, stored_bytes: output_bytes };
}

export type ResultSlice = { text: string; offset: number; total_bytes: number; truncated: boolean };

/** Reads up to `max` (≤64 KiB) bytes of a stored result starting at byte `offset`. */
export function readToolResult(dir: string, ref: string, offset = 0, max = MAX_READ_BYTES): ResultSlice {
  const m = /^results\/([A-Za-z0-9._-]+)\.txt$/.exec(ref);
  if (!m || m[1] === "." || m[1] === "..")
    throw new SessionError("invalid_artifact_ref", `invalid artifact ref ${ref}`);
  const path = join(dir, ref);
  const total_bytes = statSync(path).size;
  const want = Math.min(Math.max(0, max), MAX_READ_BYTES, Math.max(0, total_bytes - offset));
  const buf = Buffer.alloc(want);
  const fd = openSync(path, "r");
  try {
    readSync(fd, buf, 0, want, offset);
  } finally {
    closeSync(fd);
  }
  return { text: buf.toString("utf8"), offset, total_bytes, truncated: offset + want < total_bytes };
}
