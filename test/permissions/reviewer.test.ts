import { expect, test } from "bun:test";
import type { Completion, LLM, Message, StreamEvent, StreamOptions, ToolSpec } from "../../src/core/agent/types.ts";
import {
  buildReviewMessages,
  createReviewer,
  parseReviewCompletion,
  REVIEW_POLICY_TEMPLATE,
  REVIEW_TOOL,
  type ReviewInput,
  reviewerModel,
} from "../../src/core/permissions/index.ts";

type Call = { messages: Message[]; tools: ToolSpec[]; options?: StreamOptions };

function fakeLLM(respond: (call: Call, signal?: AbortSignal) => Promise<Completion> | Completion): {
  llm: LLM;
  calls: Call[];
} {
  const calls: Call[] = [];
  const llm: LLM = {
    async *stream(messages, tools, signal, options): AsyncGenerator<StreamEvent, Completion> {
      const call = { messages, tools, options };
      calls.push(call);
      return await respond(call, signal);
    },
  };
  return { llm, calls };
}

const clear = (): Completion => ({
  content: "",
  toolCalls: [{ id: "r1", name: "permission_decision", arguments: '{"decision":"clear"}' }],
});

const input = (overrides: Partial<ReviewInput> = {}): ReviewInput => ({
  origin: "root",
  callId: "call-1",
  action: { kind: "command", command: "rm -rf dist", resolvedCwd: "/tmp/ws", background: false },
  priorResults: [{ tool: "read_file", status: "success", excerpt: "README contents" }],
  rootRequests: { current: "clean the build output" },
  feedback: [],
  ...overrides,
});

const deps = { provider: "codex" as const, sessionModel: "gpt-5.4", listedModels: ["gpt-5.4", "gpt-5.4-mini"] };

test("reviewerModel: codex prefers gpt-5.4-mini when listed, grok uses the session model, env overrides", () => {
  expect(reviewerModel(deps)).toBe("gpt-5.4-mini");
  expect(reviewerModel({ ...deps, listedModels: ["gpt-5.4"] })).toBe("gpt-5.4");
  expect(reviewerModel({ provider: "grok", sessionModel: "grok-4", listedModels: ["gpt-5.4-mini"] })).toBe("grok-4");
  expect(reviewerModel({ ...deps, env: { NOD_REVIEWER_MODEL: "custom" } })).toBe("custom");
});

test("payload: instructions template, single user message, required tool choice, bounded options", async () => {
  const { llm, calls } = fakeLLM(clear);
  const llmFor = fakeLLM(clear);
  const reviewer = createReviewer({ ...deps, llm, llmFor: () => llmFor.llm });
  expect(reviewer.model).toBe("gpt-5.4-mini");
  const result = await reviewer.review(input({ feedback: ["never touch node_modules"] }));
  expect(result).toEqual({ kind: "clear", rationale: "No rationale provided." });
  expect(calls).toHaveLength(0);
  expect(llmFor.calls).toHaveLength(1);
  const call = llmFor.calls[0]!;
  expect(call.options).toEqual({ toolChoice: "required", maxOutputTokens: 2048, parallelToolCalls: false });
  expect(call.tools).toEqual([REVIEW_TOOL]);
  expect(JSON.stringify(call.tools)).toContain('"required":["decision"]');
  expect(JSON.stringify(call.tools)).toContain('"enum":["clear","caution"]');
  expect(call.messages).toHaveLength(2);
  const [system, user] = call.messages as [Message & { role: "system" }, Message & { role: "user" }];
  expect(system.role).toBe("system");
  expect(REVIEW_POLICY_TEMPLATE).toContain("Review one exact pending nod action");
  expect(REVIEW_POLICY_TEMPLATE).not.toContain(" fx ");
  expect(system.content.startsWith("<permission_review>")).toBe(true);
  expect(system.content).toContain(
    'review_context_kind: contextual\nreview_origin: root\ntarget_tool_call_id: "call-1"',
  );
  expect(system.content).toContain("action: command\ncommand: rm -rf dist\ncwd: /tmp/ws\nbackground: false\n");
  expect(system.content).toContain("prior_tool_result[0].content_untrusted: README contents");
  expect(system.content).toContain("action_evidence_incomplete: false");
  expect(system.content).not.toContain("{{REVIEW_DATA}}");
  expect(user.role).toBe("user");
  expect(user.content).toContain(
    "review_context_kind: contextual\ntrusted_root_context:\ncurrent_request: clean the build output\n",
  );
  expect(user.content).toContain("trusted_user_permission_feedback: never touch node_modules\n");
  expect(user.content).toContain('pending_action: {"tool_call_id":"call-1","kind":"command","command":"rm -rf dist"');
});

test("normal view for file mutations; evidence is xml-escaped and terminal-safe", () => {
  const built = buildReviewMessages(
    input({
      action: {
        kind: "file_mutation",
        tool: "write_file",
        displayPath: "src/<a>.ts",
        preimage: "absent",
        additions: 1,
        deletions: 0,
        lines: [{ op: "add", text: "hello\x1b[31m" }],
      },
    }),
  );
  expect(built?.view).toBe("normal");
  const system = built!.messages[0] as Message & { role: "system" };
  expect(system.content).toContain("path: src/&lt;a&gt;.ts");
  expect(system.content).toContain("review[add]: hello\n");
  expect(system.content).not.toContain("\x1b");
  expect((built!.messages[1] as Message & { role: "user" }).content.startsWith("review_context_kind: normal\n")).toBe(
    true,
  );
  expect(
    buildReviewMessages(input({ origin: "subagent", action: { kind: "tool", name: "web_fetch", argumentsJson: "{}" } }))
      ?.view,
  ).toBe("contextual");
});

test("evidence bounds: 16 newest results, 1 KiB content, 8 KiB total; an oversized action is evidence_incomplete", async () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    tool: "read_file",
    status: "success",
    excerpt: `RESULT_${i} ${"x".repeat(1500)}`,
  }));
  const built = buildReviewMessages(input({ priorResults: many }))!;
  const system = (built.messages[0] as Message & { role: "system" }).content;
  expect(system).not.toContain("RESULT_3 ");
  expect(system).toContain("RESULT_19 ");
  expect(system).toContain("...[evidence omitted]...");
  expect(system).toContain("prior_tool_results_older_omitted: true");
  expect(system).toContain("prior_tool_result_evidence_incomplete: true");
  expect(system).toMatch(/prior_tool_results_serialized: \d+\n/);
  expect(Number(/prior_tool_results_serialized: (\d+)/.exec(system)![1])).toBeLessThanOrEqual(8);
  expect(built.complete).toBe(true);

  const { llm } = fakeLLM(clear);
  const reviewer = createReviewer({ ...deps, llm, llmFor: () => llm });
  const huge = input({
    action: { kind: "command", command: "x".repeat(70_000), resolvedCwd: "/tmp", background: false },
  });
  expect(await reviewer.review(huge)).toEqual({ kind: "evidence_incomplete" });
  const big = input({ action: { kind: "tool", name: "t", argumentsJson: "y".repeat(20_000) } });
  expect(await reviewer.review(big)).toEqual({ kind: "evidence_incomplete" });
  expect(await reviewer.review(input({ callId: "" }))).toEqual({ kind: "invalid", reason: "invalid_context" });
  expect(await reviewer.review(input({ rootRequests: { current: "" } }))).toEqual({
    kind: "invalid",
    reason: "invalid_context",
  });
});

test("parse rules", () => {
  const call = (args: string, name = "permission_decision") => ({
    content: "",
    toolCalls: [{ id: "1", name, arguments: args }],
  });
  expect(parseReviewCompletion({ content: "sure", toolCalls: [] })).toEqual({
    kind: "invalid",
    reason: "completion_text",
  });
  expect(parseReviewCompletion({ content: "", toolCalls: [] })).toEqual({
    kind: "invalid",
    reason: "completion_tool_call_count",
  });
  expect(
    parseReviewCompletion({
      content: "",
      toolCalls: [call('{"decision":"clear"}').toolCalls[0]!, call("{}").toolCalls[0]!],
    }),
  ).toEqual({
    kind: "invalid",
    reason: "completion_tool_call_count",
  });
  expect(parseReviewCompletion(call('{"decision":"clear"}', "other"))).toEqual({
    kind: "invalid",
    reason: "completion_tool_name",
  });
  expect(parseReviewCompletion(call("{nope"))).toEqual({ kind: "invalid", reason: "arguments_json" });
  expect(parseReviewCompletion(call("[]"))).toEqual({ kind: "invalid", reason: "arguments_shape" });
  expect(parseReviewCompletion(call('{"decision":"maybe"}'))).toEqual({
    kind: "invalid",
    reason: "arguments_decision",
  });
  expect(parseReviewCompletion(call('{"decision":"caution","rationale":"bad"}'))).toEqual({
    kind: "caution",
    rationale: "bad",
  });
  expect(parseReviewCompletion(call('{"decision":"clear","rationale":7}'))).toEqual({
    kind: "clear",
    rationale: "No rationale provided.",
  });
  const long = parseReviewCompletion(call(JSON.stringify({ decision: "clear", rationale: "é".repeat(200) })));
  expect(long.kind).toBe("clear");
  expect(Buffer.byteLength((long as { rationale: string }).rationale)).toBe(240);
});

test("transport: timeout, transient and permanent failures, cancellation", async () => {
  const hang = fakeLLM(
    (_, signal) => new Promise((_, reject) => signal?.addEventListener("abort", () => reject(signal.reason))),
  );
  const timed = createReviewer({ ...deps, llm: hang.llm, llmFor: () => hang.llm, timeoutMs: 20 });
  expect(await timed.review(input())).toEqual({ kind: "invalid", reason: "transport_timed_out" });

  const failing = (message: string) => {
    const { llm } = fakeLLM(() => {
      throw new Error(message);
    });
    return createReviewer({ ...deps, llm, llmFor: () => llm });
  };
  expect(await failing("ChatGPT (429): slow down").review(input())).toEqual({
    kind: "invalid",
    reason: "transport_transient",
  });
  expect(await failing("ChatGPT (503): down").review(input())).toEqual({
    kind: "invalid",
    reason: "transport_transient",
  });
  expect(await failing("ChatGPT (408): x").review(input())).toEqual({ kind: "invalid", reason: "transport_transient" });
  expect(await failing("fetch failed").review(input())).toEqual({ kind: "invalid", reason: "transport_transient" });
  expect(await failing("ChatGPT (400): bad").review(input())).toEqual({
    kind: "invalid",
    reason: "transport_permanent",
  });

  const controller = new AbortController();
  const cancelled = createReviewer({ ...deps, llm: hang.llm, llmFor: () => hang.llm });
  const pending = cancelled.review(input(), controller.signal);
  controller.abort(new Error("stop"));
  await expect(pending).rejects.toThrow("stop");
});
