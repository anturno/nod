/** The approval and ask_user_question panels as reducers over key actions, plus who owns the keyboard. */
import type { ApprovalDecision, ApprovalRequest } from "../../core/permissions/index.ts";
import type { KeyAction } from "./keys.ts";

// ---- approval -----------------------------------------------------------------------------------

export type ApprovalState = {
  id: number;
  request: ApprovalRequest;
  choice: 0 | 1 | 2;
  /** Amendment text while tab put option 1 or 3 into amend mode. */
  amend: string | null;
};

export const APPROVAL_HINT = "1–3 choose now    ↑↓ options    tab amend    enter confirm    esc cancel";
export const APPROVAL_SCREEN_HINT =
  "1–3 choose now    ↑↓ options    tab amend    wheel scroll    enter confirm    esc cancel";
export const CONFIRM_HINT = "1–2 choose    enter confirm    esc cancel";

export function approvalQuestion(r: ApprovalRequest): string {
  if (r.kind === "mcp") return "Allow this MCP tool call?";
  if (r.kind === "command") return "Would you like to run the following command?";
  if (r.toolName === "write_file") return "Would you like to create or update this file?";
  if (r.toolName === "edit_file") return "Would you like to edit this file?";
  if (r.toolName === "skill") return "Would you like to run this skill?";
  if (r.toolName === "subagent") return "Would you like to start this subagent task?";
  if (r.kind === "confirm") return r.detail ?? r.label;
  return "Would you like to allow this action?";
}

export function approvalOptions(s: ApprovalState): string[] {
  const r = s.request;
  if (r.kind === "confirm") return ["1. Confirm", "2. Cancel"];
  const always =
    r.kind === "mcp"
      ? "2. Allow this MCP tool for this session"
      : r.kind === "command"
        ? "2. Yes, and don't ask again for this exact command"
        : "2. Yes, and don't ask again for this request";
  const yes = s.amend !== null && s.choice === 0 ? "1. Yes, and tell nod what to do next" : "1. Yes";
  const no = s.amend !== null && s.choice === 2 ? "3. No, and tell nod what to do differently" : "3. No";
  return [yes, always, no];
}

export const amendPlaceholder = (choice: 0 | 1 | 2) =>
  choice === 0 ? "and tell nod what to do next" : choice === 2 ? "and tell nod what to do differently" : "";

export const createApproval = (id: number, request: ApprovalRequest): ApprovalState => ({
  id,
  request,
  choice: 0,
  amend: null,
});

const OUTCOMES: ApprovalDecision["outcome"][] = ["once", "always", "deny"];

function decide(s: ApprovalState, choice: 0 | 1 | 2): ApprovalDecision {
  if (s.request.kind === "confirm") return { outcome: choice === 0 ? "once" : "deny" };
  const note = s.amend?.trim();
  return { outcome: OUTCOMES[choice] as ApprovalDecision["outcome"], ...(note ? { note } : {}) };
}

export type ApprovalStep = { state: ApprovalState; done?: ApprovalDecision | "cancel" };

export function reduceApproval(s: ApprovalState, key: KeyAction): ApprovalStep {
  const max = s.request.kind === "confirm" ? 1 : 2;
  switch (key.type) {
    case "insert": {
      if (s.amend !== null) return { state: { ...s, amend: s.amend + key.text } };
      const n = Number(key.text);
      if (key.text.length === 1 && n >= 1 && n <= max + 1) return { state: s, done: decide(s, (n - 1) as 0 | 1 | 2) };
      return { state: s };
    }
    case "delete":
      return s.amend !== null ? { state: { ...s, amend: s.amend.slice(0, -1) } } : { state: s };
    case "move":
      if (key.kind === "up") return { state: { ...s, choice: Math.max(0, s.choice - 1) as 0 | 1 | 2, amend: null } };
      if (key.kind === "down")
        return { state: { ...s, choice: Math.min(max, s.choice + 1) as 0 | 1 | 2, amend: null } };
      return { state: s };
    case "tab":
      if (s.request.kind === "confirm") return { state: { ...s, choice: s.choice === 0 ? 1 : 0 } };
      if (s.choice === 1) return { state: { ...s, choice: 2 } };
      return { state: { ...s, amend: s.amend === null ? "" : null } };
    case "submit":
      return { state: s, done: decide(s, s.choice) };
    case "escape":
      return s.amend !== null ? { state: { ...s, amend: null } } : { state: s, done: "cancel" };
    default:
      return { state: s };
  }
}

// ---- ask_user_question --------------------------------------------------------------------------

export type Question = { question: string; options: { label: string; description?: string }[] };
export type QuestionState = {
  questions: Question[];
  index: number;
  /** options.length is the freeform "Other" slot. */
  choice: number;
  answers: string[];
  freeform: string;
};

export const QUESTION_HINT = "Use numbers, Up/Down, or tab to choose, enter to confirm, esc to cancel";
export const questionProgress = (s: QuestionState) => `question ${s.index + 1}/${s.questions.length}`;
export const createQuestions = (questions: Question[]): QuestionState => ({
  questions,
  index: 0,
  choice: 0,
  answers: [],
  freeform: "",
});

export type QuestionStep = { state: QuestionState; done?: { answers: string[] } | "cancel" };

export function reduceQuestion(s: QuestionState, key: KeyAction): QuestionStep {
  const q = s.questions[s.index];
  if (!q) return { state: s, done: "cancel" };
  const other = q.options.length;
  switch (key.type) {
    case "insert": {
      const n = Number(key.text);
      if (key.text.length === 1 && n >= 1 && n <= other + 1 && s.choice !== other)
        return { state: { ...s, choice: n - 1 } };
      if (s.choice === other) return { state: { ...s, freeform: s.freeform + key.text } };
      if (key.text.length === 1 && n >= 1 && n <= other + 1) return { state: { ...s, choice: n - 1 } };
      return { state: { ...s, choice: other, freeform: s.freeform + key.text } };
    }
    case "paste":
      return { state: { ...s, choice: other, freeform: s.freeform + key.text } };
    case "delete":
      return s.choice === other ? { state: { ...s, freeform: s.freeform.slice(0, -1) } } : { state: s };
    case "move":
      if (key.kind === "up") return { state: { ...s, choice: Math.max(0, s.choice - 1) } };
      if (key.kind === "down") return { state: { ...s, choice: Math.min(other, s.choice + 1) } };
      return { state: s };
    case "tab":
      return { state: { ...s, choice: (s.choice + 1) % (other + 1) } };
    case "submit": {
      const answer = s.choice === other ? s.freeform.trim() : (q.options[s.choice]?.label ?? "");
      if (!answer) return { state: s };
      const answers = [...s.answers, answer];
      if (s.index + 1 >= s.questions.length) return { state: { ...s, answers }, done: { answers } };
      return { state: { ...s, answers, index: s.index + 1, choice: 0, freeform: "" } };
    }
    case "escape":
      return { state: s, done: "cancel" };
    default:
      return { state: s };
  }
}

// ---- keyboard ownership -------------------------------------------------------------------------

export type Owner = "screen" | "approval" | "question" | "menu" | "composer";

/** ctrl+o screen → approval → question → picker/menu (unhandled keys fall through to the composer) → composer. */
export function keyboardOwner(has: { screen: boolean; approval: boolean; question: boolean; menu: boolean }): Owner {
  if (has.screen) return "screen";
  if (has.approval) return "approval";
  if (has.question) return "question";
  if (has.menu) return "menu";
  return "composer";
}
