import { describe, expect, test } from "bun:test";
import type { SubagentService } from "../../src/core/subagent/types.ts";
import { call, decode } from "../../src/core/tools/subagent.ts";
import { decodeFail, decodeOk, makeCtx, tempWorkspace } from "./helpers.ts";

const code = (args: unknown) => JSON.parse(decodeFail(decode(args))).error_code;

describe("subagent", () => {
  test("decode accepts only delegation intents", () => {
    expect(decodeOk(decode({ request: { action: "run", task: "do it" } }))).toEqual({ action: "run", task: "do it" });
    expect(
      decodeOk(decode({ action: "message", agent: "reviewer", message: "next", instructions: "Review strictly." }))
        .action,
    ).toBe("message");
    expect(
      decodeOk(decode({ request: { action: "run", task: "do it", model: "gpt-5.6", effort: "medium" } })).effort,
    ).toBe("medium");
    expect(code({ request: { action: "wait", child_id: "01J" } })).toBe("invalid_enum");
    expect(code({ request: { action: "run", task: "do it", model: "" } })).toBe("invalid_model");
    expect(code({ request: { action: "run", task: "do it", effort: "not an effort!" } })).toBe("invalid_effort");
    expect(code({ request: { action: "message", agent: "reviewer", message: "next", model: 7 } })).toBe(
      "invalid_field_type",
    );
    expect(code({ request: { action: "run", task: "do it", provider: "gateway" } })).toBe("unknown_field");
    expect(code({ command: { create: { name: "worker" } } })).toBe("missing_field");
    expect(code({ request: null })).toBe("invalid_field_type");
    expect(code({ request: { action: "message", agent: "Reviewer", message: "next" } })).toBe("invalid_agent");
    expect(code({ request: { action: "message", agent: "reviewer", message: "  " } })).toBe("invalid_message");
    expect(code({ request: { action: "message", agent: "reviewer", message: "m", instructions: "" } })).toBe(
      "invalid_instructions",
    );
    expect(code({ request: { action: "run", task: " " } })).toBe("invalid_task");
    expect(code({ request: { action: "run", task: "x" }, other: 1 })).toBe("unknown_field");
  });

  test("call delegates to the host and reports host absence", async () => {
    const ws = tempWorkspace();
    const input = decodeOk(decode({ request: { action: "run", task: "review this" } }));
    expect(await call(input, makeCtx(ws))).toEqual({
      status: "failure",
      output: '{"ok":false,"error_code":"host_unavailable"}',
    });
    const calls: unknown[] = [];
    const subagents: SubagentService = {
      run: async (task, opts) => {
        calls.push(["run", task, opts]);
        return { ok: true, result: "done", toolCalls: [{ name: "read_file", status: "success" }] };
      },
      message: async (agent, message, opts) => {
        calls.push(["message", agent, message, opts]);
        return { ok: false, error_code: "agent_busy" };
      },
    };
    expect(await call(input, makeCtx(ws, { subagents }))).toEqual({
      status: "success",
      output: '{"ok":true,"result":"done","tool_calls":[{"name":"read_file","status":"success"}]}',
    });
    const msg = decodeOk(decode({ request: { action: "message", agent: "rev", message: "hi", effort: "high" } }));
    expect(await call(msg, makeCtx(ws, { subagents }))).toEqual({
      status: "failure",
      output: '{"ok":false,"error_code":"agent_busy"}',
    });
    expect(calls).toEqual([
      ["run", "review this", { model: undefined, effort: undefined }],
      ["message", "rev", "hi", { model: undefined, effort: "high", instructions: undefined }],
    ]);
  });
});
