/** ~/.nod/history.jsonl: prompts typed at the shell, recalled newest-first per workspace. */
import { appendFileSync, existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ensurePrivateDir, workspaceRoot, writeAtomic } from "./layout.ts";

export const HISTORY_FILE = "history.jsonl";
const MAX_RECORD_BYTES = 256 * 1024;
const COMPACTION_THRESHOLD_BYTES = 1024 * 1024;
const COMPACTION_RECORD_LIMIT = 1000;

export type HistoryDeps = { home: string; now: () => number; enabled?: boolean };
export type HistoryRecord = { schema_version: 1; timestamp_ms: number; workspace_root: string; text: string };
export type HistoryAppendOutcome = "appended" | "duplicate" | "record_too_large" | "disabled";

export const historyPath = (home: string) => join(home, HISTORY_FILE);

function readRecords(home: string): HistoryRecord[] {
  const path = historyPath(home);
  if (!existsSync(path)) return [];
  const out: HistoryRecord[] = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    if (!line) continue;
    try {
      const r = JSON.parse(line) as HistoryRecord;
      if (r?.schema_version === 1 && typeof r.text === "string" && typeof r.workspace_root === "string") out.push(r);
    } catch {
      // partial or corrupt line: skipped, never fatal for recall
    }
  }
  return out;
}

export function appendPromptHistory(deps: HistoryDeps, cwd: string, text: string): HistoryAppendOutcome {
  if (deps.enabled === false) return "disabled";
  const record: HistoryRecord = {
    schema_version: 1,
    timestamp_ms: deps.now(),
    workspace_root: workspaceRoot(cwd),
    text,
  };
  const line = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(line) > MAX_RECORD_BYTES) return "record_too_large";
  ensurePrivateDir(deps.home);
  const latest = loadPromptHistory(deps, cwd, 1)[0];
  if (latest === text) return "duplicate";
  const path = historyPath(deps.home);
  appendFileSync(path, line, { mode: 0o600 });
  if (statSync(path).size > COMPACTION_THRESHOLD_BYTES) {
    // ponytail: keep the newest 1000 records across all workspaces; per-workspace quotas if one workspace starves others.
    const kept = readRecords(deps.home).slice(-COMPACTION_RECORD_LIMIT);
    writeAtomic(path, kept.map((r) => `${JSON.stringify(r)}\n`).join(""));
  }
  return "appended";
}

/** Prompts for this workspace, newest first. */
export function loadPromptHistory(
  deps: Pick<HistoryDeps, "home" | "enabled">,
  cwd: string,
  limit = Infinity,
): string[] {
  if (deps.enabled === false) return [];
  const root = workspaceRoot(cwd);
  const out: string[] = [];
  const records = readRecords(deps.home);
  for (let i = records.length - 1; i >= 0 && out.length < limit; i--) {
    if (records[i]!.workspace_root === root) out.push(records[i]!.text);
  }
  return out;
}
