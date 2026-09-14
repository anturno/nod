/** Rolling usage reports (24h/7d/30d) and the exact `nod usage` text/JSON. */
import type { GenerationFact, Incident, LoadedUsage } from "./store.ts";

export type Period = "24h" | "7d" | "30d";
export type Coverage = "not_started" | "partial" | "full";
export type Completeness = "complete" | "pending" | "incomplete" | "legacy";
export type Totals = {
  total_tokens: number;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number | null;
  request_count: number | null;
  total_cost: number;
};
export type UsageReport = {
  period: Period;
  snapshot_time_ms: number;
  window_start_ms: number;
  coverage_started_at_ms: number | null;
  coverage: Coverage;
  completeness: Completeness;
  totals: Totals | null;
  models: { model: string; totals: Totals }[];
};

const DURATION_MS: Record<Period, number> = { "24h": 24 * 3_600_000, "7d": 7 * 86_400_000, "30d": 30 * 86_400_000 };
const LABEL: Record<Period, string> = { "24h": "24 hours", "7d": "7 days", "30d": "30 days" };

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
export function formatUtcDate(ms: number): string {
  if (ms < 0 || !Number.isFinite(ms)) return "Unknown";
  const d = new Date(ms);
  return `${MONTHS[d.getUTCMonth()]} ${d.getUTCDate()}, ${d.getUTCFullYear()}`;
}

class Acc {
  input_tokens = 0;
  output_tokens = 0;
  cache_read_tokens = 0;
  cache_write_tokens = 0;
  reasoning_tokens: number | null = 0;
  request_count = 0;
  total_cost = 0;
  add(f: GenerationFact) {
    this.input_tokens += f.input_tokens;
    this.output_tokens += f.output_tokens;
    this.cache_read_tokens += f.cache_read_tokens;
    this.cache_write_tokens += f.cache_write_tokens;
    this.request_count += 1;
    this.reasoning_tokens =
      this.reasoning_tokens !== null && f.reasoning_tokens !== null ? this.reasoning_tokens + f.reasoning_tokens : null;
    this.total_cost += f.total_cost;
  }
  freeze(): Totals {
    return {
      total_tokens: this.input_tokens + this.output_tokens,
      input_tokens: this.input_tokens,
      output_tokens: this.output_tokens,
      cache_read_tokens: this.cache_read_tokens,
      cache_write_tokens: this.cache_write_tokens,
      reasoning_tokens: this.reasoning_tokens,
      request_count: this.request_count,
      total_cost: this.total_cost,
    };
  }
}

/** Closed-open window [now - period, now). Duplicate ids that disagree mark the report incomplete. */
export function buildReport(loaded: LoadedUsage, period: Period, now: number): UsageReport {
  const window_start_ms = now - DURATION_MS[period];
  const started = loaded.coverage_started_at_ms;
  const coverage_started_at_ms = started !== null && started <= now ? started : null;
  let completeness: Completeness = "complete";
  for (const i of loaded.incidents as Incident[]) {
    if (i.occurred_at_ms < window_start_ms || i.occurred_at_ms >= now) continue;
    if (i.completeness === "incomplete") completeness = "incomplete";
    else if (completeness === "complete") completeness = "pending";
  }
  const coverage: Coverage =
    coverage_started_at_ms === null ? "not_started" : coverage_started_at_ms <= window_start_ms ? "full" : "partial";
  const base = { period, snapshot_time_ms: now, window_start_ms, coverage_started_at_ms, coverage, completeness };
  if (coverage === "not_started") return { ...base, totals: null, models: [] };

  const seen = new Map<string, GenerationFact>();
  const totals = new Acc();
  const byModel = new Map<string, Acc>();
  for (const f of loaded.facts) {
    if (f.created_at_ms < window_start_ms || f.created_at_ms >= now) continue;
    const prev = seen.get(f.id);
    if (prev) {
      if (JSON.stringify(prev) !== JSON.stringify(f)) completeness = "incomplete";
      continue;
    }
    seen.set(f.id, f);
    totals.add(f);
    let acc = byModel.get(f.model);
    if (!acc) byModel.set(f.model, (acc = new Acc()));
    acc.add(f);
  }
  const models = [...byModel].map(([model, acc]) => ({ model, totals: acc.freeze() }));
  models.sort(
    (a, b) =>
      b.totals.total_tokens - a.totals.total_tokens ||
      b.totals.total_cost - a.totals.total_cost ||
      (a.model < b.model ? -1 : a.model > b.model ? 1 : 0),
  );
  return { ...base, completeness, totals: totals.freeze(), models };
}

const totalsJson = (t: Totals) =>
  `{"total_tokens":${t.total_tokens},"input_tokens":${t.input_tokens},"output_tokens":${t.output_tokens},"cache_read_tokens":${t.cache_read_tokens},"cache_write_tokens":${t.cache_write_tokens},"reasoning_tokens":${t.reasoning_tokens},"request_count":${t.request_count},"spend":${t.total_cost}}`;

export function renderUsage(r: UsageReport, fmt: "text" | "json"): string {
  if (fmt === "json")
    return `{"kind":"usage","schema_version":1,"period":${JSON.stringify(r.period)},"snapshot_time_ms":${r.snapshot_time_ms},"window_start_ms":${r.window_start_ms},"coverage":{"status":${JSON.stringify(r.coverage)},"started_at_ms":${r.coverage_started_at_ms},"full_window":${r.coverage === "full"}},"completeness":${JSON.stringify(r.completeness)},"totals":${r.totals ? totalsJson(r.totals) : "null"},"models":[${r.models
      .map((m) => `{"model":${JSON.stringify(m.model)},"totals":${totalsJson(m.totals)}}`)
      .join(",")}]}`;
  let out = `Usage (${LABEL[r.period]})\n`;
  if (r.coverage === "not_started") out += "Tracking has not started.\n";
  else if (r.coverage === "partial")
    out += `Tracking since ${formatUtcDate(r.coverage_started_at_ms!)} (partial window).\n`;
  if (r.completeness === "pending") out += "Known totals exclude pending Gateway reconciliation.\n";
  else if (r.completeness === "incomplete") out += "Known totals may be incomplete.\n";
  else if (r.completeness === "legacy") out += "This session predates complete usage tracking.\n";
  const t = r.totals;
  if (!t) return out;
  out += `Total tokens  ${t.total_tokens}\nInput         ${t.input_tokens}\nOutput        ${t.output_tokens}\n`;
  out += `Cache         ${t.cache_read_tokens} read · ${t.cache_write_tokens} write\n`;
  if (t.reasoning_tokens !== null) out += `Reasoning     ${t.reasoning_tokens}\n`;
  if (t.request_count !== null) out += `Requests      ${t.request_count}\n`;
  out += `Spend         $${t.total_cost.toFixed(4)}\n`;
  if (r.models.length > 0) {
    out += "\nBy model\n";
    for (const m of r.models)
      out += `- ${m.model}  ${m.totals.total_tokens} tokens  $${m.totals.total_cost.toFixed(4)}\n`;
  }
  return out;
}
