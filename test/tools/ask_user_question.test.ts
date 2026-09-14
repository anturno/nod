import { describe, expect, test } from "bun:test";
import { CANCEL_SENTINEL, call, decode, NOT_AVAILABLE_SENTINEL } from "../../src/core/tools/ask_user_question.ts";
import type { AskUser } from "../../src/core/tools/spec.ts";
import { decodeOk, makeCtx, tempWorkspace } from "./helpers.ts";

const ws = tempWorkspace();
const firstOption: AskUser = async (questions) => ({
  answers: questions.map((q) => ({ question: q.question, answer: q.options[0]!.label })),
});
const run = (args: unknown, askUser?: AskUser) => call(decodeOk(decode(args)), makeCtx(ws, { askUser }));

describe("ask_user_question", () => {
  test("validation sentinels match", async () => {
    const cases: [unknown, string][] = [
      ["not-json", "(ask_user_question: invalid arguments; provide {questions})"],
      [[], "(ask_user_question: invalid arguments; provide {questions})"],
      [{}, '(ask_user_question: missing required array "questions")'],
      [{ questions: {} }, '(ask_user_question: "questions" must be an array)'],
      [{ questions: [] }, "(ask_user_question: provide 1 to 4 questions)"],
      [{ questions: [1] }, '(ask_user_question: each question must be an object with a "question" and "options")'],
      [{ questions: [{}] }, '(ask_user_question: each question requires a "question" string)'],
      [{ questions: [{ question: 1 }] }, '(ask_user_question: question "question" must be a string)'],
      [{ questions: [{ question: "  ", options: [] }] }, "(ask_user_question: question text must not be empty)"],
      [{ questions: [{ question: "Q?" }] }, '(ask_user_question: each question requires an "options" array)'],
      [{ questions: [{ question: "Q?", options: 1 }] }, '(ask_user_question: "options" must be an array)'],
      [{ questions: [{ question: "Q?", options: [] }] }, "(ask_user_question: provide 2 to 6 options per question)"],
      [
        { questions: [{ question: "Q?", options: [1, 2] }] },
        '(ask_user_question: each option must be an object with a "label")',
      ],
      [
        { questions: [{ question: "Q?", options: [{}, {}] }] },
        '(ask_user_question: each option requires a "label" string)',
      ],
      [
        { questions: [{ question: "Q?", options: [{ label: 1 }, { label: "No" }] }] },
        '(ask_user_question: option "label" must be a string)',
      ],
      [
        { questions: [{ question: "Q?", options: [{ label: "" }, { label: "No" }] }] },
        "(ask_user_question: option labels must not be empty)",
      ],
      [
        { questions: [{ question: "Q?", options: [{ label: "Yes" }, { label: " yes " }] }] },
        "(ask_user_question: option labels must be unique within a question)",
      ],
    ];
    for (const [args, expected] of cases)
      expect(await run(args, firstOption)).toEqual({ status: "success", output: expected });
  });

  test("answers are encoded in order with trimmed text", async () => {
    let seen: unknown;
    const spy: AskUser = async (questions) => {
      seen = questions;
      return firstOption(questions);
    };
    const result = await run(
      {
        questions: [
          {
            question: " Choose? ",
            options: [
              { label: " Yes ", description: " Go ahead " },
              { label: "No", description: 3 },
            ],
          },
        ],
      },
      spy,
    );
    expect(seen).toEqual([
      { question: "Choose?", options: [{ label: "Yes", description: "Go ahead" }, { label: "No" }] },
    ]);
    expect(result).toEqual({ status: "success", output: '[{"question":"Choose?","answer":"Yes"}]' });
  });

  test("model text is made terminal safe", async () => {
    const result = await run(
      {
        questions: [
          {
            question: "Q\n[31m?",
            options: [{ label: "Alpha\nFake", description: "Desc\tGap" }, { label: "[31mRed[0m" }],
          },
        ],
      },
      firstOption,
    );
    expect(result.output).toBe('[{"question":"Q\\\\x0a\\\\x1b[31m?","answer":"Alpha\\\\x0aFake"}]');
  });

  test("cancellation stops the turn and noninteractive hosts get the sentinel", async () => {
    const valid = { questions: [{ question: "Q?", options: [{ label: "Yes" }, { label: "No" }] }] };
    expect(await run(valid, async () => null)).toEqual({
      status: "success",
      output: CANCEL_SENTINEL,
      cancelTurn: true,
    });
    expect(await run("not-json")).toEqual({ status: "success", output: NOT_AVAILABLE_SENTINEL });
  });
});
