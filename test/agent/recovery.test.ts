import { expect, test } from "bun:test";
import { classifyFailure, decideRecovery } from "../../src/core/agent/recovery.ts";

const base = { cause: "provider_unavailable" as const, delivery: "possibly_sent" as const, attempts: { consumed: 1 } };

test("decision table", () => {
  expect(decideRecovery({ ...base, cancelled: true }).strategy).toBe("stop");
  expect(decideRecovery({ ...base, cause: "content_filter" }).requiredAction).toBe("change_request");
  expect(decideRecovery({ ...base, cause: "provider_stream_timeout" }).strategy).toBe("pause");
  expect(decideRecovery({ ...base, attempts: { consumed: 10 } }).strategy).toBe("pause");
  expect(decideRecovery({ ...base, delivery: "definitely_unsent" }).strategy).toBe("retry_request");
  expect(decideRecovery({ ...base, tool: "proven_unexecuted" }).strategy).toBe("regenerate_tool");
  expect(decideRecovery({ ...base, tool: "confirmed" }).strategy).toBe("continue_after_confirmed_tool");
  expect(decideRecovery({ ...base, tool: "uncertain" }).strategy).toBe("reconcile_tool");
  expect(decideRecovery({ ...base, output: "partial" }).strategy).toBe("continue_response");
  expect(decideRecovery(base).strategy).toBe("retry_request");
});

test("pacing schedule sums to 121.25 s over nine attempts and caps retry_after", () => {
  let pacing = null;
  let total = 0;
  for (let i = 0; i < 9; i++) {
    const d = decideRecovery({ ...base, pacing });
    total += d.delayMs;
    pacing = d.nextPacing;
  }
  expect(total).toBe(121_250);
  expect(decideRecovery({ ...base, retryAfterSeconds: 90 }).delayMs).toBe(30_000);
});

test("classifies errors", () => {
  expect(classifyFailure(new Error("ChatGPT (429): slow down"))).toBe("rate_limited");
  expect(classifyFailure(new Error("ChatGPT (503): down"))).toBe("provider_unavailable");
  expect(classifyFailure(new Error("Not signed in. Run: nod login codex"))).toBe("authentication");
});
