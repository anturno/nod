import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { readFrames } from "../../src/acp/jsonrpc.ts";
import { connect, fakeBinding, type Reply, scriptedLLM, shellCall, tempHome } from "./helpers.ts";

const homes: string[] = [];
const open: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const c of open.splice(0)) await c.close();
  for (const h of homes.splice(0)) rmSync(h, { recursive: true, force: true });
});

function client(replies: Reply[], env: Record<string, string> = {}) {
  const { home, cwd } = tempHome();
  homes.push(home);
  const llm = scriptedLLM(replies);
  const c = connect({
    cwd,
    env: { NOD_HOME: home, NOD_PERMISSION_MODE: "yolo", NOD_MODEL: "gpt-5.4", ...env },
    bind: async (_p, model) => fakeBinding(llm, model ?? "gpt-5.4"),
  });
  open.push(c);
  return { ...c, home, cwd, llm };
}

const textPrompt = (text: string) => [{ type: "text", text }];

async function newSession(c: ReturnType<typeof client>, extra: Record<string, unknown> = {}) {
  await c.request("initialize", { protocolVersion: 1 });
  const res = await c.request("session/new", { cwd: c.cwd, ...extra });
  return (res.result as { sessionId: string }).sessionId;
}

describe("acp: protocol", () => {
  test("initialize negotiates version 1 and guards the rest", async () => {
    const c = client([]);
    const before = await c.request("session/new", { cwd: c.cwd });
    expect(before.error).toMatchObject({ code: -32600, message: "Not initialized. Call initialize first." });
    const init = await c.request("initialize", { protocolVersion: 1 });
    expect(init.result).toEqual({
      protocolVersion: 1,
      agentCapabilities: {
        loadSession: true,
        promptCapabilities: { image: true, audio: false, embeddedContext: true },
        mcpCapabilities: { http: true, sse: true },
        sessionCapabilities: { list: {}, resume: {}, close: {} },
      },
      agentInfo: { name: "nod", title: "nod", version: "0.0.0-test" },
      authMethods: [],
    });
    expect((await c.request("initialize", { protocolVersion: 1 })).error).toMatchObject({
      code: -32600,
      message: "Already initialized",
    });
    expect((await c.request("session/bogus")).error).toMatchObject({ code: -32601, message: "Method not found" });
    expect((await c.request("session/prompt", { prompt: [] })).error).toMatchObject({ code: -32600 });
    c.raw("{not json}\n");
    await c.waitFor((m) => m.id === null && (m.error as { code: number })?.code === -32700);
    c.raw(`${JSON.stringify({ id: 99, method: "session/list" })}\n`);
    expect((await c.waitFor((m) => m.id === 99)).error).toMatchObject({ code: -32600, message: "Invalid Request" });
    await c.close();
  });

  test("frames over 8 MiB are rejected with -32000 and the stream recovers", async () => {
    const c = client([]);
    await c.request("initialize", { protocolVersion: 1 });
    c.raw(
      `${JSON.stringify({ jsonrpc: "2.0", id: 7, method: "session/list", params: { pad: "x".repeat(8 * 1024 * 1024 + 1) } })}\n`,
    );
    const err = await c.waitFor((m) => m.id === null && (m.error as { code: number })?.code === -32000);
    expect(err.error).toEqual({ code: -32000, message: "request frame too large" });
    expect((await c.request("session/list")).result).toEqual({ sessions: [] });
    await c.close();
  });

  test("readFrames splits lines across chunks", async () => {
    const input = new PassThrough();
    input.write('{"jsonrpc":"2.0","id":1,"me');
    input.write('thod":"a"}\n\n{"jsonrpc":"2.0","id":2,"method":"b"}');
    input.end();
    const frames = [];
    for await (const f of readFrames(input)) frames.push(f);
    expect(frames.map((f) => (f.kind === "message" ? f.message.id : f.kind))).toEqual([1, 2]);
  });
});

describe("acp: sessions", () => {
  test("session/new records client mcpServers and reports config options", async () => {
    const c = client([]);
    const sessionId = await newSession(c, {
      mcpServers: [
        { name: "fs", command: "/bin/mcp-fs", args: ["--root", "."], env: [{ name: "A", value: "1" }] },
        { type: "http", name: "web", url: "https://mcp.example/api", headers: [{ name: "Authorization", value: "x" }] },
      ],
    });
    expect(sessionId).toMatch(/^[A-Za-z0-9_-]{12}$/);
    const res = c.out.find((m) => m.id === 2)?.result as {
      configOptions: { id: string; currentValue: string }[];
      modes: unknown;
    };
    expect(res.configOptions.map((o) => o.id)).toEqual(["model", "mode", "effort"]);
    expect(res.configOptions.find((o) => o.id === "model")?.currentValue).toBe("gpt-5.4");
    expect(res.configOptions.find((o) => o.id === "mode")?.currentValue).toBe("code");
    expect(res.modes).toEqual({
      currentModeId: "code",
      availableModes: [
        { id: "ask", name: "Ask", description: "Request approval for sensitive tool calls" },
        { id: "code", name: "Code", description: "Automatically review sensitive tool calls" },
      ],
    });
    await c.waitFor((m) => m.method === "session/update");
    expect(c.updates("available_commands_update")).toEqual([
      { sessionUpdate: "available_commands_update", availableCommands: [] },
    ]);
    expect(c.server.health().session?.mcpServers).toEqual([
      { name: "fs", transport: "stdio", source: "acp" },
      { name: "web", transport: "http", source: "acp" },
    ]);
    const bad = await c.request("session/new", { cwd: c.cwd, mcpServers: [{ name: "x" }] });
    expect(bad.error).toMatchObject({ code: -32602 });
    await c.close();
  });

  test("ask mode is the initial mode when the saved permission mode is ask", async () => {
    const c = client([], { NOD_PERMISSION_MODE: "ask" });
    await newSession(c);
    expect(c.server.health().session?.mode).toBe("ask");
    await c.close();
  });

  test("set_config_option and set_mode update the session", async () => {
    const c = client([]);
    const sessionId = await newSession(c);
    const model = await c.request("session/set_config_option", { sessionId, configId: "model", value: "gpt-5.4-mini" });
    const options = (model.result as { configOptions: { id: string; currentValue: string }[] }).configOptions;
    expect(options.find((o) => o.id === "model")?.currentValue).toBe("gpt-5.4-mini");
    expect(JSON.parse(readFileSync(join(c.home, "sessions", sessionId, "session.json"), "utf8")).model).toBe(
      "gpt-5.4-mini",
    );
    expect((await c.request("session/set_mode", { sessionId, modeId: "ask" })).result).toEqual({});
    await c.waitFor(
      (m) =>
        m.method === "session/update" &&
        (m.params as { update: { sessionUpdate: string } }).update.sessionUpdate === "current_mode_update",
    );
    expect(c.updates("current_mode_update")).toEqual([{ sessionUpdate: "current_mode_update", currentModeId: "ask" }]);
    expect(c.server.health().session?.mode).toBe("ask");
    const mode = await c.request("session/set_config_option", { sessionId, configId: "mode", value: "code" });
    expect(
      (mode.result as { configOptions: { id: string; currentValue: string }[] }).configOptions.find(
        (o) => o.id === "mode",
      )?.currentValue,
    ).toBe("code");
    const effort = await c.request("session/set_config_option", { sessionId, configId: "effort", value: "high" });
    expect(
      (effort.result as { configOptions: { id: string; currentValue: string }[] }).configOptions.find(
        (o) => o.id === "effort",
      )?.currentValue,
    ).toBe("high");
    expect(
      (await c.request("session/set_config_option", { sessionId, configId: "effort", value: "bogus" })).error,
    ).toMatchObject({ code: -32602 });
    expect(
      (await c.request("session/set_config_option", { sessionId, configId: "nope", value: "x" })).error,
    ).toMatchObject({ code: -32602 });
    expect((await c.request("session/set_mode", { sessionId, modeId: "yolo" })).error).toMatchObject({ code: -32602 });
    await c.close();
  });

  test("list, load (replay) and resume (no replay)", async () => {
    const c = client([{ text: "", toolCalls: [shellCall("call_1", "printf ok")] }, { text: "ran it" }]);
    const sessionId = await newSession(c);
    const prompt = await c.request("session/prompt", { sessionId, prompt: textPrompt("run it") });
    expect(prompt.result).toMatchObject({ stopReason: "end_turn" });
    const list = await c.request("session/list");
    expect(list.result).toEqual({
      sessions: [
        {
          sessionId,
          cwd: c.cwd,
          title: "Title",
          updatedAt: expect.stringMatching(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/),
        },
      ],
    });
    expect((await c.request("session/close", { sessionId })).result).toEqual({});
    const before = c.out.length;
    const load = await c.request("session/load", { sessionId, cwd: c.cwd });
    expect(load.result).toMatchObject({ modes: { currentModeId: "code" } });
    await c.waitFor(
      (m) =>
        m.method === "session/update" &&
        (m.params as { update: { sessionUpdate: string } }).update.sessionUpdate === "available_commands_update" &&
        c.out.indexOf(m) >= before,
    );
    const replayed = c.out
      .slice(before)
      .filter((m) => m.method === "session/update")
      .map((m) => (m.params as { update: Record<string, unknown> }).update);
    expect(replayed.map((u) => u.sessionUpdate)).toEqual([
      "user_message_chunk",
      "tool_call",
      "tool_call_update",
      "agent_message_chunk",
      "available_commands_update",
    ]);
    expect(replayed[1]).toMatchObject({ toolCallId: "call_1", name: "shell", kind: "execute", status: "pending" });
    expect(replayed[2]).toMatchObject({ toolCallId: "call_1", status: "completed" });
    expect(replayed[3]).toMatchObject({ content: { type: "text", text: "ran it" } });
    await c.request("session/close", { sessionId });
    const beforeResume = c.out.length;
    expect((await c.request("session/resume", { sessionId, cwd: c.cwd })).result).toMatchObject({
      configOptions: expect.any(Array),
    });
    await c.waitFor((m) => m.method === "session/update" && c.out.indexOf(m) >= beforeResume);
    expect(
      c.out
        .slice(beforeResume)
        .filter((m) => m.method === "session/update")
        .map((m) => (m.params as { update: { sessionUpdate: string } }).update.sessionUpdate),
    ).toEqual(["available_commands_update"]);
    expect((await c.request("session/load", { sessionId: "missing-session", cwd: c.cwd })).error).toMatchObject({
      code: -32602,
    });
    await c.close();
  });
});

describe("acp: prompts", () => {
  test("streams the reply and stops with end_turn and usage", async () => {
    const c = client([{ chunks: ["hel", "lo"], usage: { inputTokens: 40, outputTokens: 7 } }]);
    const sessionId = await newSession(c);
    const res = await c.request("session/prompt", {
      sessionId,
      prompt: [...textPrompt("hi"), { type: "resource", resource: { uri: "file:///a.md", text: "# A" } }],
    });
    expect(res.result).toEqual({ stopReason: "end_turn", usage: { inputTokens: 40, outputTokens: 7 } });
    const kinds = c.updates().map((u) => u.sessionUpdate);
    expect(kinds).toEqual([
      "available_commands_update",
      "user_message_chunk",
      "agent_message_chunk",
      "agent_message_chunk",
      "session_info_update",
      "usage_update",
    ]);
    expect(c.updates("agent_message_chunk").map((u) => (u.content as { text: string }).text)).toEqual(["hel", "lo"]);
    expect(c.updates("session_info_update")[0]).toMatchObject({ title: "Title" });
    expect(c.updates("usage_update")[0]).toMatchObject({ size: 400_000 });
    expect(c.llm.calls[0]?.at(-1)?.content).toContain('<embedded_resource uri="file:///a.md">');
    expect(
      (await c.request("session/prompt", { sessionId, prompt: [{ type: "audio", data: "", mimeType: "audio/wav" }] }))
        .error,
    ).toMatchObject({ code: -32602 });
    await c.close();
  });

  test("tool_call precedes tool_call_update and shell runs carry command_result", async () => {
    const c = client([{ text: "", toolCalls: [shellCall("call_1", "printf ok")] }, { text: "done" }]);
    const sessionId = await newSession(c);
    expect((await c.request("session/prompt", { sessionId, prompt: textPrompt("run") })).result).toMatchObject({
      stopReason: "end_turn",
    });
    const updates = c.updates();
    const call = updates.findIndex((u) => u.sessionUpdate === "tool_call");
    const update = updates.findIndex((u) => u.sessionUpdate === "tool_call_update");
    expect(call).toBeGreaterThan(0);
    expect(update).toBeGreaterThan(call);
    expect(updates[call]).toEqual({
      sessionUpdate: "tool_call",
      toolCallId: "call_1",
      name: "shell",
      title: "shell.run printf ok",
      kind: "execute",
      status: "in_progress",
      rawInput: { request: { action: "run", command: "printf ok", yield_time_ms: 5000 } },
    });
    const preview = (updates[update] as { content: { content: { text: string } }[] }).content[0]!.content.text;
    expect(preview).toMatch(/^\{"session_id":/);
    expect(Buffer.byteLength(preview)).toBeLessThanOrEqual(200);
    expect(updates[update]).toMatchObject({
      toolCallId: "call_1",
      status: "completed",
      command_result: {
        kind: "command",
        command: "printf ok",
        cwd: c.cwd,
        exit_code: 0,
        signal: null,
        timed_out: false,
        stdout_bytes: 2,
        stderr_bytes: 0,
        truncated: false,
      },
    });
    await c.close();
  });

  test("ask mode asks the client: allow once, always, reject, cancelled", async () => {
    const c = client(
      [
        { toolCalls: [shellCall("c1", "touch f1")] },
        { text: "a" },
        { toolCalls: [shellCall("c2", "touch f2")] },
        { text: "b" },
        { toolCalls: [shellCall("c3", "touch f2")] },
        { text: "c" },
        { toolCalls: [shellCall("c4", "touch f3")] },
        { text: "d" },
        { toolCalls: [shellCall("c5", "touch f4")] },
        { text: "e" },
      ],
      { NOD_PERMISSION_MODE: "ask" },
    );
    const sessionId = await newSession(c);
    const seen = new Set<unknown>();
    const ask = async (optionId: string | null) => {
      const req = await c.serverRequest("session/request_permission", seen);
      seen.add(req.id);
      c.respond(
        req.id as number,
        optionId ? { outcome: { outcome: "selected", optionId } } : { outcome: { outcome: "cancelled" } },
      );
      return req.params as { toolCall: Record<string, unknown>; options: unknown[] };
    };
    const id1 = c.send("session/prompt", { sessionId, prompt: textPrompt("one") });
    const p1 = await ask("allow_once");
    expect(p1.toolCall).toEqual({
      toolCallId: "c1",
      name: "shell",
      title: "shell.run touch f1",
      kind: "execute",
      status: "pending",
      rawInput: { request: { action: "run", command: "touch f1", yield_time_ms: 5000 } },
    });
    expect(p1.options).toEqual([
      { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
      { optionId: "allow_always", name: "Allow for this session", kind: "allow_always" },
      { optionId: "reject_once", name: "Reject", kind: "reject_once" },
    ]);
    expect((await c.response(id1)).result).toMatchObject({ stopReason: "end_turn" });
    expect(c.updates("tool_call_update").at(-1)).toMatchObject({ toolCallId: "c1", status: "completed" });

    const id2 = c.send("session/prompt", { sessionId, prompt: textPrompt("two") });
    await ask("allow_always");
    await c.response(id2);
    const id3 = c.send("session/prompt", { sessionId, prompt: textPrompt("two again") });
    await c.response(id3);
    expect(c.out.filter((m) => m.method === "session/request_permission")).toHaveLength(2);
    expect(c.updates("tool_call_update").at(-1)).toMatchObject({ toolCallId: "c3", status: "completed" });

    const id4 = c.send("session/prompt", { sessionId, prompt: textPrompt("three") });
    await ask("reject_once");
    await c.response(id4);
    const rejected = c.updates("tool_call_update").at(-1) as {
      status: string;
      content: { content: { text: string } }[];
    };
    expect(rejected.status).toBe("failed");
    expect(JSON.parse(rejected.content[0]!.content.text)).toMatchObject({
      error: { type: "tool_permission_denied", reason: "user_denied" },
    });

    const id5 = c.send("session/prompt", { sessionId, prompt: textPrompt("four") });
    await ask(null);
    await c.response(id5);
    expect(c.updates("tool_call_update").at(-1)).toMatchObject({ toolCallId: "c5", status: "failed" });
    await c.close();
  });

  test("ask_user_question becomes a request_permission with one option per answer plus other", async () => {
    const c = client(
      [
        {
          toolCalls: [
            {
              id: "q1",
              name: "ask_user_question",
              arguments: JSON.stringify({
                questions: [{ question: "Which?", options: [{ label: "A" }, { label: "B", description: "second" }] }],
              }),
            },
          ],
        },
        { text: "ok" },
      ],
      { NOD_PERMISSION_MODE: "ask" },
    );
    const sessionId = await newSession(c);
    const id = c.send("session/prompt", { sessionId, prompt: textPrompt("choose") });
    const req = await c.serverRequest("session/request_permission", new Set());
    expect(req.params).toMatchObject({
      toolCall: { toolCallId: "q1", name: "ask_user_question", title: "Which?", kind: "other", status: "pending" },
      options: [
        { optionId: "option_1", name: "A", kind: "allow_once" },
        { optionId: "option_2", name: "B", kind: "allow_once", description: "second" },
        { optionId: "other", name: "Other", kind: "reject_once" },
      ],
    });
    c.respond(req.id as number, { outcome: { outcome: "selected", optionId: "option_2" } });
    expect((await c.response(id)).result).toMatchObject({ stopReason: "end_turn" });
    expect(c.llm.calls[1]?.find((m) => m.role === "tool")?.content).toBe(
      JSON.stringify([{ question: "Which?", answer: "B" }]),
    );
    await c.close();
  });

  test("code mode never asks the client", async () => {
    const c = client([{ toolCalls: [shellCall("c1", "rm -rf build")] }, { text: "x" }], { NOD_PERMISSION_MODE: "ask" });
    const sessionId = await newSession(c);
    await c.request("session/set_mode", { sessionId, modeId: "code" });
    expect((await c.request("session/prompt", { sessionId, prompt: textPrompt("go") })).result).toMatchObject({
      stopReason: "end_turn",
    });
    expect(c.out.some((m) => m.method === "session/request_permission")).toBe(false);
    expect(c.updates("tool_call_update")).toHaveLength(1);
    await c.close();
  });

  test("session/cancel aborts the turn and a second prompt is rejected meanwhile", async () => {
    const c = client([{ waitForAbort: true }, { text: "after" }]);
    const sessionId = await newSession(c);
    const id = c.send("session/prompt", { sessionId, prompt: textPrompt("wait") });
    await c.waitFor(
      (m) =>
        m.method === "session/update" &&
        (m.params as { update: { sessionUpdate: string } }).update.sessionUpdate === "user_message_chunk",
    );
    expect((await c.request("session/prompt", { sessionId, prompt: textPrompt("again") })).error).toEqual({
      code: -32600,
      message: "a prompt is already in progress",
    });
    c.notify("session/cancel", { sessionId });
    expect((await c.response(id)).result).toMatchObject({ stopReason: "cancelled" });
    expect((await c.request("session/prompt", { sessionId, prompt: textPrompt("next") })).result).toMatchObject({
      stopReason: "end_turn",
    });
    await c.close();
  });

  test("stop reasons: max_model_turns at the step limit, refused on a terminal provider failure", async () => {
    const c = client([{ toolCalls: [shellCall("c1", "printf ok")] }, { fail: "rejected (401)" }], {
      NOD_MAX_AGENT_STEPS: "1",
    });
    const sessionId = await newSession(c);
    expect((await c.request("session/prompt", { sessionId, prompt: textPrompt("x") })).result).toMatchObject({
      stopReason: "max_model_turns",
    });
    expect((await c.request("session/prompt", { sessionId, prompt: textPrompt("y") })).result).toMatchObject({
      stopReason: "refused",
    });
    await c.close();
  });
});
