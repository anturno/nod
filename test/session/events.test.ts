import { expect, test } from "bun:test";
import type { HistoryTurn } from "../../src/core/agent/types.ts";
import {
  capUtf8,
  deriveDisplay,
  type EventFrame,
  projectHistory,
  type SessionEvent,
} from "../../src/core/session/events.ts";

const frames = (events: SessionEvent[]): EventFrame[] =>
  events.map((event, i) => ({ schema_version: 1, seq: i + 1, timestamp_ms: i, event }));

test("projects user/tool_call/tool_result groups, steering, completed and interrupted turns", () => {
  const history = projectHistory(
    frames([
      { type: "user", text: "do it", images: [] },
      { type: "assistant", text: "looking" },
      { type: "tool_call", call_id: "c1", tool_name: "read", arguments_json: "{}" },
      {
        type: "tool_result",
        call_id: "c1",
        tool_name: "read",
        status: "success",
        inline_output: "data",
        output_bytes: 4,
        stored_bytes: 4,
        completeness: "complete",
      },
      { type: "steering", text: "faster" },
      { type: "assistant", text: "done" },
      { type: "turn_completed" },
      { type: "user", text: "again", images: [] },
      { type: "assistant", text: "" },
      { type: "tool_call", call_id: "c2", tool_name: "bash", arguments_json: "{}" },
      { type: "interrupted", reason: "cancelled", partial_text: null },
      { type: "user", text: "orphan", images: [] },
      { type: "assistant", text: "half" },
    ]),
  );
  expect(history).toHaveLength(2);
  const first = history[0] as Extract<HistoryTurn, { kind: "assistant" }>;
  expect(first.assistant).toBe("done");
  expect(first.execution.steps).toHaveLength(1);
  expect(first.execution.steps[0]!.toolCalls[0]!.id).toBe("c1");
  expect(first.execution.steps[0]!.results[0]!.content).toBe("data");
  expect(first.execution.steering).toEqual([{ text: "faster", afterStep: 1 }]);
  const second = history[1] as Extract<HistoryTurn, { kind: "interrupted" }>;
  expect(second.reason).toBe("cancelled");
  expect(second.activeToolCall?.id).toBe("c2");
  expect(second.completedToolNames).toEqual([]);
});

test("context_checkpoint replaces earlier turns with a compacted summary", () => {
  const history = projectHistory(
    frames([
      { type: "user", text: "a", images: [] },
      { type: "assistant", text: "1" },
      { type: "turn_completed" },
      { type: "user", text: "b", images: [] },
      { type: "assistant", text: "2" },
      { type: "turn_completed" },
      { type: "context_checkpoint", covers_through_seq: 3, summary: "sum" },
      { type: "user", text: "c", images: [] },
      { type: "assistant", text: "3" },
      { type: "turn_completed" },
    ]),
  );
  expect(history.map((t) => t.kind)).toEqual(["compacted_summary", "assistant", "assistant"]);
  expect(history[0]).toEqual({ kind: "compacted_summary", handoff: "sum", removedTurns: 1 });
});

test("display metadata: title ≤8 words, preview ≤2 lines, image and fallback titles", () => {
  const t = (text: string, images?: { id: number; mime: string; data: string }[]) =>
    deriveDisplay([
      { kind: "assistant", user: { text, images }, assistant: "", execution: { steps: [], steering: [] } },
    ]);
  expect(t("one two three four five six seven eight nine\nsecond\nthird")).toEqual({
    title: "one two three four five six seven eight",
    preview: "one two three four five six seven eight nine\nsecond",
  });
  expect(t("   \n\n")).toEqual({ title: "Untitled session", preview: null });
  expect(t("/help")).toEqual({ title: "Untitled session", preview: null });
  expect(t("[Image #1]", [{ id: 1, mime: "image/png", data: "" }])).toEqual({ title: "Image session", preview: null });
  expect(t("", [{ id: 1, mime: "image/png", data: "" }])).toEqual({ title: "Image session", preview: null });
  expect(deriveDisplay([])).toEqual({ title: "Untitled session", preview: null });
  const long = "é".repeat(300);
  expect(Buffer.byteLength(t(long).title)).toBe(240);
  expect(capUtf8("aé", 2)).toBe("a");
});
