/** Which tool calls of one model reply may run concurrently, and how their results are assembled in order. */
import type { ToolSpec } from "../tools/spec.ts";
import type { PermissionMode, ToolCall } from "./types.ts";

const PARALLEL_READ_ONLY = new Set([
  "glob_files",
  "read_file",
  "read_tool_result",
  "grep_files",
  "skill",
  "web_fetch",
  "web_search",
]);

export type ParallelGroup = { kind: "none" | "read_only" | "subagent"; len: number };

/** The longest leading run of read-only calls, else of subagent calls (fx parallel_execution.zig 17-68). */
export function leadingParallelGroup(
  calls: { call: ToolCall; spec?: ToolSpec }[],
  mode: PermissionMode,
): ParallelGroup {
  let readOnly = 0;
  for (const c of calls)
    if (c.spec && PARALLEL_READ_ONLY.has(c.spec.name)) readOnly++;
    else break;
  if (readOnly > 1 && mode !== "ask") return { kind: "read_only", len: readOnly };
  let sub = 0;
  for (const c of calls)
    if (c.spec?.name === "subagent") sub++;
    else break;
  if (sub > 1) return { kind: "subagent", len: sub };
  return { kind: "none", len: 0 };
}

export type Settled<T> = { ok: true; value: T } | { ok: false; error: unknown; cancelled: boolean };

/** Runs all at once and keeps call order. A failure after an abort is reported as cancelled. */
export async function runParallel<T>(items: (() => Promise<T>)[], signal?: AbortSignal): Promise<Settled<T>[]> {
  const results = await Promise.allSettled(items.map((run) => run()));
  return results.map((r) =>
    r.status === "fulfilled"
      ? { ok: true, value: r.value }
      : { ok: false, error: r.reason, cancelled: signal?.aborted ?? false },
  );
}
