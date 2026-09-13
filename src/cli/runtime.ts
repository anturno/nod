/** Builds one agent runtime: config, model, tools, permissions, and the loop over a session's history. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type AgentConfig, modelCapabilities } from "../core/agent/config.ts";
import { AgentLoop, type AgentState, createState, type PermissionPolicy } from "../core/agent/loop.ts";
import type { HistoryTurn, ImageRef, PermissionMode } from "../core/agent/types.ts";
import type { ResolvedConfig } from "../core/config/resolve.ts";
import { gatherProjectContext } from "../core/context/agents.ts";
import { createReviewer, effectiveRules, type Prompter, parseRules, type Rule } from "../core/permissions/index.ts";
import { createShellManager } from "../core/shell/manager.ts";
import { catalogBudgetBytes, renderCatalog } from "../core/skills/catalog.ts";
import { createSkillService } from "../core/skills/service.ts";
import { builtinTools } from "../core/tools/registry.ts";
import type { AskUser, ToolContext, ToolSpec } from "../core/tools/spec.ts";
import type { AccessScope } from "../core/workspace/access.ts";
import { pickModel, type Subscription } from "../providers/providers.ts";

export const SYSTEM_PROMPT = readFileSync(new URL("../core/agent/system_prompt.md", import.meta.url), "utf8");

export type RuntimeOptions = {
  config: ResolvedConfig;
  access: AccessScope;
  sessionId: string;
  sessionDir: string;
  history: HistoryTurn[];
  interactive: boolean;
  prompter?: Prompter;
  askUser?: AskUser;
  images?: ImageRef[];
  permissionMode?: PermissionMode;
};

export type Runtime = {
  loop: AgentLoop;
  state: AgentState;
  provider: "codex" | "grok";
  model: string;
  llm: Subscription;
  tools: ToolSpec[];
  toolContext: ToolContext;
  policy: PermissionPolicy;
  close(): Promise<void>;
};

export function loadRules(config: ResolvedConfig): Rule[] {
  return effectiveRules(
    parseRules(config.permissionRules.user, "user").rules,
    parseRules(config.permissionRules.workspace, "workspace").rules,
  );
}

export function runtimeContext(cwd: string): string {
  const git = (...args: string[]) => {
    const r = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "ignore" });
    return r.exitCode === 0 ? r.stdout.toString().trim() : undefined;
  };
  const lines = [
    `cwd: ${cwd}`,
    `os: ${process.platform} ${process.arch}`,
    `date: ${new Date().toISOString().slice(0, 10)}`,
  ];
  const branch = git("rev-parse", "--abbrev-ref", "HEAD");
  if (branch !== undefined) {
    const status = git("status", "--porcelain") ?? "";
    const changed = status.length === 0 ? 0 : status.split("\n").length;
    lines.push(`git: branch ${branch}, ${changed} changed file(s)`);
  }
  return `<runtime_context>\n${lines.join("\n")}\n</runtime_context>`;
}

export async function createRuntime(o: RuntimeOptions): Promise<Runtime> {
  const picked = await pickModel(o.config.provider, o.config.model);
  const listed =
    (o.permissionMode ?? o.config.permissionMode) === "auto"
      ? await picked.sub.models().catch(() => [] as string[])
      : [];
  return assembleRuntime(o, { provider: picked.provider, model: picked.model, sub: picked.sub, listed });
}

export type ModelBinding = { provider: "codex" | "grok"; model: string; sub: Subscription; listed: string[] };

/** The runtime over an already chosen model; evals and tests pass a fake subscription here. */
export async function assembleRuntime(o: RuntimeOptions, picked: ModelBinding): Promise<Runtime> {
  const { config } = o;
  const caps = modelCapabilities(picked.provider, picked.model);
  const mode = o.permissionMode ?? config.permissionMode;
  const active = o.access.entries.filter((e) => e.active).map((e) => e.path);
  const resultDir = join(o.sessionDir, "results");
  const skills = createSkillService({ home: config.home, workspaceRoot: config.workspaceRoot });
  const shell = createShellManager({ maxOutputBytes: config.maxToolResultBytes, logDir: resultDir });
  const toolContext: ToolContext = {
    workspaceRoot: config.workspaceRoot,
    cwd: config.workspaceRoot,
    home: config.home,
    resultDir,
    sessionId: o.sessionId,
    maxToolResultBytes: config.maxToolResultBytes,
    images: o.images ?? [],
    additionalDirectories: active,
    shell,
    skills,
    askUser: o.askUser,
  };
  // ponytail: web_search/vision/subagent/MCP arrive in phase 4; unavailable services stay off the tool list.
  const hidden = new Set(["web_search", "subagent", "mcp_select_tool", "mcp_features", "capability_search"]);
  if (!(o.images?.length || caps.imageInput)) hidden.add("vision");
  if (!o.interactive) hidden.add("ask_user_question");
  const tools = builtinTools.filter((t) => !hidden.has(t.name));
  const rules = loadRules(config);
  const policy: PermissionPolicy = {
    mode,
    rules,
    grants: [],
    interactive: o.interactive,
    prompter: o.prompter,
    reviewer:
      mode === "auto"
        ? createReviewer({
            llm: picked.sub.llm(picked.model),
            llmFor: (m) => picked.sub.llm(m),
            provider: picked.provider,
            sessionModel: picked.model,
            listedModels: picked.listed,
            env: process.env,
          })
        : undefined,
  };
  const project = gatherProjectContext({
    home: config.home,
    workspaceRoot: config.workspaceRoot,
    limits: config.contextLimits,
    enabled: config.context,
  });
  const catalog = renderCatalog(skills.list(), {
    budgetBytes: catalogBudgetBytes(
      config.contextLimits.skill_catalog_bytes.source === "compiled default"
        ? undefined
        : config.contextLimits.skill_catalog_bytes.bytes,
      caps.contextWindow,
    ),
    descriptionBytes: config.contextLimits.skill_description_bytes.bytes,
  });
  const agentConfig: AgentConfig = {
    systemPrompt: SYSTEM_PROMPT,
    hostInstructions: project.text,
    skillCatalog: catalog,
    stepLimit: config.maxAgentSteps,
    maxToolResultBytes: config.maxToolResultBytes,
    maxProviderAttempts: 10,
    reviewEnabled: true,
    effort: config.effort,
    fastMode: config.fastMode,
    workspaceRoot: config.workspaceRoot,
    origin: "root",
    contextWindow: caps.contextWindow,
    maxOutputTokens: caps.maxOutputTokens,
    permissionMode: mode,
    firstCallToolChoice: config.firstCallToolChoice,
  };
  const state = createState(o.history);
  const loop = new AgentLoop(
    {
      llm: picked.sub.llm(picked.model),
      config: agentConfig,
      tools,
      toolContext,
      permissions: policy,
      runtimeContext: () => runtimeContext(config.workspaceRoot),
    },
    state,
  );
  return {
    loop,
    state,
    provider: picked.provider,
    model: picked.model,
    llm: picked.sub,
    tools,
    toolContext,
    policy,
    async close() {
      await shell.killAll();
    },
  };
}

export const hasGit = (cwd: string) =>
  existsSync(join(cwd, ".git")) || Bun.spawnSync(["git", "rev-parse"], { cwd }).exitCode === 0;
