#!/usr/bin/env bun
/**
 * Runs the eval tasks against a real model and reports effectiveness (did the check pass) and efficiency (turns,
 * commands, failed commands, time, and the context the conversation grew to).
 *
 *   bun run eval                           every task once, on the default model
 *   bun run eval -- --repeat 3 fix-bug     one task, three times
 *   bun run eval -- --provider grok --model <id> --concurrency 2
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { Agent, type DoneReason, type LLM, systemPrompt } from "../src/agent.ts";
import { localEnvironment } from "../src/environment.ts";
import { pickModel } from "../src/providers.ts";
import { type Exec, TASKS, type Task } from "./tasks.ts";

export type Result = {
  task: string;
  pass: boolean;
  reason: DoneReason | "error";
  /** Model requests. */
  turns: number;
  commands: number;
  failedCommands: number;
  seconds: number;
  /** Characters of conversation at the end: a provider-neutral proxy for tokens. */
  context: number;
  /** Everything the agent said, as the user saw it, or the error. */
  answer: string;
};

/** A fresh directory holding the task's files. */
export async function workspace(task: Task): Promise<{ cwd: string; exec: Exec; dispose: () => Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), `nod-eval-${task.name}-`));
  await Promise.all(Object.entries(task.files).map(([path, content]) => Bun.write(join(cwd, path), content)));
  const env = localEnvironment({ cwd });
  return { cwd, exec: (command) => env.execute(command), dispose: () => rm(cwd, { recursive: true, force: true }) };
}

export async function runTask(task: Task, llm: LLM, maxTurns = 20): Promise<Result> {
  const ws = await workspace(task);
  try {
    let turns = 0;
    let answer = "";
    // Each request starts a new line of the answer, so two replies do not run together.
    const counted: LLM = {
      stream: (messages, tools, signal) => (turns++, (answer += "\n"), llm.stream(messages, tools, signal)),
    };
    // No approval: the workspace is a throwaway directory.
    const agent = new Agent({
      llm: counted,
      env: localEnvironment({ cwd: ws.cwd }),
      system: systemPrompt(process.platform),
      maxTurns,
    });
    const started = performance.now();
    let commands = 0;
    let failedCommands = 0;
    let reason: Result["reason"] = "error";
    try {
      for await (const event of agent.run(task.prompt)) {
        // Graded on everything shown: a task_complete summary can follow, and replace, a plain answer.
        if (event.type === "text") answer += event.text;
        if (event.type === "done" && event.reason !== "answered") answer += `\n${event.message}`;
        if (event.type === "command") commands++;
        if (event.type === "observation" && !event.output.startsWith("exit code 0")) failedCommands++;
        if (event.type === "done") reason = event.reason;
      }
    } catch (e) {
      answer += `\n${(e as Error).message}`;
    }
    const seconds = (performance.now() - started) / 1000;
    answer = answer.trim();
    const pass = reason !== "error" && (await task.check({ exec: ws.exec, answer }));
    return {
      task: task.name,
      pass,
      reason,
      turns,
      commands,
      failedCommands,
      seconds,
      context: JSON.stringify(agent.messages).length,
      answer,
    };
  } finally {
    await ws.dispose();
  }
}

const median = (xs: number[]) => {
  const sorted = xs.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
};

/** Medians per task, so one slow run does not hide the typical one. */
export function summarize(results: Result[]) {
  const row = (name: string, runs: Result[]) => ({
    task: name,
    pass: `${runs.filter((r) => r.pass).length}/${runs.length}`,
    turns: median(runs.map((r) => r.turns)),
    commands: median(runs.map((r) => r.commands)),
    failed: median(runs.map((r) => r.failedCommands)),
    seconds: Number(median(runs.map((r) => r.seconds)).toFixed(1)),
    "context kB": Number((median(runs.map((r) => r.context)) / 1000).toFixed(1)),
  });
  const names = [...new Set(results.map((r) => r.task))];
  return [
    ...names.map((name) =>
      row(
        name,
        results.filter((r) => r.task === name),
      ),
    ),
    row("all", results),
  ];
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      provider: { type: "string" },
      model: { type: "string" },
      repeat: { type: "string", default: "1" },
      concurrency: { type: "string", default: "4" },
    },
  });
  const tasks = positionals.length ? TASKS.filter((t) => positionals.includes(t.name)) : TASKS;
  if (!tasks.length)
    throw new Error(`No task named ${positionals.join(", ")}. Tasks: ${TASKS.map((t) => t.name).join(", ")}`);
  const { provider, model, sub } = await pickModel(values.provider, values.model);
  const queue = tasks.flatMap((task) => Array.from({ length: Number(values.repeat) }, () => task));
  console.log(`${provider}/${model} · ${queue.length} runs\n`);

  const results: Result[] = [];
  const worker = async () => {
    // One LLM per run, so concurrent runs never share a provider session.
    for (let task = queue.shift(); task; task = queue.shift()) {
      const r = await runTask(task, sub.llm(model));
      results.push(r);
      console.log(
        `${r.pass ? "✓" : "✗"} ${r.task.padEnd(12)} ${r.reason.padEnd(13)} ${r.turns} turns · ${r.commands} cmds · ${r.seconds.toFixed(1)}s`,
      );
      if (!r.pass) console.log(`  ⎿ ${r.answer.replaceAll("\n", " ").slice(0, 200)}`);
    }
  };
  await Promise.all(Array.from({ length: Number(values.concurrency) }, worker));

  console.log();
  console.table(
    summarize(
      results.toSorted((a, b) => TASKS.findIndex((t) => t.name === a.task) - TASKS.findIndex((t) => t.name === b.task)),
    ),
  );
  if (results.some((r) => !r.pass)) process.exitCode = 1;
}
