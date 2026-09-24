/** ask_user_question: 1-4 multiple-choice questions answered through the host's prompt. */
import { isRecord, ok } from "./args.ts";
import type { DecodeResult, ToolContext, ToolResult } from "./spec.ts";

export type Input = { args: unknown };
export type Question = { question: string; options: { label: string; description?: string }[] };

export const CANCEL_SENTINEL = "(user cancelled the question)";
export const NOT_AVAILABLE_SENTINEL =
  "(ask_user_question is only available in the interactive shell; ask the user freeform instead)";
const INVALID_ARGS_SENTINEL = "(ask_user_question: invalid arguments; provide {questions})";

/** Parsing happens in call so every sentinel reaches the model as a successful output. */
export const decode = (args: unknown): DecodeResult<Input> => ok({ args });

// biome-ignore lint/suspicious/noControlCharactersInRegex: escapes C0/DEL bytes for terminal safety
const controlChars = /[\x00-\x1f\x7f]/g;
const terminalSafe = (text: string) =>
  text.replace(controlChars, (c) => `\\x${c.charCodeAt(0).toString(16).padStart(2, "0")}`);

export function parseQuestions(args: unknown): Question[] | string {
  if (!isRecord(args)) return INVALID_ARGS_SENTINEL;
  if (!("questions" in args)) return '(ask_user_question: missing required array "questions")';
  const questions = args.questions;
  if (!Array.isArray(questions)) return '(ask_user_question: "questions" must be an array)';
  if (questions.length < 1 || questions.length > 4) return "(ask_user_question: provide 1 to 4 questions)";
  const entries: Question[] = [];
  for (const item of questions) {
    if (!isRecord(item)) return '(ask_user_question: each question must be an object with a "question" and "options")';
    if (!("question" in item)) return '(ask_user_question: each question requires a "question" string)';
    if (typeof item.question !== "string") return '(ask_user_question: question "question" must be a string)';
    const question = item.question.trim();
    if (question.length === 0) return "(ask_user_question: question text must not be empty)";
    if (!("options" in item)) return '(ask_user_question: each question requires an "options" array)';
    if (!Array.isArray(item.options)) return '(ask_user_question: "options" must be an array)';
    if (item.options.length < 2 || item.options.length > 6)
      return "(ask_user_question: provide 2 to 6 options per question)";
    const options: Question["options"] = [];
    for (const option of item.options) {
      if (!isRecord(option)) return '(ask_user_question: each option must be an object with a "label")';
      if (!("label" in option)) return '(ask_user_question: each option requires a "label" string)';
      if (typeof option.label !== "string") return '(ask_user_question: option "label" must be a string)';
      const label = terminalSafe(option.label.trim());
      if (label.length === 0) return "(ask_user_question: option labels must not be empty)";
      if (options.some((o) => o.label.toLowerCase() === label.toLowerCase())) {
        return "(ask_user_question: option labels must be unique within a question)";
      }
      const description = typeof option.description === "string" ? terminalSafe(option.description.trim()) : "";
      options.push(description ? { label, description } : { label });
    }
    entries.push({ question: terminalSafe(question), options });
  }
  return entries;
}

export async function call(input: Input, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.askUser) return { status: "success", output: NOT_AVAILABLE_SENTINEL };
  const parsed = parseQuestions(input.args);
  if (typeof parsed === "string") return { status: "success", output: parsed };
  let answered: Awaited<ReturnType<NonNullable<ToolContext["askUser"]>>>;
  try {
    answered = await ctx.askUser(parsed, ctx.signal);
  } catch (err) {
    return {
      status: "failure",
      output: `ask_user_question failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  if (answered === null) return { status: "success", output: CANCEL_SENTINEL, cancelTurn: true };
  const answers = parsed.map((q, i) => ({ question: q.question, answer: answered.answers[i]?.answer ?? "" }));
  return { status: "success", output: JSON.stringify(answers) };
}

export const readsOnly = (): boolean => true;
export const label = (): string => "ask_user_question";
