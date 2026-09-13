import { expect, test } from "bun:test";
import { interruptedClosure, projectHistory, TURN_ABORTED_CONTEXT } from "../../src/core/agent/history.ts";
import type { HistoryTurn } from "../../src/core/agent/types.ts";

const call = (id: string, name = "read_file") => ({ id, name, arguments: "{}" });
const result = (id: string, content = "ok") => ({ role: "tool" as const, toolCallId: id, name: "read_file", content });

test("assistant turn replays user, steps, results, steering and the final reply", () => {
  const turn: HistoryTurn = {
    kind: "assistant",
    user: { text: "hi" },
    assistant: "done",
    execution: {
      steps: [{ assistant: "looking", toolCalls: [call("a")], results: [result("a")] }],
      steering: [{ text: "hurry", afterStep: 0 }],
    },
  };
  const messages = projectHistory([turn]);
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "user", "assistant"]);
  expect(messages[3]).toEqual({ role: "user", content: "hurry" });
});

test("interrupted turn drops the active call, closes with a summary and the aborted marker", () => {
  const turn: HistoryTurn = {
    kind: "interrupted",
    user: { text: "go" },
    assistant: "partial",
    activeToolCall: call("b"),
    completedToolNames: ["glob_files", "glob_files"],
    execution: { steps: [{ assistant: "", toolCalls: [call("a"), call("b")], results: [result("a")] }], steering: [] },
    reason: "cancelled",
    origin: "turn",
  };
  const messages = projectHistory([turn]);
  const assistant = messages[1];
  expect(assistant?.role === "assistant" && assistant.toolCalls.map((c) => c.id)).toEqual(["a"]);
  expect(messages.at(-2)?.content).toBe(
    "partial\n\nInterrupted by user after completing 2 tool calls: glob_files, glob_files.",
  );
  expect(messages.at(-1)?.content).toBe(TURN_ABORTED_CONTEXT);
});

test("interrupted turn without output is exactly three messages", () => {
  const turn: HistoryTurn = {
    kind: "interrupted",
    user: { text: "go" },
    completedToolNames: [],
    execution: { steps: [], steering: [] },
    reason: "cancelled",
    origin: "turn",
  };
  const messages = projectHistory([turn]);
  expect(messages).toHaveLength(3);
  expect(messages[1]?.content).toBe("The previous response ended before completion.");
});

test("closure variants", () => {
  expect(interruptedClosure("p", [])).toBe("p\n\nThe previous response ended before completion.");
  expect(interruptedClosure(undefined, ["x"])).toBe("Interrupted by user after completing 1 tool call: x.");
});

test("compacted summary becomes a user message", () => {
  expect(
    projectHistory([{ kind: "compacted_summary", handoff: "<context_handoff>x</context_handoff>", removedTurns: 2 }]),
  ).toEqual([{ role: "user", content: "<context_handoff>x</context_handoff>" }]);
});
