/** Structured error JSON the model receives when a tool did not run, was held, or failed. */
import type { DenialReason } from "../agent/types.ts";

export type Detail = string | number | boolean;

export function toolExecutionFailed(
  tool: string,
  message: string,
  extra: { details?: Record<string, Detail>; suggestion?: string } = {},
): string {
  const error: Record<string, unknown> = { type: "tool_execution_failed", tool_name: tool, message };
  if (extra.details && Object.keys(extra.details).length > 0) error.details = extra.details;
  if (extra.suggestion) error.suggestion = extra.suggestion;
  return JSON.stringify({ error });
}

export function malformedArguments(tool: string): string {
  return toolExecutionFailed(tool, "Tool arguments were not valid JSON.", {
    suggestion: "Reissue the tool call with complete valid JSON arguments matching the tool schema.",
  });
}

export function nonObjectArguments(tool: string): string {
  return toolExecutionFailed(tool, "Tool arguments must be a JSON object. The call was not executed.", {
    suggestion: "Reissue the tool call with a JSON object matching the tool schema.",
  });
}

export function unknownTool(tool: string): string {
  return toolExecutionFailed(tool, `Unsupported tool: ${tool}`, {
    suggestion: "Use only the tools advertised for this session.",
  });
}

export function filesystemAccessDenied(tool: string, path: string, err: string): string {
  const suggestion =
    process.platform === "darwin"
      ? "Do not retry this path unchanged or propose a symlink. nod permissions cannot override the operating system. If the path is in a protected folder such as Desktop, Documents, or Downloads, ask the user to grant the terminal app Files and Folders or Full Disk Access. Otherwise, ask the user to correct OS filesystem permissions or move/copy the project to an accessible location."
      : "Do not retry this path unchanged or propose a symlink. nod permissions cannot override the operating system. Ask the user to correct OS filesystem permissions or move/copy the project to an accessible location.";
  return toolExecutionFailed(tool, "Operating system denied filesystem access", {
    details: { path, error: err },
    suggestion,
  });
}

const isNetworkTool = (tool: string) => tool === "web_search";

function deniedMessage(tool: string, reason: DenialReason): string {
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
      return isNetworkTool(tool)
        ? "Network or browser access was denied by configured policy"
        : "Tool access was denied by configured policy";
    case "permission_required":
      if (tool === "shell") return "Shell command approval is required before this tool can run";
      return isNetworkTool(tool)
        ? "Network or browser approval is required before this tool can run"
        : "Tool approval is required before this tool can run";
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
      return "The tool did not run. Noninteractive mode cannot show an approval prompt. Rerun interactively to approve, or configure a narrow permission rule before retrying.";
  }
}

export function permissionDenied(
  tool: string,
  reason: Extract<DenialReason, "user_denied" | "auto_denied" | "policy_denied" | "permission_required">,
): string {
  return JSON.stringify({
    error: {
      type: "tool_permission_denied",
      tool_name: tool,
      message: deniedMessage(tool, reason),
      reason,
      denied: true,
      suggestion: deniedSuggestion(reason),
    },
  });
}

export function reviewHeld(
  tool: string,
  reason: Extract<DenialReason, "review_caution" | "review_evidence_incomplete" | "review_unavailable">,
  advice?: string,
  cause?: string,
): string {
  const error: Record<string, unknown> = {
    type: "tool_review_held",
    tool_name: tool,
    message: deniedMessage(tool, reason),
    reason,
  };
  if (cause) error.review_cause = cause;
  error.held = true;
  if (advice) error.advice = advice;
  error.suggestion = deniedSuggestion(reason);
  return JSON.stringify({ error });
}

/** True for the structured error envelopes above. */
export function isToolOutputError(text: string): boolean {
  return /^\s*\{"error":/.test(text);
}
