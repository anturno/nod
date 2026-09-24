#!/usr/bin/env bun
/**
 * Runs the eval tasks against a real model and reports effectiveness (did the check pass) and efficiency (steps,
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
import { assembleRuntime, type ModelBinding } from "../src/cli/runtime.ts";
import type { LLM } from "../src/core/agent/types.ts";
import { loadConfig } from "../src/core/config/resolve.ts";
import { resolveAccess } from "../src/core/workspace/access.ts";
import { isSubscription, pickModel, type Subscription } from "../src/providers/providers.ts";
import { type Exec, TASKS, type Task } from "./tasks.ts";

export type Result = {
  task: string;
  pass: boolean;
  reason: "completed" | "interrupted" | "paused" | "failed" | "error";
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

export async function exec(cwd: string, command: string): Promise<{ output: string; exitCode: number | null }> {
  const proc = Bun.spawn(["bash", "-c", command], { cwd, stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  return { output: (out + err).trim(), exitCode: await proc.exited };
}

/** A fresh directory holding the task's files. */
export async function workspace(task: Task): Promise<{ cwd: string; exec: Exec; dispose: () => Promise<void> }> {
  const cwd = await mkdtemp(join(tmpdir(), `nod-eval-${task.name}-`));
  await Promise.all(Object.entries(task.files).map(([path, content]) => Bun.write(join(cwd, path), content)));
  return { cwd, exec: (command) => exec(cwd, command), dispose: () => rm(cwd, { recursive: true, force: true }) };
}

/** A subscription whose only model is the given LLM: what tests and the runner hand to the runtime. */
export const binding = (llm: LLM, model = "eval-model"): ModelBinding => {
  const sub: Subscription = {
    label: "eval",
    login: async () => {},
    logout: async () => "",
    signedIn: () => true,
    models: async () => [model],
    llm: () => llm,
  };
  return { provider: "codex", model, sub, listed: [model] };
};

export async function runTask(task: Task, model: ModelBinding, maxSteps = 20): Promise<Result> {
  const ws = await workspace(task);
  const home = await mkdtemp(join(tmpdir(), "nod-eval-home-"));
  try {
    let turns = 0;
    let context = 0;
    let answer = "";
    const inner = model.sub.llm(model.model);
    // Each request starts a new line of the answer, so two replies do not run together.
    const counted: LLM = {
      stream: (messages, tools, signal, options) => {
        turns++;
        answer += "\n";
        context = messages.reduce((n, m) => n + m.content.length, 0);
        return inner.stream(messages, tools, signal, options);
      },
    };
    const config = loadConfig({
      workspaceRoot: ws.cwd,
      env: { NOD_HOME: home, NOD_MAX_AGENT_STEPS: String(maxSteps) },
    });
    // No approval: the workspace is a throwaway directory.
    const runtime = await assembleRuntime(
      {
        config,
        access: resolveAccess({ cwd: ws.cwd }, []),
        sessionId: "eval",
        sessionDir: join(home, "session"),
        history: [],
        interactive: false,
        permissionMode: "yolo",
      },
      { ...model, sub: { ...model.sub, llm: () => counted } },
    );
    const started = performance.now();
    let commands = 0;
    let failedCommands = 0;
    let reason: Result["reason"] = "error";
    try {
      const gen = runtime.loop.run({ text: task.prompt });
      for (;;) {
        const next = await gen.next();
        if (next.done) {
          reason = next.value.kind;
          if (next.value.kind === "failed") answer += `\n${next.value.error}`;
          break;
        }
        const ev = next.value;
        if (ev.type === "text") answer += ev.text;
        if (ev.type === "tool_started" && ev.call.name === "shell") commands++;
        if (ev.type === "tool_finished" && ev.call.name === "shell" && ev.result.status !== "success") failedCommands++;
      }
    } catch (e) {
      answer += `\n${(e as Error).message}`;
    } finally {
      await runtime.close();
    }
    const seconds = (performance.now() - started) / 1000;
    answer = answer.trim();
    const pass = reason !== "error" && (await task.check({ exec: ws.exec, answer }));
    return { task: task.name, pass, reason, turns, commands, failedCommands, seconds, context, answer };
  } finally {
    await ws.dispose();
    await rm(home, { recursive: true, force: true });
  }
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length === 0 ? 0 : (s[(s.length - 1) >> 1] as number);
};

/** One line per task: pass rate and median efficiency across its runs. */
export function summarize(results: Result[]): string {
  const byTask = new Map<string, Result[]>();
  for (const r of results) byTask.set(r.task, [...(byTask.get(r.task) ?? []), r]);
  const rows = [...byTask].map(([task, rs]) => {
    const passed = rs.filter((r) => r.pass).length;
    return [
      task.padEnd(16),
      `${passed}/${rs.length}`.padStart(5),
      `${median(rs.map((r) => r.turns))} turns`.padStart(9),
      `${median(rs.map((r) => r.commands))} cmds`.padStart(8),
      `${median(rs.map((r) => r.failedCommands))} failed`.padStart(9),
      `${median(rs.map((r) => r.seconds)).toFixed(0)}s`.padStart(5),
      `${median(rs.map((r) => r.context))} chars`.padStart(12),
    ].join("  ");
  });
  const total = results.filter((r) => r.pass).length;
  return [...rows, `total ${total}/${results.length}`].join("\n");
}

if (import.meta.main) {
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2),
    options: {
      repeat: { type: "string", default: "1" },
      provider: { type: "string" },
      model: { type: "string" },
      concurrency: { type: "string", default: "1" },
    },
    allowPositionals: true,
  });
  if (values.provider !== undefined && !isSubscription(values.provider))
    throw new Error(`unknown provider ${values.provider}`);
  const picked = await pickModel(values.provider, values.model);
  const model: ModelBinding = { ...picked, listed: [picked.model] };
  const tasks = positionals.length ? TASKS.filter((t) => positionals.includes(t.name)) : TASKS;
  const queue = tasks.flatMap((t) => Array.from({ length: Number(values.repeat) }, () => t));
  const results: Result[] = [];
  const workers = Array.from({ length: Number(values.concurrency) }, async () => {
    for (let t = queue.shift(); t; t = queue.shift()) {
      const r = await runTask(t, model);
      results.push(r);
      console.log(`${r.pass ? "PASS" : "FAIL"} ${r.task} (${r.reason}, ${r.turns} turns, ${r.seconds.toFixed(0)}s)`);
    }
  });
  await Promise.all(workers);
  console.log(`\n${summarize(results)}`);
}
