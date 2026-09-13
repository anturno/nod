/** What to do when a model response fails part-way. Pure decision table after fx model_response_recovery. */

export const DEFAULT_MAX_PROVIDER_ATTEMPTS = 10;
export const MAX_RETRY_AFTER_SECONDS = 30;
/** Implicit pacing per consecutive failure with the same cause, in milliseconds. */
const PACING_MS = [250, 1_000, 2_000, 4_000, 8_000, 16_000, 30_000];

export type FailureCause =
  | "transport_interrupted"
  | "response_interrupted"
  | "provider_stream_timeout"
  | "provider_unavailable"
  | "rate_limited"
  | "authentication"
  | "request_limit_reached"
  | "content_filter";
export type Strategy =
  | "retry_request"
  | "continue_response"
  | "regenerate_tool"
  | "continue_after_confirmed_tool"
  | "reconcile_tool"
  | "pause"
  | "stop";
export type Pacing = { cause: FailureCause; attempt: number } | null;
export type Evidence = {
  cause: FailureCause;
  delivery: "definitely_unsent" | "possibly_sent";
  attempts: { consumed: number; limit?: number };
  output?: "none" | "partial";
  tool?: "none" | "proven_unexecuted" | "confirmed" | "uncertain";
  pacing?: Pacing;
  retryAfterSeconds?: number;
  cancelled?: boolean;
};
export type Decision = {
  strategy: Strategy;
  delayMs: number;
  nextPacing: Pacing;
  requiredAction: "none" | "continue_later" | "inspect_uncertain_tool" | "change_request";
};

export const RECOVERY_PROMPTS: Partial<Record<Strategy, string>> = {
  continue_response:
    "The previous response was interrupted. Restart that response from the beginning using the completed tool results above. Do not repeat completed tool actions.",
  regenerate_tool:
    "The previous response ended during an incomplete tool call. nod did not execute that call. Recreate it only if it is still needed.",
  continue_after_confirmed_tool: "Continue from the confirmed tool result above without repeating the tool.",
  reconcile_tool:
    "Reconcile the available tool evidence above before continuing. Do not repeat the tool unless the evidence proves it is safe.",
};

function pacingAfter(pacing: Pacing, cause: FailureCause, retryAfter?: number): { next: Pacing; delayMs: number } {
  if (retryAfter !== undefined) return { next: null, delayMs: Math.min(retryAfter, MAX_RETRY_AFTER_SECONDS) * 1000 };
  const attempt = pacing && pacing.cause === cause ? pacing.attempt + 1 : 1;
  return { next: { cause, attempt }, delayMs: PACING_MS[Math.min(attempt, PACING_MS.length) - 1] ?? 30_000 };
}

export function decideRecovery(e: Evidence): Decision {
  const none: Decision = { strategy: "stop", delayMs: 0, nextPacing: null, requiredAction: "none" };
  if (e.cancelled) return none;
  if (e.cause === "content_filter") return { ...none, requiredAction: "change_request" };
  if (e.cause === "provider_stream_timeout" || e.cause === "request_limit_reached")
    return {
      ...none,
      strategy: "pause",
      requiredAction: e.tool === "uncertain" ? "inspect_uncertain_tool" : "continue_later",
    };
  if (e.cause === "authentication") return { ...none, requiredAction: "change_request" };
  const limit = e.attempts.limit ?? DEFAULT_MAX_PROVIDER_ATTEMPTS;
  if (e.attempts.consumed >= limit)
    return {
      ...none,
      strategy: "pause",
      requiredAction: e.tool === "uncertain" ? "inspect_uncertain_tool" : "continue_later",
    };
  const { next, delayMs } = pacingAfter(e.pacing ?? null, e.cause, e.retryAfterSeconds);
  const retry = (strategy: Strategy): Decision => ({ strategy, delayMs, nextPacing: next, requiredAction: "none" });
  if (e.delivery === "definitely_unsent") return retry("retry_request");
  switch (e.tool ?? "none") {
    case "proven_unexecuted":
      return retry("regenerate_tool");
    case "confirmed":
      return retry("continue_after_confirmed_tool");
    case "uncertain":
      return retry("reconcile_tool");
    default:
      return retry(e.output === "partial" ? "continue_response" : "retry_request");
  }
}

/** Maps a thrown provider error to a failure cause. */
export function classifyFailure(error: unknown): FailureCause {
  const message = String((error as Error)?.message ?? error);
  if (/\(401\)|\(403\)|authentication|not signed in/i.test(message)) return "authentication";
  if (/\(429\)|rate limit/i.test(message)) return "rate_limited";
  if (/content_filter|content filter/i.test(message)) return "content_filter";
  if (/timed? ?out/i.test(message)) return "provider_stream_timeout";
  if (/\(5\d\d\)|unavailable|ECONNRESET|ECONNREFUSED|fetch failed/i.test(message)) return "provider_unavailable";
  return "transport_interrupted";
}
