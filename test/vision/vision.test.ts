import { describe, expect, test } from "bun:test";
import type { ImageRef, LLM, Message, StreamOptions } from "../../src/core/agent/types.ts";
import { createVision, EVIDENCE_INSTRUCTION } from "../../src/core/vision/index.ts";

describe("vision service", () => {
  test("sends one request with the images attached and caps the reply", async () => {
    const seen: { messages: Message[]; tools: unknown[]; options?: StreamOptions }[] = [];
    const llm: LLM = {
      async *stream(messages, tools, _signal, options) {
        seen.push({ messages, tools, options });
        return { content: "x".repeat(300), toolCalls: [] };
      },
    };
    const images: ImageRef[] = [{ id: 1, mime: "image/png", data: "QUFB" }];
    const vision = createVision({ llm, maxBytes: 200 });
    const out = await vision(images, "What is the button label?");
    expect(seen).toHaveLength(1);
    expect(seen[0]?.tools).toEqual([]);
    expect(seen[0]?.messages).toEqual([
      { role: "user", content: `What is the button label?\n\n${EVIDENCE_INSTRUCTION}`, images },
    ]);
    expect(seen[0]?.options).toEqual({ toolChoice: "none", maxOutputTokens: 100 });
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(200);
    expect(out).toContain("[tool result truncated for vision: original 300 bytes; cap is 200 bytes]");
    const full = await createVision({ llm })(images, "f");
    expect(full).toBe("x".repeat(300));
  });
});
