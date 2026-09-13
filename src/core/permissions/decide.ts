/** The permission decision for one tool call (fx tool_admission.zig 1289-1467, 1076-1139; command_admission.zig 123-150). */
import path from "node:path";
import type { DenialReason, PermissionMode } from "../agent/types.ts";
import type { PermissionTarget, Preparation, ToolSpec } from "../tools/spec.ts";
import { classifyCommand, knownReversibleAutoCommand } from "./commands.ts";
import { type Grant, grantAllows, grantsAllowAll, grantTarget, suggestedGrants } from "./grants.ts";
import type { ReviewInput, ReviewInvalidReason, ReviewResult } from "./reviewer.ts";
import { permissionName, type Rule, ruleDecision } from "./rules.ts";

export type ApprovalRequest = {
  toolName: string;
  label: string;
  kind: "command" | "file" | "mcp" | "other" | "confirm";
  detail?: string;
  preparation?: Preparation;
  targets: PermissionTarget[];
  suggestedGrants: Grant[];
};
export type ApprovalDecision = { outcome: "once" | "always" | "deny"; note?: string };
export type Prompter = (request: ApprovalRequest, signal?: AbortSignal) => Promise<ApprovalDecision>;

export type ReviewBudget = { attempts: number; max: number };
export const MAX_REVIEWS_PER_TURN = 2;

export type DecisionInput = {
  toolName: string;
  spec: Pick<ToolSpec, "activity" | "requiresApproval" | "approvalPolicy" | "permissionTarget">;
  targets: PermissionTarget[];
  /** This call cannot change anything (shell interact/stop without input). */
  readsOnly: boolean;
  /** The shell command for a shell run call. */
  command?: string;
  /** Explicit shell profile; undefined keeps the default environment. */
  profile?: "clean" | "user";
  cwdInsideWorkspace?: boolean;
  preparation?: Preparation;
  mode: PermissionMode;
  rules: Rule[];
  grants: Grant[];
  interactive: boolean;
  prompter?: Prompter;
  reviewer?: { review(input: ReviewInput, signal?: AbortSignal): Promise<ReviewResult>; budget: ReviewBudget };
  reviewInput?: () => ReviewInput;
  workspaceRoot: string;
  origin: "root" | "subagent";
  label?: string;
  detail?: string;
  isMcpTool?: boolean;
  signal?: AbortSignal;
};

export type Outcome = {
  decision: "once" | "always" | "deny" | "policy_denied" | "permission_required";
  reason?: DenialReason;
  /** Reviewer rationale on caution. */
  advice?: string;
  /** Why the reviewer was unavailable. */
  cause?: ReviewInvalidReason;
  /** Grants to add when the user chose "Yes, and don't ask again". */
  grants?: Grant[];
  /** The user's written amendment from the approval prompt. */
  feedback?: string;
  /** The tool result the model sees for a denied or held call. */
  resultJson?: string;
};

const NONINTERACTIVE_SUGGESTION =
  "The tool did not run. Noninteractive mode cannot show an approval prompt. Rerun interactively to approve, or configure a narrow permission rule before retrying.";

function deniedMessage(toolName: string, reason: DenialReason): string {
  switch (reason) {
    case "user_denied":
      return "Permission denied by user";
    case "auto_denied":
      return "Blocked by automatic safety policy";
    case "review_caution":
      return "Action held after safety review";
    case "review_evidence_incomplete":
      return "Safety review evidence incomplete; action held";
    case "review_unavailable":
      return "Safety reviewer unavailable; action held";
    case "policy_denied":
      return toolName === "web_search"
        ? "Network or browser access was denied by configured policy"
        : "Tool access was denied by configured policy";
    case "permission_required":
      if (toolName === "shell") return "Shell command approval is required before this tool can run";
      if (toolName === "web_search") return "Network or browser approval is required before this tool can run";
      return "Tool approval is required before this tool can run";
  }
}

function deniedSuggestion(reason: DenialReason): string {
  switch (reason) {
    case "user_denied":
      return "The tool did not run. Do not retry unchanged; explain the denial or use a safer allowed alternative.";
    case "auto_denied":
      return "The tool did not run. This is a legacy automatic denial; choose a materially different safe action or explain the blocker.";
    case "review_caution":
      return "The action did not run. Use the review advice to choose a materially different safe action, or explain why no safe path remains.";
    case "review_evidence_incomplete":
      return "The action did not run because safety review could not inspect the complete exact action. Do not retry unchanged; reduce the action or supporting evidence to fit the review limits, or choose a materially different fully inspectable action.";
    case "review_unavailable":
      return "The action did not run because safety review was unavailable. Continue with a different safe action or retry later.";
    case "policy_denied":
      return "The tool did not run. Do not retry unchanged; explain the configured policy blocker or use an allowed alternative.";
    case "permission_required":
      return NONINTERACTIVE_SUGGESTION;
  }
}

/** The B.3 denial JSON: tool_permission_denied for user/policy reasons, tool_review_held for review reasons. */
export function permissionDeniedJson(
  toolName: string,
  reason: DenialReason,
  extra: { advice?: string; cause?: ReviewInvalidReason } = {},
): string {
  const held =
    reason === "review_caution" || reason === "review_evidence_incomplete" || reason === "review_unavailable";
  const message = deniedMessage(toolName, reason);
  const suggestion = deniedSuggestion(reason);
  if (!held) {
    return JSON.stringify({
      error: { type: "tool_permission_denied", tool_name: toolName, message, reason, denied: true, suggestion },
    });
  }
  return JSON.stringify({
    error: {
      type: "tool_review_held",
      tool_name: toolName,
      message,
      reason,
      ...(extra.cause ? { review_cause: extra.cause } : {}),
      held: true,
      ...(extra.advice ? { advice: extra.advice } : {}),
      suggestion,
    },
  });
}

const SENSITIVE_SEQUENCES: string[][] = [
  [".git", "hooks"],
  [".git", "config"],
  [".git", "config.worktree"],
  [".ssh", "authorized_keys"],
  [".ssh", "config"],
  ["Library", "LaunchAgents"],
  ["Library", "LaunchDaemons"],
  [".config", "autostart"],
  [".config", "fish", "config.fish"],
  [".zshrc"],
  [".bashrc"],
  [".bash_profile"],
  [".profile"],
];

/** Paths auto mode never writes without review, even inside the workspace. */
export function sensitiveAutoWriteTarget(target: string): boolean {
  const components = target.split("/").filter((c) => c.length > 0);
  return SENSITIVE_SEQUENCES.some((expected) => {
    let matched = 0;
    for (const component of components) {
      if (component === expected[matched]) {
        matched++;
        if (matched === expected.length) return true;
      } else matched = component === expected[0] ? 1 : 0;
    }
    return false;
  });
}

const isFileMutation = (input: DecisionInput) => input.toolName === "write_file" || input.toolName === "edit_file";

function denied(
  toolName: string,
  decision: Outcome["decision"],
  reason: DenialReason,
  extra: Pick<Outcome, "advice" | "cause"> = {},
): Outcome {
  return { decision, reason, ...extra, resultJson: permissionDeniedJson(toolName, reason, extra) };
}

function requestKind(input: DecisionInput): ApprovalRequest["kind"] {
  if (input.command !== undefined) return "command";
  if (isFileMutation(input)) return "file";
  if (input.isMcpTool) return "mcp";
  if (input.spec.approvalPolicy === "ask_only") return "confirm";
  return "other";
}

async function prompt(input: DecisionInput, targets: PermissionTarget[]): Promise<Outcome> {
  if (!input.interactive || !input.prompter)
    return denied(input.toolName, "permission_required", "permission_required");
  const grants = suggestedGrants(input.workspaceRoot, targets);
  const response = await input.prompter(
    {
      toolName: input.toolName,
      label: input.label ?? [input.toolName, targets[0]?.target].filter(Boolean).join(" "),
      kind: requestKind(input),
      detail: input.detail,
      preparation: input.preparation,
      targets,
      suggestedGrants: grants,
    },
    input.signal,
  );
  const feedback = response.note?.trim() ? { feedback: response.note.trim() } : {};
  if (response.outcome === "deny") return { ...denied(input.toolName, "deny", "user_denied"), ...feedback };
  if (response.outcome === "always") return { decision: "always", grants, ...feedback };
  return { decision: "once", ...feedback };
}

async function automaticReview(input: DecisionInput): Promise<Outcome> {
  const unavailable = (cause: ReviewInvalidReason) => denied(input.toolName, "deny", "review_unavailable", { cause });
  if (!input.reviewer) return unavailable("reviewer_unconfigured");
  if (!input.reviewInput) return unavailable("invalid_context");
  const budget = input.reviewer.budget;
  if (budget.attempts >= budget.max) return unavailable("turn_review_budget_exhausted");
  budget.attempts++;
  const review = await input.reviewer.review(input.reviewInput(), input.signal);
  switch (review.kind) {
    case "clear":
      return { decision: "once", advice: review.rationale };
    case "caution":
      return denied(input.toolName, "deny", "review_caution", { advice: review.rationale });
    case "evidence_incomplete":
      return denied(input.toolName, "deny", "review_evidence_incomplete");
    case "invalid":
      return unavailable(review.reason);
  }
}

/** In auto mode, workspace-local (or brand-new) non-sensitive file writes skip the reviewer. */
function fileMutationBypassesReview(input: DecisionInput, targets: PermissionTarget[]): boolean {
  return targets.every((t) => {
    const absolute = grantTarget(t);
    const reversible = t.external !== true || input.preparation?.diff?.before === null;
    return reversible && !sensitiveAutoWriteTarget(absolute) && !sensitiveAutoWriteTarget(t.target);
  });
}

function requiresShellAuthority(input: DecisionInput): boolean {
  if (input.profile === "user") return true;
  if (input.profile === "clean") return input.mode !== "auto";
  return false;
}

/**
 * Exact fx order: yolo → rules per target (deny / configured ask + grants / none) → configured ask prompts →
 * all authorized or granted → ordinary resolution (direct read-only commands, ask_only, read-only calls,
 * tools without approval, auto: reversible commands and workspace file writes, otherwise the reviewer;
 * ask: the prompt, or permission_required when nothing can prompt).
 */
export async function decidePermission(input: DecisionInput): Promise<Outcome> {
  if (input.mode === "yolo") return { decision: "once" };
  const permission = permissionName(input.toolName);
  const targets: PermissionTarget[] = input.targets.length
    ? input.targets
    : [{ permission, target: input.toolName, kind: "other" }];

  let configuredAsk = false;
  let allAuthorized = true;
  for (const target of targets) {
    switch (ruleDecision(input.rules, target.permission, input.toolName, target.target)) {
      case "deny":
        return denied(input.toolName, "policy_denied", "policy_denied");
      case "allow":
        break;
      case "ask":
        if (grantAllows(input.grants, target.permission, input.toolName, grantTarget(target))) break;
        configuredAsk = true;
        break;
      case "none":
        allAuthorized = false;
    }
  }
  if (configuredAsk) return prompt(input, targets);
  if (allAuthorized) return { decision: "once" };
  if (grantsAllowAll(input.grants, input.toolName, targets)) return { decision: "once" };

  const commandCall = input.spec.activity === "command" && input.command !== undefined;
  if (commandCall && !requiresShellAuthority(input) && classifyCommand(input.command!).kind === "direct_read_only") {
    return { decision: "once" };
  }
  if (input.spec.approvalPolicy === "ask_only") {
    return input.mode === "auto" ? { decision: "once" } : prompt(input, targets);
  }
  if (input.mode === "auto" && !commandCall && !input.isMcpTool && input.readsOnly) return { decision: "once" };
  if (!commandCall && !input.spec.requiresApproval && !input.isMcpTool) return { decision: "once" };

  if (input.mode === "auto") {
    if (commandCall && knownReversibleAutoCommand(input.command!, input.cwdInsideWorkspace ?? true)) {
      return { decision: "once" };
    }
    if (isFileMutation(input) && fileMutationBypassesReview(input, targets)) return { decision: "once" };
    return automaticReview(input);
  }
  return prompt(input, targets);
}

/** Workspace-relative display for a path, or the path itself when outside. */
export function displayPath(workspaceRoot: string, absolute: string): string {
  const relative = path.relative(workspaceRoot, absolute);
  return relative && !relative.startsWith("..") && !path.isAbsolute(relative) ? relative : absolute;
}
