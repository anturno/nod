/** Public API of the permission engine. */
import type { PermissionMode } from "../agent/types.ts";

export {
  type ApprovalReason,
  type CommandClass,
  classifyCommand,
  isStaticCommand,
  knownReversibleAutoCommand,
} from "./commands.ts";
export {
  type ApprovalDecision,
  type ApprovalRequest,
  type DecisionInput,
  decidePermission,
  displayPath,
  MAX_REVIEWS_PER_TURN,
  type Outcome,
  type Prompter,
  permissionDeniedJson,
  type ReviewBudget,
  sensitiveAutoWriteTarget,
} from "./decide.ts";
export { type Grant, grantAllows, grantsAllowAll, grantTarget, pathInside, suggestedGrants } from "./grants.ts";
export {
  buildReviewMessages,
  createReviewer,
  DEFAULT_REVIEW_TIMEOUT_MS,
  type NormalizedAction,
  parseReviewCompletion,
  REVIEW_POLICY_TEMPLATE,
  REVIEW_TOOL,
  type Reviewer,
  type ReviewerDeps,
  type ReviewInput,
  type ReviewInvalidReason,
  type ReviewResult,
  reviewerModel,
} from "./reviewer.ts";
export {
  canonicalDomain,
  canonicalHost,
  describePermissions,
  directoryTreeMatch,
  effectiveRules,
  formatPermissions,
  type PermissionsSnapshot,
  parseRules,
  permissionName,
  type Rule,
  type RuleAction,
  type RuleDecision,
  ruleDecision,
  rulesDenyAllTargets,
  staticCommandWildcardMatch,
  wildcardMatch,
} from "./rules.ts";

/** "ask" | "auto" | "full-access" | "full access" | "yolo" (case-insensitive) → PermissionMode. */
export function parsePermissionModeInput(raw: string): PermissionMode | null {
  const lower = raw.trim().toLowerCase();
  if (lower === "ask" || lower === "auto") return lower;
  if (lower === "full-access" || lower === "full access" || lower === "yolo") return "yolo";
  return null;
}

/** Human-readable mode; "yolo" stays the persisted and wire value. */
export function displayPermissionMode(mode: PermissionMode): string {
  return mode === "yolo" ? "full access" : mode;
}
