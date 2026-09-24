import { expect, test } from "bun:test";
import { activityLabel, formatElapsed, formatTokens, usageTokens } from "../../src/ui/core/activity.ts";

test("elapsed renders seconds, minutes with seconds, and hours", () => {
  expect(formatElapsed(5_000)).toBe("5s");
  expect(formatElapsed(65_000)).toBe("1m5s");
  expect(formatElapsed(18 * 60_000)).toBe("18m0s");
  expect(formatElapsed(2 * 3_600_000 + 3 * 60_000)).toBe("2h3m");
});

test("token counts abbreviate past a thousand", () => {
  expect(formatTokens(10)).toBe("10");
  expect(formatTokens(1200)).toBe("1.2k");
  expect(formatTokens(10_000)).toBe("10k");
  expect(formatTokens(1_500_000)).toBe("1.5M");
  expect(usageTokens({ inputTokens: 10, outputTokens: 20 })).toBe("(↑10 ↓20)");
  expect(usageTokens({})).toBe("");
});

test("the activity line: thinking with elapsed and tokens, a running tool, asking", () => {
  const started = 100_000;
  expect(
    activityLabel({ phase: "thinking", startedAt: started }, started + 12_000, { inputTokens: 10, outputTokens: 20 }),
  ).toBe("• Thinking (12s) (↑10 ↓20)");
  expect(activityLabel({ phase: "tool", label: "Running bun test", startedAt: started }, started + 5_000)).toBe(
    "• Running bun test (5s)",
  );
  expect(activityLabel({ phase: "asking", startedAt: started }, started)).toBe("⏺ Asking");
});
