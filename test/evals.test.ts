import { expect, test } from "bun:test";
import { binding, runTask, summarize, workspace } from "../evals/run.ts";
import { TASKS } from "../evals/tasks.ts";
import type { LLM } from "../src/core/agent/types.ts";

for (const task of TASKS) {
  test(`eval ${task.name}: the check fails on the fixture and passes with the reference solution`, async () => {
    const ws = await workspace(task);
    try {
      expect(await task.check({ exec: ws.exec, answer: "" })).toBe(false);
      if (task.reference.command) expect((await ws.exec(task.reference.command)).exitCode).toBe(0);
      expect(await task.check({ exec: ws.exec, answer: task.reference.answer ?? "" })).toBe(true);
    } finally {
      await ws.dispose();
    }
  });
}

test("runTask counts turns, commands and failures, and grades the finished workspace", async () => {
  const task = TASKS.find((t) => t.name === "fix-bug")!;
  const shell = (command: string) => JSON.stringify({ request: { action: "run", command } });
  const replies = [
    { content: "", toolCalls: [{ id: "a", name: "shell", arguments: shell("false") }] },
    { content: "", toolCalls: [{ id: "b", name: "shell", arguments: shell(task.reference.command!) }] },
    { content: "Fixed.", toolCalls: [] },
  ];
  const llm: LLM = {
    async *stream() {
      return replies.shift()!;
    },
  };

  const result = await runTask(task, binding(llm));

  expect(result).toMatchObject({
    task: "fix-bug",
    pass: true,
    reason: "completed",
    turns: 3,
    commands: 2,
    failedCommands: 1,
  });
  expect(result.answer).toBe("Fixed.");
  expect(summarize([result])).toContain("fix-bug");
});
