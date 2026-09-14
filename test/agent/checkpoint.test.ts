import { expect, test } from "bun:test";
import { CheckpointError, decodeCheckpoint, encodeCheckpoint } from "../../src/core/agent/checkpoint.ts";
import type { HistoryTurn } from "../../src/core/agent/types.ts";

const history: HistoryTurn[] = [
  { kind: "assistant", user: { text: "a" }, assistant: "b", execution: { steps: [], steering: [] } },
];

test("round trip", () => {
  const bytes = encodeCheckpoint(history, { inputTokens: 3 });
  expect(decodeCheckpoint(bytes)).toEqual({ history, usage: { inputTokens: 3 } });
});

test("corruption, version and size are rejected", () => {
  const bytes = encodeCheckpoint(history, {});
  const flipped = new Uint8Array(bytes);
  flipped[flipped.length - 1] = (flipped[flipped.length - 1] ?? 0) ^ 1;
  expect(() => decodeCheckpoint(flipped)).toThrow(new CheckpointError("CorruptCheckpoint"));
  const versioned = new Uint8Array(bytes);
  versioned[4] = 9;
  expect(() => decodeCheckpoint(versioned)).toThrow(new CheckpointError("UnsupportedCheckpointVersion"));
  expect(() => encodeCheckpoint(Array(1025).fill(history[0]), {})).toThrow(new CheckpointError("CheckpointTooLarge"));
});
