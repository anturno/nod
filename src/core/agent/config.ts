/** Per-turn agent configuration and the small model capability table the loop needs. */
import type { Effort, PermissionMode, Provider } from "./types.ts";

export type AgentConfig = {
  systemPrompt: string;
  hostInstructions: string;
  skillCatalog: string;
  /** 0 = unbounded. */
  stepLimit: number;
  maxToolResultBytes: number;
  maxProviderAttempts: number;
  reviewEnabled: boolean;
  effort: Effort;
  fastMode: boolean;
  workspaceRoot: string;
  origin: "root" | "subagent";
  contextWindow?: number;
  maxOutputTokens?: number;
  permissionMode: PermissionMode;
  firstCallToolChoice: "auto" | "none";
};

export const STEP_LIMIT_NOTICE = "Agent step limit reached; continue with a follow-up prompt if needed.";
export const MALFORMED_ARGS_NOTICE =
  "Repeated malformed tool arguments stopped the agent loop. The invalid calls were not executed. Continue with a follow-up prompt if needed.";
export const SHELL_VALIDATION_NOTICE =
  "Repeated shell validation failures stopped the tool loop. The invalid shell calls were not executed and produced no shell effect.";
export const REVIEW_PROMPT =
  "Review the changes you just made. Re-read any modified files and briefly note any issues (syntax errors, missing imports, logic bugs). If everything looks correct, say so.";
export const SUMMARIZE_PROMPT = "Summarize what you just did.";

export type ModelCapabilities = {
  contextWindow?: number;
  maxOutputTokens?: number;
  efforts?: Effort[];
  fastMode?: boolean;
  imageInput?: boolean;
};

/**
 * ponytail: a static table for the subscription models we know; NOD_CONTEXT_WINDOW overrides. Unknown models get no
 * window, which disables automatic compaction. Upgrade path: read the catalog endpoints' context fields.
 */
const TABLE: Record<string, ModelCapabilities> = {
  "gpt-5.6-luna": {
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    efforts: ["low", "medium", "high", "xhigh"],
    fastMode: true,
    imageInput: true,
  },
  "gpt-5.4": {
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    efforts: ["low", "medium", "high", "xhigh"],
    fastMode: true,
    imageInput: true,
  },
  "gpt-5.4-mini": {
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    efforts: ["low", "medium", "high"],
    imageInput: true,
  },
  "gpt-5.3-codex": {
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    efforts: ["low", "medium", "high", "xhigh"],
    imageInput: true,
  },
  "gpt-5.2-codex": {
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    efforts: ["low", "medium", "high", "xhigh"],
    imageInput: true,
  },
  "gpt-5.1-codex-mini": {
    contextWindow: 400_000,
    maxOutputTokens: 128_000,
    efforts: ["low", "medium", "high"],
    imageInput: true,
  },
  "grok-4.5": { contextWindow: 256_000, maxOutputTokens: 32_000, efforts: ["low", "high"], imageInput: true },
  "grok-4": { contextWindow: 256_000, maxOutputTokens: 32_000, imageInput: true },
  "grok-code-fast-1": { contextWindow: 256_000, maxOutputTokens: 32_000, imageInput: false },
};

export function modelCapabilities(
  provider: Provider,
  model: string,
  env: NodeJS.ProcessEnv = process.env,
): ModelCapabilities {
  const known = TABLE[model] ?? Object.entries(TABLE).find(([k]) => model.startsWith(k))?.[1];
  const fallback: ModelCapabilities =
    provider === "grok" ? { contextWindow: 256_000, maxOutputTokens: 32_000, imageInput: true } : { imageInput: true };
  const caps = { ...fallback, ...known };
  const override = Number(env.NOD_CONTEXT_WINDOW);
  if (Number.isFinite(override) && override > 0) caps.contextWindow = override;
  return caps;
}
