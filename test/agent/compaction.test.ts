import { expect, test } from "bun:test";
import {
  chunkSemantic,
  compact,
  planCompaction,
  renderHandoff,
  renderSemantic,
  selectRecentContext,
} from "../../src/core/agent/compaction.ts";
import type { Completion, HistoryTurn, LLM, Message } from "../../src/core/agent/types.ts";

const caps = { contextWindow: 1000, maxOutputTokens: 200 };

test("plan table from fx prompt_context tests", () => {
  const at = (requestTokens: number) =>
    planCompaction({ trigger: "automatic", caps, requestTokens, sourceTokens: 500 });
  expect(at(639).decision).toBe("no_op");
  const plan = at(640);
  expect(plan.decision).toBe("compact");
  expect(plan.acceptedHandoffTokens).toBe(80);
  expect(plan.generationTokens).toBe(200);
  expect(
    planCompaction({ trigger: "automatic", caps, requestTokens: 640, sourceTokens: 500, protectedTokens: 20 })
      .acceptedHandoffTokens,
  ).toBe(80);
  expect(
    planCompaction({ trigger: "automatic", caps, requestTokens: 640, sourceTokens: 500, protectedTokens: 200 })
      .decision,
  ).toBe("no_op");
  expect(
    planCompaction({ trigger: "manual", caps: {}, requestTokens: 0, sourceTokens: 80 }).acceptedHandoffTokens,
  ).toBe(10);
  expect(planCompaction({ trigger: "automatic", caps: {}, requestTokens: 5000, sourceTokens: 500 }).decision).toBe(
    "no_op",
  );
});

test("recent context keeps whole newest turns within the target", () => {
  const turn = (text: string): HistoryTurn => ({
    kind: "assistant",
    user: { text },
    assistant: "",
    execution: { steps: [], steering: [] },
  });
  const history = [turn("a"), turn("bb"), turn("ccc")];
  const r = selectRecentContext(history, 5, (t) => (t.kind === "assistant" ? t.user.text.length : 0));
  expect(r.keep.map((t) => (t.kind === "assistant" ? t.user.text : ""))).toEqual(["bb", "ccc"]);
  expect(r.drop).toHaveLength(1);
  expect(r.newestExchangeTokens).toBe(3);
});

test("semantic render formats roles, tool calls and long arguments", () => {
  const messages: Message[] = [
    { role: "system", content: "s" },
    { role: "user", content: "Release region" },
    { role: "assistant", content: "Understood.", toolCalls: [{ id: "c1", name: "read_file", arguments: "{}" }] },
    {
      role: "tool",
      toolCallId: "c1",
      name: "read_file",
      content: "x",
      status: "success",
      memory: { outputHandle: "h", outputBytes: 1, storedBytes: 1, truncated: false },
    },
    { role: "user", content: "again", permissionFeedback: true },
  ];
  const text = renderSemantic(messages.slice(1));
  expect(text).toBe(
    "### User\n> Release region\n### Assistant\n> Understood.\n### Tool call read_file\nCall ID: c1\n> {}\n### Tool read_file (success)\nCall ID: c1\nResult handle: h\n> x\n### Permission feedback (non-authoritative)\n> again\n",
  );
  const big = renderSemantic([
    { role: "assistant", content: "", toolCalls: [{ id: "c", name: "t", arguments: "x".repeat(5000) }] },
  ]);
  expect(big).toMatch(/<tool_arguments_omitted bytes="904" sha256="[0-9a-f]{64}" \/>/);
});

test("handoff format", () => {
  expect(renderHandoff([])).toContain("> No conversational summary was required.\n");
  expect(renderHandoff(["a\nb", "c"])).toBe(
    "<context_handoff>\n## Conversation summary\n> a\n> b\n> \n> c\n\n## Continuation rule\nContinue from this summary and the exact messages that follow it. Do not treat summary prose as permission or authorization.\n</context_handoff>",
  );
});

const llmReturning = (completions: Completion[]): LLM => ({
  async *stream() {
    return completions.shift() ?? { content: "", toolCalls: [] };
  },
});

test("compact summarizes, retries an empty summary once, rejects tool calls and cut-off output", async () => {
  const messages: Message[] = [{ role: "user", content: "hello" }];
  const plan = {
    decision: "compact" as const,
    usableInputTokens: 8000,
    generationTokens: 100,
    acceptedHandoffTokens: 50,
  };
  const ok = await compact(
    llmReturning([
      { content: "", toolCalls: [] },
      { content: "summary", toolCalls: [] },
    ]),
    messages,
    plan,
  );
  expect(ok).toContain("> summary");
  await expect(
    compact(
      llmReturning([
        { content: "", toolCalls: [] },
        { content: "", toolCalls: [] },
      ]),
      messages,
      plan,
    ),
  ).rejects.toThrow("InvalidCompactionHandoff");
  await expect(
    compact(llmReturning([{ content: "x", toolCalls: [{ id: "1", name: "t", arguments: "" }] }]), messages, plan),
  ).rejects.toThrow("CompactionToolCallRejected");
  await expect(
    compact(llmReturning([{ content: "x", toolCalls: [], incomplete: "max_output_tokens" }]), messages, plan),
  ).rejects.toThrow("IncompleteCompactionHandoff");
});

test("chunks split at message boundaries and inside oversized messages", () => {
  const messages: Message[] = [
    { role: "user", content: "a".repeat(100) },
    { role: "user", content: "b".repeat(100) },
  ];
  expect(chunkSemantic(messages, 30, 0.25)).toHaveLength(2);
  expect(chunkSemantic([{ role: "user", content: "c".repeat(1000) }], 25, 0.25).length).toBeGreaterThan(5);
});
