import { expect, test } from "bun:test";
import { runTask, summarize, workspace } from "../evals/run.ts";
import { TASKS } from "../evals/tasks.ts";
import type { LLM } from "../src/agent.ts";

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
  const replies = [
    { content: "", toolCalls: [{ id: "a", name: "bash", arguments: '{"command":"false"}' }] },
    {
      content: "",
      toolCalls: [{ id: "b", name: "bash", arguments: JSON.stringify({ command: task.reference.command }) }],
    },
    { content: "", toolCalls: [{ id: "c", name: "task_complete", arguments: '{"summary":"Fixed."}' }] },
  ];
  const llm: LLM = {
    async *stream() {
      return replies.shift()!;
    },
  };

  const result = await runTask(task, llm);

  expect(result).toMatchObject({
    task: "fix-bug",
    pass: true,
    reason: "task_complete",
    turns: 3,
    commands: 2,
    failedCommands: 1,
  });
  expect(summarize([result, { ...result, pass: false, turns: 5 }]).at(-1)).toMatchObject({
    task: "all",
    pass: "1/2",
    turns: 4,
  });
});
