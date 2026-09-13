import { expect, test } from "bun:test";
import type { Completion, LLM, StreamEvent } from "../../src/core/agent/types.ts";
import {
  generateTitle,
  promptExcerpt,
  sanitizeGeneratedTitle,
  shouldGenerateTitle,
  TITLE_INSTRUCTIONS,
} from "../../src/core/session/title.ts";

const llm = (content: string, onCall?: (opts: unknown, messages: unknown) => void): LLM => ({
  async *stream(messages, _tools, _signal, options): AsyncGenerator<StreamEvent, Completion> {
    onCall?.(options, messages);
    return { content, toolCalls: [] };
  },
});

test("gate", () => {
  expect(shouldGenerateTitle({ title: null, history_len: 0 }, {})).toBe(true);
  expect(shouldGenerateTitle({ title: "x", history_len: 0 }, {})).toBe(false);
  expect(shouldGenerateTitle({ title: null, history_len: 1 }, {})).toBe(false);
  expect(shouldGenerateTitle({ title: null, history_len: 0 }, { sessionTitles: false })).toBe(false);
  expect(shouldGenerateTitle({ title: null, history_len: 0 }, { taskRunning: true })).toBe(false);
});

test("excerpt and sanitizer", () => {
  expect(promptExcerpt("  ")).toBeUndefined();
  expect(promptExcerpt("/help")).toBeUndefined();
  expect(promptExcerpt("/help me")).toBe("/help me");
  expect(Buffer.byteLength(promptExcerpt("é".repeat(3000))!)).toBe(2048);
  expect(sanitizeGeneratedTitle('  "Fix login bug"\nmore')).toBe("Fix login bug");
  expect(sanitizeGeneratedTitle("\"'`\n")).toBeUndefined();
  expect(sanitizeGeneratedTitle("a\x01b")).toBe("ab");
  expect(Buffer.byteLength(sanitizeGeneratedTitle("w".repeat(100))!)).toBe(60);
});

test("generateTitle sends the fx prompt with 128 max tokens and sanitizes", async () => {
  let seen: { options: unknown; messages: unknown } | undefined;
  const title = await generateTitle(
    llm("'Login fix'\n", (options, messages) => (seen = { options, messages })),
    "fix the login please",
  );
  expect(title).toBe("Login fix");
  expect(seen?.options).toEqual({ maxOutputTokens: 128, toolChoice: "none" });
  expect(seen?.messages).toEqual([
    { role: "system", content: TITLE_INSTRUCTIONS },
    { role: "user", content: "fix the login please" },
  ]);
  expect(await generateTitle(llm("x"), "/cmd")).toBeUndefined();
  const failing: LLM = {
    async *stream() {
      throw new Error("boom");
    },
  };
  expect(await generateTitle(failing, "hi")).toBeUndefined();
});
