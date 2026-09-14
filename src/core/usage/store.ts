/**
 * ~/.nod/usage.jsonl: one line per generation, plus a coverage marker and incident records.
 * Facts are deduped by id; a differing duplicate is a conflict (kept once, reported as incomplete).
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  truncateSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

export const USAGE_FILE = "usage.jsonl";
const LOCK_FILE = "usage.lock";
const LOCK_DEADLINE_MS = 2000;
const LOCK_STALE_MS = 10_000;
const MAX_RECORD_BYTES = 16 * 1024;
const COMPACTION_THRESHOLD_BYTES = 8 * 1024 * 1024;
const RETENTION_MS = 35 * 24 * 60 * 60 * 1000;

export class UsageError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export type GenerationFact = {
  id: string;
  created_at_ms: number;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number | null;
  billable_web_search_calls: number;
  /** Always 0 for subscriptions; the field survives for output compatibility. */
  total_cost: number;
};
export type Incident = { occurred_at_ms: number; completeness: "pending" | "incomplete" };
export type LoadedUsage = {
  coverage_started_at_ms: number | null;
  facts: GenerationFact[];
  incidents: Incident[];
  record_count: number;
};
export type AppendOutcome = "appended" | "duplicate" | "conflict";
export type UsageDeps = { home: string; now: () => number };

export const usagePath = (home: string) => join(home, USAGE_FILE);

const factEqual = (a: GenerationFact, b: GenerationFact) =>
  a.id === b.id &&
  a.created_at_ms === b.created_at_ms &&
  a.model === b.model &&
  a.input_tokens === b.input_tokens &&
  a.output_tokens === b.output_tokens &&
  a.cache_read_tokens === b.cache_read_tokens &&
  a.cache_write_tokens === b.cache_write_tokens &&
  a.reasoning_tokens === b.reasoning_tokens &&
  a.billable_web_search_calls === b.billable_web_search_calls &&
  a.total_cost === b.total_cost;

const nonNeg = (n: unknown) => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;

/** Throws UsageError("invalid_fact") on shape violations; ids are free-form but must be short printable ASCII. */
export function validateFact(f: GenerationFact) {
  const ok =
    typeof f.id === "string" &&
    /^[\x21-\x7e]{1,64}$/.test(f.id) &&
    nonNeg(f.created_at_ms) &&
    typeof f.model === "string" &&
    /^[\x21-\x7e]{1,128}$/.test(f.model) &&
    nonNeg(f.input_tokens) &&
    nonNeg(f.output_tokens) &&
    nonNeg(f.cache_read_tokens) &&
    nonNeg(f.cache_write_tokens) &&
    (f.reasoning_tokens === null || nonNeg(f.reasoning_tokens)) &&
    nonNeg(f.billable_web_search_calls) &&
    typeof f.total_cost === "number" &&
    Number.isFinite(f.total_cost) &&
    f.total_cost >= 0 &&
    f.cache_read_tokens <= f.input_tokens &&
    f.cache_write_tokens <= f.input_tokens &&
    (f.reasoning_tokens === null || f.reasoning_tokens <= f.output_tokens);
  if (!ok) throw new UsageError("invalid_fact", `invalid generation fact ${JSON.stringify(f.id)}`);
}

const coverageLine = (started_at_ms: number) =>
  `{"schema_version":1,"kind":"coverage","started_at_ms":${started_at_ms}}\n`;
const incidentLine = (i: Incident) =>
  `{"schema_version":1,"kind":"incident","occurred_at_ms":${i.occurred_at_ms},"completeness":${JSON.stringify(i.completeness)}}\n`;
export const generationLine = (f: GenerationFact) =>
  `{"schema_version":1,"kind":"generation","fact":{"id":${JSON.stringify(f.id)},"created_at_ms":${f.created_at_ms},"model":${JSON.stringify(f.model)},"input_tokens":${f.input_tokens},"output_tokens":${f.output_tokens},"cache_read_tokens":${f.cache_read_tokens},"cache_write_tokens":${f.cache_write_tokens},"reasoning_tokens":${f.reasoning_tokens},"billable_web_search_calls":${f.billable_web_search_calls},"total_cost":${f.total_cost}}}\n`;

type Parsed = { raw: string; complete: boolean };

function readRaw(home: string): Parsed {
  const path = usagePath(home);
  if (!existsSync(path)) return { raw: "", complete: true };
  const raw = readFileSync(path, "utf8");
  if (raw.length === 0 || raw.endsWith("\n")) return { raw, complete: true };
  const cut = raw.lastIndexOf("\n") + 1;
  return { raw: raw.slice(0, cut), complete: false };
}

function parseLines(raw: string): LoadedUsage {
  const loaded: LoadedUsage = { coverage_started_at_ms: null, facts: [], incidents: [], record_count: 0 };
  const seen = new Map<string, GenerationFact[]>();
  for (const line of raw.split("\n")) {
    if (!line) continue;
    loaded.record_count++;
    if (line.length > MAX_RECORD_BYTES) throw new UsageError("invalid_store", "usage record too large");
    let r: { schema_version?: number; kind?: string; started_at_ms?: number; fact?: GenerationFact } & Incident;
    try {
      r = JSON.parse(line);
    } catch {
      throw new UsageError("invalid_store", "corrupt usage record");
    }
    if (r?.schema_version !== 1) throw new UsageError("invalid_store", "unknown usage schema");
    if (r.kind === "coverage") {
      if (!nonNeg(r.started_at_ms)) throw new UsageError("invalid_store", "invalid coverage record");
      if (loaded.coverage_started_at_ms !== null && loaded.coverage_started_at_ms !== r.started_at_ms)
        throw new UsageError("invalid_store", "conflicting coverage records");
      loaded.coverage_started_at_ms = r.started_at_ms!;
    } else if (r.kind === "generation") {
      if (loaded.coverage_started_at_ms === null || !r.fact)
        throw new UsageError("invalid_store", "generation before coverage");
      const fact: GenerationFact = { ...r.fact, billable_web_search_calls: r.fact.billable_web_search_calls ?? 0 };
      validateFact(fact);
      const variants = seen.get(fact.id) ?? [];
      if (variants.some((v) => factEqual(v, fact))) continue;
      if (variants.length >= 2) continue; // ponytail: keep at most two variants per id
      variants.push(fact);
      seen.set(fact.id, variants);
      loaded.facts.push(fact);
    } else if (r.kind === "incident") {
      if (!nonNeg(r.occurred_at_ms) || (r.completeness !== "pending" && r.completeness !== "incomplete"))
        throw new UsageError("invalid_store", "invalid incident record");
      loaded.incidents.push({ occurred_at_ms: r.occurred_at_ms, completeness: r.completeness });
    } else if (r.kind !== "pending") throw new UsageError("invalid_store", `unknown usage record kind ${r.kind}`);
  }
  return loaded;
}

/** Reads the store; an unterminated trailing line is ignored, a corrupt line throws UsageError("invalid_store"). */
export function loadUsage(home: string): LoadedUsage {
  return parseLines(readRaw(home).raw);
}

function withLock<T>(home: string, body: () => T): T {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const lock = join(home, LOCK_FILE);
  const deadline = Date.now() + LOCK_DEADLINE_MS;
  for (;;) {
    try {
      writeFileSync(lock, `${process.pid}\n`, { flag: "wx", mode: 0o600 });
      break;
    } catch {
      try {
        if (Date.now() - statSync(lock).mtimeMs > LOCK_STALE_MS) rmSync(lock, { force: true });
      } catch {}
      if (Date.now() > deadline) throw new UsageError("lock_busy", "usage store is busy");
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
  }
  try {
    return body();
  } finally {
    rmSync(lock, { force: true });
  }
}

function retained(loaded: LoadedUsage, now_ms: number): string {
  const cutoff = now_ms - RETENTION_MS;
  let out = coverageLine(loaded.coverage_started_at_ms ?? now_ms);
  for (const f of loaded.facts) if (f.created_at_ms >= cutoff) out += generationLine(f);
  for (const i of loaded.incidents) if (i.occurred_at_ms >= cutoff) out += incidentLine(i);
  return out;
}

export function appendGeneration(deps: UsageDeps, fact: GenerationFact): AppendOutcome {
  validateFact(fact);
  const line = generationLine(fact);
  if (Buffer.byteLength(line) > MAX_RECORD_BYTES) throw new UsageError("record_too_large", "usage record too large");
  return withLock(deps.home, () => {
    const path = usagePath(deps.home);
    const { raw, complete } = readRaw(deps.home);
    const loaded = parseLines(raw);
    const now_ms = Math.max(deps.now(), 0);
    const variants = loaded.facts.filter((f) => f.id === fact.id);
    let outcome: AppendOutcome = "appended";
    let write = true;
    if (variants.some((v) => factEqual(v, fact))) (outcome = "duplicate"), (write = false);
    else if (variants.length > 0) (outcome = "conflict"), (write = variants.length < 2);

    let pending = "";
    if (loaded.coverage_started_at_ms === null) pending += coverageLine(now_ms);
    if (!complete) {
      truncateSync(path, Buffer.byteLength(raw));
      pending += incidentLine({ occurred_at_ms: now_ms, completeness: "incomplete" });
    }
    if (write) pending += line;
    if (!pending) return outcome;
    appendFileSync(path, pending, { mode: 0o600 });
    if (statSync(path).size > COMPACTION_THRESHOLD_BYTES) {
      const tmp = `${path}.${process.pid}.tmp`;
      writeFileSync(tmp, retained(parseLines(readRaw(deps.home).raw), now_ms), { mode: 0o600 });
      renameSync(tmp, path);
    }
    return outcome;
  });
}
