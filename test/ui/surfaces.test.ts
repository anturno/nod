import { expect, test } from "bun:test";
import type { ApprovalRequest } from "../../src/core/permissions/index.ts";
import type { KeyAction } from "../../src/ui/core/keys.ts";
import {
  APPROVAL_HINT,
  amendPlaceholder,
  approvalOptions,
  approvalQuestion,
  createApproval,
  createQuestions,
  keyboardOwner,
  QUESTION_HINT,
  questionProgress,
  reduceApproval,
  reduceQuestion,
} from "../../src/ui/core/surfaces.ts";

const request = (kind: ApprovalRequest["kind"], toolName = "shell", label = "shell.run rm x"): ApprovalRequest => ({
  toolName,
  label,
  kind,
  targets: [],
  suggestedGrants: [],
});
const key = (text: string): KeyAction => ({ type: "insert", text });
const type = (s: ReturnType<typeof createApproval>, text: string) =>
  [...text].reduce((acc, ch) => reduceApproval(acc, key(ch)).state, s);

test("questions and options per request kind", () => {
  expect(approvalQuestion(request("command"))).toBe("Would you like to run the following command?");
  expect(approvalQuestion(request("file", "edit_file"))).toBe("Would you like to edit this file?");
  expect(approvalQuestion(request("file", "write_file"))).toBe("Would you like to create or update this file?");
  expect(approvalQuestion(request("mcp"))).toBe("Allow this MCP tool call?");
  expect(approvalQuestion(request("other", "web_fetch"))).toBe("Would you like to allow this action?");
  expect(approvalOptions(createApproval(1, request("command")))).toEqual([
    "1. Yes",
    "2. Yes, and don't ask again for this exact command",
    "3. No",
  ]);
  expect(approvalOptions(createApproval(1, request("file", "edit_file")))[1]).toBe(
    "2. Yes, and don't ask again for this request",
  );
  expect(approvalOptions(createApproval(1, request("mcp")))[1]).toBe("2. Allow this MCP tool for this session");
  expect(approvalOptions(createApproval(1, request("confirm")))).toEqual(["1. Confirm", "2. Cancel"]);
  expect(APPROVAL_HINT).toBe("1–3 choose now    ↑↓ options    tab amend    enter confirm    esc cancel");
});

test("digits choose now, arrows move, enter confirms, esc cancels", () => {
  const s = createApproval(1, request("command"));
  expect(reduceApproval(s, key("1")).done).toEqual({ outcome: "once" });
  expect(reduceApproval(s, key("2")).done).toEqual({ outcome: "always" });
  expect(reduceApproval(s, key("3")).done).toEqual({ outcome: "deny" });
  expect(reduceApproval(s, key("4")).done).toBeUndefined();
  const down = reduceApproval(reduceApproval(s, { type: "move", kind: "down" }).state, { type: "move", kind: "down" });
  expect(down.state.choice).toBe(2);
  expect(reduceApproval(down.state, { type: "submit" }).done).toEqual({ outcome: "deny" });
  expect(reduceApproval(s, { type: "escape" }).done).toBe("cancel");
  const confirm = createApproval(2, request("confirm"));
  expect(reduceApproval(confirm, key("2")).done).toEqual({ outcome: "deny" });
  expect(reduceApproval(confirm, key("3")).done).toBeUndefined();
});

test("tab amends option 1 or 3; the note travels with the decision", () => {
  let s = reduceApproval(createApproval(1, request("command")), { type: "tab" }).state;
  expect(s.amend).toBe("");
  expect(approvalOptions(s)[0]).toBe("1. Yes, and tell nod what to do next");
  expect(amendPlaceholder(0)).toBe("and tell nod what to do next");
  s = type(s, "use bun");
  expect(reduceApproval(s, { type: "submit" }).done).toEqual({ outcome: "once", note: "use bun" });
  const no = reduceApproval(reduceApproval({ ...s, amend: null, choice: 2 }, { type: "tab" }).state, key("x"));
  expect(approvalOptions(no.state)[2]).toBe("3. No, and tell nod what to do differently");
  expect(reduceApproval(no.state, { type: "submit" }).done).toEqual({ outcome: "deny", note: "x" });
  expect(reduceApproval(no.state, { type: "escape" }).state.amend).toBeNull();
  expect(reduceApproval({ ...s, choice: 1, amend: null }, { type: "tab" }).state.choice).toBe(2);
});

test("questions: numbers and tab choose, Other takes freeform text, esc cancels the batch", () => {
  const q = createQuestions([
    { question: "Which?", options: [{ label: "A", description: "first" }, { label: "B" }] },
    { question: "Sure?", options: [{ label: "Yes" }] },
  ]);
  expect(questionProgress(q)).toBe("question 1/2");
  expect(QUESTION_HINT).toBe("Use numbers, Up/Down, or tab to choose, enter to confirm, esc to cancel");
  const second = reduceQuestion(q, key("2"));
  expect(second.state.choice).toBe(1);
  const next = reduceQuestion(second.state, { type: "submit" });
  expect(next.done).toBeUndefined();
  expect(next.state).toMatchObject({ index: 1, choice: 0, answers: ["B"] });
  let other = reduceQuestion(next.state, { type: "tab" }).state;
  expect(other.choice).toBe(1);
  expect(reduceQuestion(other, { type: "submit" }).done).toBeUndefined();
  other = [..."maybe"].reduce((acc, ch) => reduceQuestion(acc, key(ch)).state, other);
  expect(reduceQuestion(other, { type: "submit" }).done).toEqual({ answers: ["B", "maybe"] });
  expect(reduceQuestion(q, { type: "escape" }).done).toBe("cancel");
  expect(reduceQuestion(reduceQuestion(q, { type: "tab" }).state, { type: "tab" }).state.choice).toBe(2);
});

test("keyboard ownership order", () => {
  expect(keyboardOwner({ screen: true, approval: true, question: true, menu: true })).toBe("screen");
  expect(keyboardOwner({ screen: false, approval: true, question: true, menu: true })).toBe("approval");
  expect(keyboardOwner({ screen: false, approval: false, question: true, menu: true })).toBe("question");
  expect(keyboardOwner({ screen: false, approval: false, question: false, menu: true })).toBe("menu");
  expect(keyboardOwner({ screen: false, approval: false, question: false, menu: false })).toBe("composer");
});
