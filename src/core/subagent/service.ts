/** Child agents: `run` on a fresh history, `message` on a named child that keeps its history between messages. */
import type { AgentEvent, TurnOutcome } from "../agent/loop.ts";
import type { HistoryTurn, UserTurn } from "../agent/types.ts";
import type { SubagentOptions, SubagentOutcome, SubagentService } from "./types.ts";

export const AGENT_NAME = /^[a-z][a-z0-9_-]{0,63}$/;

/** What the service needs from an AgentLoop; the class satisfies it structurally. */
export type ChildLoop = {
  state: { history: HistoryTurn[] };
  run(prompt: UserTurn, signal?: AbortSignal): AsyncGenerator<AgentEvent, TurnOutcome>;
};
export type ChildAgent = { loop: ChildLoop; close(): void | Promise<void> };
export type ChildOptions = { model?: string; effort?: string; history: HistoryTurn[] };
/** Throw this from `createChild` when a model/effort override cannot be honored. */
export class OverrideRejected extends Error {}

type Named = { agent: ChildAgent; model?: string; effort?: string; instructions?: string; busy: boolean };

async function runTurn(loop: ChildLoop, text: string, signal?: AbortSignal): Promise<SubagentOutcome> {
  const toolCalls: { name: string; status: string }[] = [];
  const gen = loop.run({ text }, signal);
  let next = await gen.next();
  while (!next.done) {
    if (next.value.type === "tool_finished")
      toolCalls.push({ name: next.value.call.name, status: next.value.result.status });
    next = await gen.next();
  }
  const outcome = next.value;
  loop.state.history.push(outcome.turn);
  if (outcome.kind === "completed") return { ok: true, result: outcome.text, toolCalls };
  if (outcome.kind === "failed") return { ok: false, error_code: "agent_failed", message: outcome.error };
  if (outcome.kind === "paused") return { ok: false, error_code: "agent_paused", message: outcome.reason };
  return { ok: false, error_code: "interrupted" };
}

const rejected = (err: unknown): SubagentOutcome => {
  if (err instanceof OverrideRejected) return { ok: false, error_code: "override_rejected", message: err.message };
  throw err;
};

export function createSubagentService(deps: {
  createChild(opts: ChildOptions): ChildAgent | Promise<ChildAgent>;
}): SubagentService & { close(): Promise<void> } {
  const named = new Map<string, Named>();
  return {
    async run(task, opts, signal) {
      let child: ChildAgent;
      try {
        child = await deps.createChild({ model: opts.model, effort: opts.effort, history: [] });
      } catch (err) {
        return rejected(err);
      }
      try {
        return await runTurn(child.loop, opts.instructions ? `${opts.instructions}\n\n${task}` : task, signal);
      } finally {
        await child.close();
      }
    },
    async message(agent, message, opts: SubagentOptions, signal) {
      if (!AGENT_NAME.test(agent)) return { ok: false, error_code: "invalid_agent" };
      let entry = named.get(agent);
      if (!entry) {
        try {
          const created = await deps.createChild({ model: opts.model, effort: opts.effort, history: [] });
          entry = { agent: created, model: opts.model, effort: opts.effort, busy: false };
        } catch (err) {
          return rejected(err);
        }
        named.set(agent, entry);
      } else if ((opts.model && opts.model !== entry.model) || (opts.effort && opts.effort !== entry.effort)) {
        return { ok: false, error_code: "override_rejected", message: "a named agent keeps its model and effort" };
      }
      // ponytail: fx queues steering for a busy child; nod reports agent_busy and lets the caller retry.
      if (entry.busy) return { ok: false, error_code: "agent_busy" };
      if (opts.instructions) entry.instructions = opts.instructions;
      entry.busy = true;
      try {
        const text = entry.instructions ? `${entry.instructions}\n\n${message}` : message;
        return await runTurn(entry.agent.loop, text, signal);
      } finally {
        entry.busy = false;
      }
    },
    async close() {
      for (const entry of named.values()) await entry.agent.close();
      named.clear();
    },
  };
}
