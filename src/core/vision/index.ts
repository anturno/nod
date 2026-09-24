/** vision: one bounded sub-request to the session model with the images attached natively. */
import type { ImageRef, LLM } from "../agent/types.ts";
import { DEFAULT_LIMITS } from "../context/limits.ts";
import { truncateWithMarker } from "../tools/result_store.ts";

export const EVIDENCE_INSTRUCTION = "Return structured factual evidence only.";

export type Vision = (images: ImageRef[], focus: string, signal?: AbortSignal) => Promise<string>;

export function createVision(deps: { llm: LLM; maxBytes?: number }): Vision {
  const maxBytes = deps.maxBytes ?? DEFAULT_LIMITS.image_adapter_output_bytes;
  return async (images, focus, signal) => {
    const gen = deps.llm.stream(
      [{ role: "user", content: `${focus}\n\n${EVIDENCE_INSTRUCTION}`, images }],
      [],
      signal,
      // ponytail: ~2 bytes per token keeps the request bounded; the byte cap below is the real limit.
      { toolChoice: "none", maxOutputTokens: Math.ceil(maxBytes / 2) },
    );
    let next = await gen.next();
    while (!next.done) next = await gen.next();
    return truncateWithMarker("vision", next.value.content, maxBytes).text;
  };
}
