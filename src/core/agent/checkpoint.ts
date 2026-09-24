/** The provider-neutral conversation state, saved after every turn: header + sha256 + JSON payload. */
import { createHash } from "node:crypto";
import type { HistoryTurn, Usage } from "./types.ts";

const MAGIC = "NDCP";
const VERSION = 1;
const HEADER_BYTES = 4 + 2 + 2 + 4 + 32;
export const MAX_CHECKPOINT_BYTES = 4 * 1024 * 1024;
export const MAX_HISTORY_TURNS = 1024;

export class CheckpointError extends Error {
  constructor(
    readonly code: "CorruptCheckpoint" | "UnsupportedCheckpointVersion" | "InvalidCheckpoint" | "CheckpointTooLarge",
  ) {
    super(code);
  }
}

const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest();

export function encodeCheckpoint(history: HistoryTurn[], usage: Usage): Uint8Array {
  if (history.length > MAX_HISTORY_TURNS) throw new CheckpointError("CheckpointTooLarge");
  const payload = new TextEncoder().encode(JSON.stringify({ history, usage }));
  if (payload.length > MAX_CHECKPOINT_BYTES - HEADER_BYTES) throw new CheckpointError("CheckpointTooLarge");
  const out = new Uint8Array(HEADER_BYTES + payload.length);
  const view = new DataView(out.buffer);
  out.set(new TextEncoder().encode(MAGIC), 0);
  view.setUint16(4, VERSION, true);
  view.setUint16(6, 0, true);
  view.setUint32(8, payload.length, true);
  out.set(sha256(payload), 12);
  out.set(payload, HEADER_BYTES);
  return out;
}

export function decodeCheckpoint(bytes: Uint8Array): { history: HistoryTurn[]; usage: Usage } {
  if (bytes.length > MAX_CHECKPOINT_BYTES) throw new CheckpointError("CheckpointTooLarge");
  if (bytes.length < HEADER_BYTES || new TextDecoder().decode(bytes.subarray(0, 4)) !== MAGIC)
    throw new CheckpointError("CorruptCheckpoint");
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint16(4, true) !== VERSION) throw new CheckpointError("UnsupportedCheckpointVersion");
  const length = view.getUint32(8, true);
  const payload = bytes.subarray(HEADER_BYTES, HEADER_BYTES + length);
  if (payload.length !== length || !sha256(payload).equals(bytes.subarray(12, 44)))
    throw new CheckpointError("CorruptCheckpoint");
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder().decode(payload));
  } catch {
    throw new CheckpointError("InvalidCheckpoint");
  }
  const value = parsed as { history?: unknown; usage?: unknown };
  if (!Array.isArray(value.history) || typeof value.usage !== "object" || value.usage === null)
    throw new CheckpointError("InvalidCheckpoint");
  if (value.history.length > MAX_HISTORY_TURNS) throw new CheckpointError("CheckpointTooLarge");
  return { history: value.history as HistoryTurn[], usage: value.usage as Usage };
}
