import { expect, test } from "bun:test";
import type { AgentEvent } from "../../src/core/agent/loop.ts";
import type { ToolSpec } from "../../src/core/tools/spec.ts";
import {
  applyEvent,
  CANCELLED_NOTICE,
  cancelRunning,
  foldedOutput,
  groupItems,
  groupSummary,
  itemsFromHistory,
  pushItem,
  type ToolCallView,
  type TranscriptItem,
  toolHeadline,
  toolView,
  transcriptLines,
} from "../../src/ui/core/transcript.ts";

const spec = {} as ToolSpec;
const call = (id: string, name: string) => ({ id, name, arguments: "{}" });
const started = (id: string, name: string, label: string): AgentEvent => ({
  type: "tool_started",
  call: call(id, name),
  label,
  spec,
});
const finished = (
  id: string,
  name: string,
  label: string,
  output: string,
  status: "success" | "failure" = "success",
): AgentEvent => ({
  type: "tool_finished",
  call: call(id, name),
  label,
  spec,
  result: { status, output },
});

const view = (name: string, status: ToolCallView["status"], category: ToolCallView["category"]): ToolCallView => ({
  toolId: name,
  name,
  action: "Ran",
  target: "x",
  status,
  category,
});

test("text streams into one item, a step closes it, tools render running → done with folded output", () => {
  let items: TranscriptItem[] = [];
  items = applyEvent(items, { type: "text", text: "Hel" });
  items = applyEvent(items, { type: "text", text: "lo" });
  expect(items).toMatchObject([{ type: "text", text: "Hello", streaming: true }]);
  items = applyEvent(items, started("c1", "shell", "shell.run bun test"));
  expect(items[0]).toMatchObject({ streaming: false });
  expect(items[1]).toMatchObject({ type: "tool", call: { action: "Running", target: "bun test", status: "running" } });
  const output = JSON.stringify({ output_delta: "14 pass\n0 fail\nline3\nline4\nline5\n", exit_code: 0 });
  items = applyEvent(items, finished("c1", "shell", "shell.run bun test", output));
  const tool = items[1] as Extract<TranscriptItem, { type: "tool" }>;
  expect(toolHeadline(tool.call)).toBe("● Ran bun test");
  expect(foldedOutput(tool.call)).toEqual({ lines: ["14 pass", "0 fail", "line3"], hidden: 2 });
});

test("failed, denied and cancelled headlines", () => {
  const failed = applyEvent(
    [],
    finished("c", "shell", "shell.run bun test", JSON.stringify({ output_delta: "boom", exit_code: 1 }), "failure"),
  );
  expect(toolHeadline((failed[0] as Extract<TranscriptItem, { type: "tool" }>).call)).toBe(
    "■ Failed bun test · exit 1",
  );
  const denied = applyEvent(
    [],
    finished(
      "d",
      "shell",
      "shell.run rm -rf /",
      JSON.stringify({ error: { type: "tool_permission_denied" } }),
      "failure",
    ),
  );
  expect(toolHeadline((denied[0] as Extract<TranscriptItem, { type: "tool" }>).call)).toBe("⊘ Denied rm -rf /");
  const running = applyEvent([], started("r", "read_file", "read_file src/a.ts"));
  const cancelled = cancelRunning(running)[0] as Extract<TranscriptItem, { type: "tool" }>;
  expect(toolHeadline(cancelled.call)).toBe("■ Cancelled src/a.ts");
  expect(toolView(call("m", "mcp_github_search"), "mcp_github_search {}").target).toBe("mcp_github_search");
});

test("verbs per tool", () => {
  const verbs = [
    ["read_file", "read_file a", "Reading", "Read"],
    ["edit_file", "edit_file a", "Editing", "Edited"],
    ["write_file", "write_file a", "Writing", "Wrote"],
    ["grep_files", "grep_files foo", "Searching", "Searched"],
    ["web_fetch", "web_fetch http://x", "Fetching", "Fetched"],
  ] as const;
  for (const [name, label, running, done] of verbs) {
    const items = applyEvent(applyEvent([], started("i", name, label)), finished("i", name, label, "ok"));
    const tool = items[0] as Extract<TranscriptItem, { type: "tool" }>;
    expect(toolView(call("i", name), label).action).toBe(running);
    expect(tool.call.action).toBe(done);
  }
});

test("a queued user line turns live when the loop consumes the steering", () => {
  let items = pushItem([], { type: "user", text: "later", queued: true });
  items = applyEvent(items, { type: "steering", text: "later" });
  expect(items[0]).toMatchObject({ type: "user", queued: false });
});

test("group summaries count categories by size, pluralize commands, and append failed/denied", () => {
  expect(groupSummary([view("read_file", "done", "read"), view("edit_file", "done", "edit")])).toBe(
    "● 2 tool calls · 1 read · 1 edit",
  );
  expect(
    groupSummary([
      view("shell", "done", "command"),
      view("shell", "done", "command"),
      view("shell", "failed", "command"),
    ]),
  ).toBe("● 3 tool calls · 3 commands · 1 failed");
  expect(groupSummary([view("read_file", "done", "read"), view("shell", "denied", "command")])).toBe(
    "● 2 tool calls · 1 read · 1 command · 1 denied",
  );
  expect(groupSummary([view("read_file", "done", "read")])).toBe("● 1 tool call · 1 read");
});

test("collapse groups runs of two or more finished tools, never ask_user_question or a running call", () => {
  let items: TranscriptItem[] = [];
  items = pushItem(items, { type: "user", text: "go" });
  items = pushItem(items, { type: "tool", call: view("read_file", "done", "read") });
  items = pushItem(items, { type: "tool", call: view("edit_file", "done", "edit") });
  items = pushItem(items, { type: "tool", call: view("ask_user_question", "done", "other") });
  items = pushItem(items, { type: "tool", call: view("shell", "running", "command") });
  const grouped = groupItems(items, true);
  expect(grouped.map((i) => i.type)).toEqual(["user", "group", "tool", "tool"]);
  expect(groupItems(items, false)).toBe(items);
  const single = groupItems([items[0] as TranscriptItem, items[1] as TranscriptItem], true);
  expect(single.map((i) => i.type)).toEqual(["user", "tool"]);
});

test("review and full transcript lines, and items rebuilt from saved history", () => {
  const items = itemsFromHistory([
    {
      kind: "assistant",
      user: { text: "hi" },
      assistant: "hello",
      execution: {
        steps: [
          {
            assistant: "",
            toolCalls: [{ id: "t", name: "shell", arguments: JSON.stringify({ action: "run", command: "ls" }) }],
            results: [
              {
                role: "tool",
                toolCallId: "t",
                name: "shell",
                content: JSON.stringify({ output_delta: "a.ts", exit_code: 0 }),
                status: "success",
              },
            ],
          },
        ],
        steering: [],
      },
    },
    {
      kind: "interrupted",
      user: { text: "again" },
      completedToolNames: [],
      execution: { steps: [], steering: [] },
      reason: "cancelled",
      origin: "turn",
    },
  ]);
  const review = transcriptLines(items, "review");
  expect(review).toContain("> hi");
  expect(review).toContain("● Ran ls");
  expect(review).toContain("│ a.ts");
  expect(review).toContain(`! ${CANCELLED_NOTICE}`);
  expect(review.some((l) => l.startsWith("✓ turn"))).toBe(false);
  const full = transcriptLines(items, "full");
  expect(full).toContain("exit_code=0 <stdout>");
  expect(full).toContain("✓ turn 1 · 0s · ↑0 ↓0");
});
