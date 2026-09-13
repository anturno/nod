/** The step loop: request, admit and run tool calls under the permission policy, repeat until the model answers. */
import {
  type ApprovalDecision,
  type ApprovalRequest,
  decidePermission,
  type Grant,
  MAX_REVIEWS_PER_TURN,
  type Reviewer,
  type ReviewInput,
  type Rule,
  suggestedGrants,
} from "../permissions/index.ts";
import { isToolOutputError } from "../tools/errors.ts";
import { prepareResult } from "../tools/result_store.ts";
import type { PermissionTarget, Preparation, ToolContext, ToolResult, ToolSpec } from "../tools/spec.ts";
import { type Admission, admit } from "./admission.ts";
import { leadingParallelGroup, runParallel } from "./batch.ts";
import {
  compact,
  estimateMessagesTokens,
  estimateTokens,
  planCompaction,
  recentContextTarget,
  selectRecentContext,
} from "./compaction.ts";
import {
  type AgentConfig,
  MALFORMED_ARGS_NOTICE,
  REVIEW_PROMPT,
  SHELL_VALIDATION_NOTICE,
  STEP_LIMIT_NOTICE,
  SUMMARIZE_PROMPT,
} from "./config.ts";
import { projectHistory } from "./history.ts";
import { classifyFailure, decideRecovery, type Pacing, RECOVERY_PROMPTS } from "./recovery.ts";
import type {
  ExecutionMemory,
  HistoryTurn,
  ImageRef,
  LLM,
  Message,
  PermissionMode,
  ToolCall,
  ToolStep,
  Usage,
  UserTurn,
} from "./types.ts";

export type PermissionPolicy = {
  mode: PermissionMode;
  rules: Rule[];
  grants: Grant[];
  interactive: boolean;
  prompter?: (request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalDecision>;
  reviewer?: Reviewer;
};

export type AgentDeps = {
  llm: LLM;
  config: AgentConfig;
  tools: ToolSpec[];
  toolContext: ToolContext;
  permissions: PermissionPolicy;
  /** Provider-executed tools such as {"type":"web_search"}. */
  providerTools?: Record<string, unknown>[];
  /** Runtime context appended to the system prompt: cwd, os, date, git state. */
  runtimeContext?: () => string;
  now?: () => number;
};

export type AgentState = {
  history: HistoryTurn[];
  usage: Usage;
  /** Follow-ups typed while the turn runs; consumed before the next model request. */
  steering: string[];
  /** Observed input_tokens / estimate ratio from the last completed request. */
  calibration?: number;
  attempts: number;
  pacing: Pacing;
};

export type AgentEvent =
  | { type: "text"; text: string }
  | { type: "reasoning"; text: string }
  | { type: "step"; step: number }
  | { type: "tool_started"; call: ToolCall; label: string; spec: ToolSpec }
  | { type: "tool_finished"; call: ToolCall; result: ToolResult; label: string; spec: ToolSpec }
  | { type: "provider_tool"; name: string; status: "started" | "completed" }
  | { type: "permission"; call: ToolCall; decision: string }
  | { type: "notice"; tone: "info" | "warning" | "error"; text: string }
  | { type: "compaction"; removedTurns: number }
  | { type: "recovery"; strategy: string; delayMs: number }
  | { type: "steering"; text: string };

export type TurnOutcome =
  | { kind: "completed"; turn: HistoryTurn; text: string; steps: number }
  | { kind: "interrupted"; turn: HistoryTurn; steps: number }
  | { kind: "paused"; turn: HistoryTurn; reason: string; steps: number; recoveryPrompt?: string }
  | { kind: "failed"; turn: HistoryTurn; error: string; steps: number };

export function createState(history: HistoryTurn[] = [], usage: Usage = {}): AgentState {
  return { history, usage, steering: [], attempts: 0, pacing: null };
}

const addUsage = (a: Usage, b?: Usage): Usage => ({
  inputTokens: (a.inputTokens ?? 0) + (b?.inputTokens ?? 0),
  outputTokens: (a.outputTokens ?? 0) + (b?.outputTokens ?? 0),
  cacheReadTokens: (a.cacheReadTokens ?? 0) + (b?.cacheReadTokens ?? 0),
  reasoningTokens: (a.reasoningTokens ?? 0) + (b?.reasoningTokens ?? 0),
});

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

type ToolMessage = Extract<Message, { role: "tool" }>;

/** The step records the loop keeps for the saved turn. */
class Execution {
  readonly steps: ToolStep[] = [];
  readonly steering: { text: string; afterStep: number }[] = [];
  readonly completedToolNames: string[] = [];
  memory(): ExecutionMemory {
    return { steps: this.steps.map((s) => ({ ...s })), steering: [...this.steering] };
  }
}

export class AgentLoop {
  constructor(
    private readonly deps: AgentDeps,
    readonly state: AgentState,
  ) {}

  private systemMessage(): Message {
    const { config } = this.deps;
    const parts = [
      config.systemPrompt,
      config.hostInstructions,
      config.skillCatalog,
      this.deps.runtimeContext?.() ?? "",
    ];
    return { role: "system", content: parts.filter((p) => p.trim().length > 0).join("\n\n") };
  }

  private async maybeCompact(
    trigger: "automatic" | "manual",
    withinTurn: Message[],
    signal?: AbortSignal,
  ): Promise<{ removedTurns: number } | null> {
    const { config, llm } = this.deps;
    const caps = { contextWindow: config.contextWindow, maxOutputTokens: config.maxOutputTokens };
    const ratio = this.state.calibration ?? 0.25;
    const historyMessages = projectHistory(this.state.history);
    const sourceTokens = estimateMessagesTokens(historyMessages, ratio);
    const requestTokens = sourceTokens + estimateMessagesTokens([this.systemMessage(), ...withinTurn], ratio);
    const plan = planCompaction({ trigger, caps, requestTokens, sourceTokens });
    if (plan.decision !== "compact") return null;
    const target = recentContextTarget(caps, sourceTokens);
    const cut = selectRecentContext(this.state.history, target, (t) =>
      estimateMessagesTokens(projectHistory([t]), ratio),
    );
    const previousSummary = this.state.history.find((t) => t.kind === "compacted_summary");
    if (cut.drop.length === 0 && !previousSummary) return null;
    const source = projectHistory([...(previousSummary ? [previousSummary] : []), ...cut.drop]);
    const handoff = await compact(llm, source, plan, { signal, ratio });
    const removedTurns =
      cut.drop.length + (previousSummary?.kind === "compacted_summary" ? previousSummary.removedTurns : 0);
    this.state.history = [{ kind: "compacted_summary", handoff, removedTurns }, ...cut.keep];
    return { removedTurns };
  }

  /** /compact: summarize now and wait for the next prompt. */
  async compactNow(signal?: AbortSignal): Promise<{ removedTurns: number } | null> {
    return this.maybeCompact("manual", [], signal);
  }

  async *run(prompt: UserTurn, signal?: AbortSignal): AsyncGenerator<AgentEvent, TurnOutcome> {
    const { config, llm, tools, deps } = { ...this.deps, deps: this.deps };
    const execution = new Execution();
    const withinTurn: Message[] = [];
    let step = 0;
    let silentToolSteps = 0;
    let continuationInjected = false;
    let malformedSteps = 0;
    let shellValidationSteps = 0;
    let partialText = "";
    let activeToolCall: ToolCall | undefined;
    let recoveryPrompt: string | undefined;
    const userMessage: Message = { role: "user", content: prompt.text, images: prompt.images };
    this.reviewBudget = { attempts: 0, max: MAX_REVIEWS_PER_TURN };
    this.currentPrompt = prompt.text;
    this.turnResults = [];
    this.turnFeedback = [];

    const interrupted = (reason: "cancelled" | "failed"): HistoryTurn => ({
      kind: "interrupted",
      user: prompt,
      assistant: partialText || undefined,
      activeToolCall,
      completedToolNames: [...execution.completedToolNames],
      execution: execution.memory(),
      reason,
      origin: "turn",
    });
    const finish = (text: string): HistoryTurn => ({
      kind: "assistant",
      user: prompt,
      assistant: text,
      execution: execution.memory(),
    });

    while (config.stepLimit === 0 || step < config.stepLimit) {
      if (signal?.aborted) return { kind: "interrupted", turn: interrupted("cancelled"), steps: step };
      for (const text of this.state.steering.splice(0)) {
        withinTurn.push({ role: "user", content: text });
        execution.steering.push({ text, afterStep: execution.steps.length - 1 });
        yield { type: "steering", text };
      }
      try {
        const compacted = await this.maybeCompact("automatic", [userMessage, ...withinTurn], signal);
        if (compacted) yield { type: "compaction", removedTurns: compacted.removedTurns };
      } catch (e) {
        if (signal?.aborted) return { kind: "interrupted", turn: interrupted("cancelled"), steps: step };
        yield { type: "notice", tone: "warning", text: `Compaction failed: ${(e as Error).message}` };
      }
      if (recoveryPrompt) {
        withinTurn.push({ role: "user", content: recoveryPrompt });
        recoveryPrompt = undefined;
      }
      const messages = [this.systemMessage(), ...projectHistory(this.state.history), userMessage, ...withinTurn];
      yield { type: "step", step: step + 1 };

      let content = "";
      let toolCalls: ToolCall[] = [];
      try {
        const stream = llm.stream(messages, tools, signal, {
          providerTools: deps.providerTools,
          effort: config.effort,
          toolChoice: step === 0 && config.firstCallToolChoice === "none" ? "none" : "auto",
        });
        let next = await stream.next();
        while (!next.done) {
          const event = next.value;
          if (event.type === "text") {
            content += event.text;
            partialText = content;
            yield { type: "text", text: event.text };
          } else if (event.type === "reasoning") yield { type: "reasoning", text: event.text };
          else if (event.type === "provider_tool")
            yield { type: "provider_tool", name: event.name, status: event.status };
          next = await stream.next();
        }
        const completion = next.value;
        // A completion whose text was never streamed (fakes, non-streaming providers) still reaches the host.
        if (completion.content.length > content.length)
          yield { type: "text", text: completion.content.slice(content.length) };
        content = completion.content;
        toolCalls = completion.toolCalls;
        this.state.usage = addUsage(this.state.usage, completion.usage);
        const estimate = estimateMessagesTokens(messages, 0.25);
        if (completion.usage?.inputTokens && estimate > 0 && !prompt.images?.length)
          this.state.calibration = Math.min(2, Math.max(0.1, (completion.usage.inputTokens / estimate) * 0.25));
        this.state.attempts = 0;
        this.state.pacing = null;
        if (completion.incomplete && toolCalls.length === 0 && content.trim().length === 0)
          throw new Error(`the response was cut off (${completion.incomplete})`);
      } catch (e) {
        if (signal?.aborted) return { kind: "interrupted", turn: interrupted("cancelled"), steps: step };
        this.state.attempts++;
        const decision = decideRecovery({
          cause: classifyFailure(e),
          delivery: partialText.length > 0 && content.length > 0 ? "possibly_sent" : "definitely_unsent",
          attempts: { consumed: this.state.attempts, limit: config.maxProviderAttempts },
          output: content.length > 0 ? "partial" : "none",
          pacing: this.state.pacing,
        });
        this.state.pacing = decision.nextPacing;
        if (decision.strategy === "stop")
          return { kind: "failed", turn: interrupted("failed"), error: (e as Error).message, steps: step };
        if (decision.strategy === "pause")
          return {
            kind: "paused",
            turn: interrupted("failed"),
            reason: (e as Error).message,
            steps: step,
            recoveryPrompt: RECOVERY_PROMPTS.continue_response,
          };
        yield { type: "recovery", strategy: decision.strategy, delayMs: decision.delayMs };
        yield { type: "notice", tone: "warning", text: `${(e as Error).message}. Retrying.` };
        await sleep(decision.delayMs, signal);
        if (content.length > 0) {
          withinTurn.push({ role: "assistant", content, toolCalls: [] });
          recoveryPrompt = RECOVERY_PROMPTS[decision.strategy];
        }
        continue;
      }

      if (toolCalls.length === 0) {
        const hasContent = content.trim().length > 0;
        if (!hasContent && silentToolSteps >= 2 && !continuationInjected) {
          withinTurn.push(
            { role: "assistant", content: "", toolCalls: [] },
            { role: "user", content: SUMMARIZE_PROMPT },
          );
          continuationInjected = true;
          step++;
          continue;
        }
        const text = hasContent ? content : "Done.";
        if (!hasContent) yield { type: "text", text };
        return { kind: "completed", turn: finish(text), text, steps: step + 1 };
      }

      withinTurn.push({ role: "assistant", content, toolCalls });
      silentToolSteps = content.trim().length > 0 ? 0 : silentToolSteps + 1;
      const admissions = toolCalls.map((call) => admit(call, this.deps.toolContext, tools));
      const allMalformed = admissions.every((a) => !a.ok && a.malformed);
      malformedSteps = allMalformed ? malformedSteps + 1 : 0;
      const shellInvalid = admissions.length > 0 && admissions.every((a) => !a.ok && a.spec?.name === "shell");
      shellValidationSteps = shellInvalid ? shellValidationSteps + 1 : 0;

      const stepRecord: ToolStep = { assistant: content, toolCalls, results: [], feedback: [] };
      execution.steps.push(stepRecord);
      let stepHadWrites = false;
      let cancelTurn = false;
      const feedback: string[] = [];

      const runOne = async (a: Admission): Promise<{ result: ToolResult; label: string }> => {
        const label = a.spec?.label?.(a.ok ? a.input : undefined, this.deps.toolContext) ?? a.call.name;
        if (!a.ok) return { result: { status: "failure", output: a.failure }, label };
        const outcome = await this.execute(a, feedback, signal);
        return { result: outcome, label };
      };

      const finishOne = async (a: Admission, r: { result: ToolResult; label: string }) => {
        const prepared = await prepareResult(
          this.deps.toolContext.resultDir,
          a.call.id,
          a.call.name,
          r.result.output,
          config.maxToolResultBytes,
          r.result.kind,
        );
        const failed = r.result.status === "failure" || isToolOutputError(prepared.output);
        const message: ToolMessage = {
          role: "tool",
          toolCallId: a.call.id,
          name: a.call.name,
          content: prepared.output,
          status: failed ? "failure" : "success",
          memory: { ...prepared.memory, ...r.result.memory },
        };
        stepRecord.results.push(message);
        this.turnResults.push(message);
        withinTurn.push(message);
        if (!failed) execution.completedToolNames.push(a.call.name);
        if (a.ok && (a.spec.activity === "write" || a.spec.activity === "edit") && !failed) stepHadWrites = true;
        if (r.result.cancelTurn) cancelTurn = true;
      };

      const group = leadingParallelGroup(
        admissions.map((a) => ({ call: a.call, spec: a.ok ? a.spec : undefined })),
        this.deps.permissions.mode,
      );
      let index = 0;
      if (group.len > 1) {
        const batch = admissions.slice(0, group.len);
        for (const a of batch)
          yield {
            type: "tool_started",
            call: a.call,
            label: a.spec?.label?.(a.ok ? a.input : undefined, this.deps.toolContext) ?? a.call.name,
            spec: a.spec as ToolSpec,
          };
        const settled = await runParallel(
          batch.map((a) => () => runOne(a)),
          signal,
        );
        for (let i = 0; i < batch.length; i++) {
          const a = batch[i] as Admission;
          const s = settled[i];
          if (!s) continue;
          if (s.ok) {
            await finishOne(a, s.value);
            yield {
              type: "tool_finished",
              call: a.call,
              result: s.value.result,
              label: s.value.label,
              spec: a.spec as ToolSpec,
            };
          } else if (s.cancelled) {
            activeToolCall = a.call;
          } else {
            const result: ToolResult = {
              status: "failure",
              output: `Tool execution failed: ${(s.error as Error)?.message ?? s.error}`,
            };
            await finishOne(a, { result, label: a.call.name });
            yield { type: "tool_finished", call: a.call, result, label: a.call.name, spec: a.spec as ToolSpec };
          }
        }
        index = group.len;
        if (signal?.aborted) return { kind: "interrupted", turn: interrupted("cancelled"), steps: step + 1 };
      }
      for (; index < admissions.length; index++) {
        const a = admissions[index] as Admission;
        if (signal?.aborted) {
          activeToolCall = a.call;
          return { kind: "interrupted", turn: interrupted("cancelled"), steps: step + 1 };
        }
        const label = a.spec?.label?.(a.ok ? a.input : undefined, this.deps.toolContext) ?? a.call.name;
        yield { type: "tool_started", call: a.call, label, spec: a.spec as ToolSpec };
        activeToolCall = a.call;
        let r: { result: ToolResult; label: string };
        try {
          r = await runOne(a);
        } catch (e) {
          if (signal?.aborted) return { kind: "interrupted", turn: interrupted("cancelled"), steps: step + 1 };
          r = { result: { status: "failure", output: `Tool execution failed: ${(e as Error).message}` }, label };
        }
        activeToolCall = undefined;
        await finishOne(a, r);
        yield { type: "tool_finished", call: a.call, result: r.result, label: r.label, spec: a.spec as ToolSpec };
        if (cancelTurn) break;
      }
      for (const text of feedback) {
        const message: Message = { role: "user", content: text, permissionFeedback: true };
        stepRecord.feedback?.push(message);
        withinTurn.push(message);
      }
      if (cancelTurn) return { kind: "interrupted", turn: interrupted("cancelled"), steps: step + 1 };
      if (stepHadWrites && config.reviewEnabled) withinTurn.push({ role: "user", content: REVIEW_PROMPT });
      if (malformedSteps >= 3) {
        yield { type: "notice", tone: "warning", text: MALFORMED_ARGS_NOTICE };
        return { kind: "completed", turn: finish(MALFORMED_ARGS_NOTICE), text: MALFORMED_ARGS_NOTICE, steps: step + 1 };
      }
      if (shellValidationSteps >= 3) {
        yield { type: "notice", tone: "warning", text: SHELL_VALIDATION_NOTICE };
        return {
          kind: "completed",
          turn: finish(SHELL_VALIDATION_NOTICE),
          text: SHELL_VALIDATION_NOTICE,
          steps: step + 1,
        };
      }
      step++;
    }
    yield { type: "notice", tone: "warning", text: STEP_LIMIT_NOTICE };
    const text = partialText ? `${partialText}\n\n${STEP_LIMIT_NOTICE}` : STEP_LIMIT_NOTICE;
    return { kind: "completed", turn: finish(text), text, steps: step };
  }

  private reviewBudget = { attempts: 0, max: MAX_REVIEWS_PER_TURN };
  private currentPrompt = "";
  private turnResults: Extract<Message, { role: "tool" }>[] = [];
  private turnFeedback: string[] = [];

  /** What the reviewer sees: the pending action, this turn's earlier results, and the user's real prompts. */
  private reviewInput(
    call: ToolCall,
    spec: ToolSpec,
    command: string | undefined,
    preparation?: Preparation,
  ): ReviewInput {
    const prompts = this.state.history.filter((t) => t.kind !== "compacted_summary").map((t) => t.user.text);
    return {
      origin: this.deps.config.origin,
      callId: call.id,
      action: command
        ? { kind: "command", command, resolvedCwd: this.deps.toolContext.cwd, background: false }
        : preparation?.diff
          ? {
              kind: "file_mutation",
              tool: spec.name,
              displayPath: preparation.diff.path,
              preimage: preparation.diff.before === null ? "absent" : "present",
              additions: preparation.diff.additions,
              deletions: preparation.diff.deletions,
            }
          : {
              kind: "tool",
              name: spec.name,
              argumentsJson: call.arguments,
              schemaJson: JSON.stringify(spec.parameters),
            },
      priorResults: this.turnResults.map((r) => ({ tool: r.name, status: r.status ?? "success", excerpt: r.content })),
      rootRequests: { current: this.currentPrompt, first: prompts[0], recent: prompts.at(-1) },
      feedback: this.turnFeedback,
    };
  }

  /** Permission decision, then the tool. Every refusal becomes the JSON the model reads. */
  private async execute(
    a: Extract<Admission, { ok: true }>,
    feedback: string[],
    signal?: AbortSignal,
  ): Promise<ToolResult> {
    const { spec, input, call } = a;
    const ctx = { ...this.deps.toolContext, signal };
    const targets: PermissionTarget[] = spec.targets?.(input, ctx) ?? [];
    let preparation: Preparation | undefined;
    if (spec.prepare) {
      try {
        preparation = await spec.prepare(input, ctx);
      } catch (e) {
        return { status: "failure", output: (e as Error).message };
      }
    }
    const policy = this.deps.permissions;
    const command = targets.find((t) => t.kind === "command")?.target;
    const cwdInside = !targets.some((t) => t.kind === "path" && t.external);
    const outcome = await decidePermission({
      toolName: spec.name,
      spec,
      targets,
      readsOnly: spec.readsOnly?.(input) ?? false,
      command,
      cwdInsideWorkspace: cwdInside,
      preparation,
      mode: policy.mode,
      rules: policy.rules,
      grants: policy.grants,
      interactive: policy.interactive,
      prompter: policy.prompter,
      reviewer: policy.reviewer ? { review: policy.reviewer.review, budget: this.reviewBudget } : undefined,
      reviewInput: () => this.reviewInput(call, spec, command, preparation),
      workspaceRoot: this.deps.config.workspaceRoot,
      origin: this.deps.config.origin,
      label: spec.label?.(input, ctx) ?? spec.name,
      signal,
    });
    if (outcome.feedback) {
      feedback.push(outcome.feedback);
      this.turnFeedback.push(outcome.feedback);
    }
    if (outcome.decision === "always")
      policy.grants.push(...(outcome.grants ?? suggestedGrants(this.deps.config.workspaceRoot, targets)));
    if (outcome.decision !== "once" && outcome.decision !== "always")
      return {
        status: "failure",
        output:
          outcome.resultJson ??
          JSON.stringify({ error: { type: "tool_permission_denied", tool_name: spec.name, reason: outcome.reason } }),
      };
    try {
      return await spec.call(input, ctx, preparation);
    } catch (e) {
      if (signal?.aborted) throw e;
      return { status: "failure", output: `Tool execution failed: ${(e as Error).message}` };
    }
  }
}
