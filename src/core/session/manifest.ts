/** session.json: the per-session manifest. One writer per session; readers tolerate nothing but valid JSON. */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type { Effort, Provider } from "../agent/types.ts";
import { SessionError } from "./id.ts";
import { MANIFEST_FILE, writeAtomic } from "./layout.ts";

export type UsageTotals = {
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  reasoning_tokens: number;
  request_count: number;
  /** Always 0: subscriptions have no per-token price. Kept for output compatibility. */
  total_cost: number;
};

export type Manifest = {
  schema_version: 1;
  id: string;
  created_at_ms: number;
  updated_at_ms: number;
  origin_workspace_root: string;
  workspace_root: string;
  conversation_language: string;
  provider: Provider | null;
  model: string | null;
  effort: Effort | null;
  fast_mode: boolean;
  title: string | null;
  title_generated: boolean;
  preview: string | null;
  history_len: number;
  context_history_start: number;
  usage: UsageTotals;
  permission_grants: unknown[];
  has_checkpoint: boolean;
};

export const emptyUsage = (): UsageTotals => ({
  input_tokens: 0,
  output_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  reasoning_tokens: 0,
  request_count: 0,
  total_cost: 0,
});

export const manifestPath = (dir: string) => join(dir, MANIFEST_FILE);

export function writeManifest(dir: string, manifest: Manifest) {
  writeAtomic(manifestPath(dir), `${JSON.stringify(manifest)}\n`);
}

/** Throws SessionError("invalid_manifest") for anything that is not a schema 1 manifest of this session. */
export function readManifest(dir: string, expectedId?: string): Manifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(manifestPath(dir), "utf8"));
  } catch (err) {
    throw new SessionError("invalid_manifest", `unreadable session manifest at ${dir}: ${(err as Error).message}`);
  }
  const m = parsed as Partial<Manifest> | null;
  if (
    !m ||
    typeof m !== "object" ||
    m.schema_version !== 1 ||
    typeof m.id !== "string" ||
    (expectedId !== undefined && m.id !== expectedId) ||
    typeof m.created_at_ms !== "number" ||
    typeof m.updated_at_ms !== "number" ||
    typeof m.workspace_root !== "string" ||
    typeof m.history_len !== "number"
  )
    throw new SessionError("invalid_manifest", `invalid session manifest at ${dir}`);
  const defaults = {
    conversation_language: "und",
    origin_workspace_root: m.workspace_root,
    provider: null,
    model: null,
    effort: null,
    fast_mode: false,
    title: null,
    title_generated: false,
    preview: null,
    context_history_start: 0,
    usage: emptyUsage(),
    permission_grants: [],
    has_checkpoint: false,
  };
  return { ...defaults, ...(m as Manifest) };
}
