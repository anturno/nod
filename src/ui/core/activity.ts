/** The one-line activity indicator: `• Thinking (12s) (↑10 ↓20)`, `• Running bun test (5s)`, `⏺ Asking`. */

export type Activity = {
  phase: "thinking" | "tool" | "asking" | "compacting";
  /** The running tool's label, e.g. "Running bun test". */
  label?: string;
  startedAt: number;
};

/** `5s`, `1m5s`, `18m0s`, `2h3m`. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m${s % 60}s`;
  return `${Math.floor(m / 60)}h${m % 60}m`;
}

/** `10`, `1.2k`, `10k`, `1.5M`. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 10_000) return `${(n / 1000).toFixed(1).replace(/\.0$/, "")}k`;
  if (n < 1_000_000) return `${Math.round(n / 1000)}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

export const usageTokens = (usage: { inputTokens?: number; outputTokens?: number }) =>
  usage.inputTokens || usage.outputTokens
    ? `(↑${formatTokens(usage.inputTokens ?? 0)} ↓${formatTokens(usage.outputTokens ?? 0)})`
    : "";

export function activityLabel(
  a: Activity,
  now: number,
  usage: { inputTokens?: number; outputTokens?: number } = {},
): string {
  if (a.phase === "asking") return "⏺ Asking";
  const elapsed = `(${formatElapsed(now - a.startedAt)})`;
  const tokens = usageTokens(usage);
  const head = a.phase === "thinking" ? "Thinking" : a.phase === "compacting" ? "Compacting" : (a.label ?? "Running");
  return [`• ${head}`, elapsed, tokens].filter(Boolean).join(" ");
}
