import { describe, expect, test } from "bun:test";
import type { AgentEvent, TurnOutcome } from "../../src/core/agent/loop.ts";
import type { HistoryTurn, UserTurn } from "../../src/core/agent/types.ts";
import {
  type ChildLoop,
  type ChildOptions,
  createSubagentService,
  OverrideRejected,
} from "../../src/core/subagent/service.ts";
import { call, decode } from "../../src/core/tools/subagent.ts";
import { decodeOk, makeCtx, tempWorkspace } from "../tools/helpers.ts";

type Fake = { created: ChildOptions[]; closed: number; prompts: string[]; release?: () => void };

function fakeChild(fake: Fake, kind: TurnOutcome["kind"] = "completed") {
  return (opts: ChildOptions) => {
    if (opts.model === "nope") throw new OverrideRejected("model nope is not listed");
    fake.created.push(opts);
    const loop: ChildLoop = {
      state: { history: opts.history },
      async *run(prompt: UserTurn): AsyncGenerator<AgentEvent, TurnOutcome> {
        fake.prompts.push(prompt.text);
        if (fake.release === undefined) await new Promise<void>((r) => (fake.release = r));
        else await new Promise<void>((r) => (fake.release = r));
        const call = { id: "c1", name: "read_file", arguments: "{}" };
        yield {
          type: "tool_finished",
          call,
          label: "read_file",
          spec: {} as never,
          result: { status: "success", output: "" },
        };
        const turn: HistoryTurn = {
          kind: "assistant",
          user: prompt,
          assistant: "done",
          execution: { steps: [], steering: [] },
        };
        if (kind === "failed") return { kind, turn, error: "boom", steps: 1 };
        if (kind === "paused") return { kind, turn, reason: "rate limited", steps: 1 };
        if (kind === "interrupted") return { kind, turn, steps: 1 };
        return { kind: "completed", turn, text: `echo:${prompt.text}`, steps: 1 };
      },
    };
    return { loop, close: () => void fake.closed++ };
  };
}

const settle = () => new Promise((r) => setTimeout(r, 0));
const finish = async (fake: Fake) => {
  await settle();
  fake.release?.();
  fake.release = undefined;
};

describe("subagent service", () => {
  test("run uses a fresh child per task and reports tool calls", async () => {
    const fake: Fake = { created: [], closed: 0, prompts: [] };
    const service = createSubagentService({ createChild: fakeChild(fake) });
    const pending = service.run("review", { model: "m", effort: "high", instructions: "Be strict." });
    await finish(fake);
    expect(await pending).toEqual({
      ok: true,
      result: "echo:Be strict.\n\nreview",
      toolCalls: [{ name: "read_file", status: "success" }],
    });
    expect(fake.created).toMatchObject([{ model: "m", effort: "high" }]);
    expect(fake.created[0]?.history).toHaveLength(1);
    expect(fake.closed).toBe(1);
    expect(await service.run("x", { model: "nope" })).toEqual({
      ok: false,
      error_code: "override_rejected",
      message: "model nope is not listed",
    });
  });

  test("message keeps a named child's history, rejects busy and overrides", async () => {
    const fake: Fake = { created: [], closed: 0, prompts: [] };
    const service = createSubagentService({ createChild: fakeChild(fake) });
    expect(await service.message("Bad", "hi", {})).toEqual({ ok: false, error_code: "invalid_agent" });
    const first = service.message("rev", "first", { instructions: "Review strictly." });
    await settle();
    expect(await service.message("rev", "again", {})).toEqual({ ok: false, error_code: "agent_busy" });
    fake.release?.();
    fake.release = undefined;
    expect((await first).ok).toBe(true);
    const second = service.message("rev", "second", {});
    await finish(fake);
    expect(await second).toMatchObject({ ok: true, result: "echo:Review strictly.\n\nsecond" });
    expect(fake.created).toHaveLength(1);
    expect(fake.created[0]?.history).toHaveLength(2);
    expect(fake.prompts).toEqual(["Review strictly.\n\nfirst", "Review strictly.\n\nsecond"]);
    expect(await service.message("rev", "x", { model: "other" })).toMatchObject({
      ok: false,
      error_code: "override_rejected",
    });
    expect(fake.closed).toBe(0);
    await service.close();
    expect(fake.closed).toBe(1);
  });

  test("maps failed, paused, and interrupted turns", async () => {
    for (const [kind, expected] of [
      ["failed", { ok: false, error_code: "agent_failed", message: "boom" }],
      ["paused", { ok: false, error_code: "agent_paused", message: "rate limited" }],
      ["interrupted", { ok: false, error_code: "interrupted" }],
    ] as const) {
      const fake: Fake = { created: [], closed: 0, prompts: [] };
      const pending = createSubagentService({ createChild: fakeChild(fake, kind) }).run("t", {});
      await finish(fake);
      expect(await pending).toEqual(expected);
    }
  });

  test("the subagent tool serializes the service outcome", async () => {
    const fake: Fake = { created: [], closed: 0, prompts: [] };
    const subagents = createSubagentService({ createChild: fakeChild(fake) });
    const ctx = makeCtx(tempWorkspace(), { subagents });
    const pending = call(decodeOk(decode({ request: { action: "message", agent: "rev", message: "go" } })), ctx);
    await finish(fake);
    expect(await pending).toEqual({
      status: "success",
      output: '{"ok":true,"agent":"rev","result":"echo:go","tool_calls":[{"name":"read_file","status":"success"}]}',
    });
  });
});
