import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { decodeCheckpoint } from "../../src/core/agent/checkpoint.ts";
import type { ToolCall } from "../../src/core/agent/types.ts";
import type { McpService } from "../../src/core/mcp/types.ts";
import {
  type AgentOptions,
  createAgent,
  createMcpTools,
  createSkillsAdapter,
  type HostTool,
  hostToolResult,
  listModels,
  loadSkillFile,
  sdkApiVersion,
  type TurnEvent,
} from "../../src/sdk/index.ts";
import { type Reply, scriptedLLM, shellCall } from "../acp/helpers.ts";

let home: string;
let cwd: string;
const realHome = process.env.NOD_HOME;
beforeEach(() => {
  home = realpathSync.native(mkdtempSync(join(tmpdir(), "nod-sdk-test-")));
  cwd = join(home, "ws");
  mkdirSync(cwd);
  process.env.NOD_HOME = home;
});
afterEach(() => {
  process.env.NOD_HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

const call = (id: string, name: string, args: unknown): ToolCall => ({ id, name, arguments: JSON.stringify(args) });
const lookup: HostTool = {
  name: "lookup",
  description: "Look up a value.",
  inputSchema: { type: "object", properties: { key: { type: "string" } } },
  execute: (input) => ({ value: 42, key: (input as { key: string }).key }),
};

async function agentWith(replies: Reply[], extra: Partial<AgentOptions> = {}) {
  const llm = scriptedLLM(replies);
  const agent = await createAgent({ auth: { provider: "codex" }, model: "gpt-5.4", llm, workspace: { cwd }, ...extra });
  return { agent, llm };
}

const drain = async (turn: AsyncIterable<TurnEvent>) => {
  const events: TurnEvent[] = [];
  for await (const e of turn) events.push(e);
  return events;
};

describe("sdk: agent", () => {
  test("streams text and tool events, then the result", async () => {
    const events: string[] = [];
    const { agent, llm } = await agentWith(
      [{ toolCalls: [call("t1", "lookup", { key: "a" })] }, { chunks: ["hel", "lo"] }],
      {
        tools: [lookup],
        instructions: ["Be brief.", "Answer in English."],
        onEvent: (e) => events.push(e.type),
      },
    );
    const turn = agent.prompt("hi");
    expect(await drain(turn)).toEqual([
      { type: "tool_start", id: "t1", name: "lookup" },
      { type: "tool_end", id: "t1", name: "lookup", content: '{"value":42,"key":"a"}', isError: false },
      { type: "text_delta", delta: "hel" },
      { type: "text_delta", delta: "lo" },
    ]);
    expect(await turn.result).toEqual({ stopReason: "end_turn", usage: { inputTokens: 20, outputTokens: 10 } });
    expect(llm.calls[0]?.[0]?.content).toContain("Be brief.\n\nAnswer in English.");
    expect(llm.calls[0]?.at(-1)).toMatchObject({ role: "user", content: "hi" });
    await agent.close();
    expect(events).toEqual(["runtime.start", "runtime.ready", "runtime.exit"]);
  });

  test("host tool results: undefined is null, throws fail, rich results carry images", async () => {
    const tools: HostTool[] = [
      { name: "nothing", description: "", inputSchema: {}, execute: () => undefined },
      {
        name: "boom",
        description: "",
        inputSchema: {},
        execute: () => {
          throw new Error("nope");
        },
      },
      {
        name: "pic",
        description: "",
        inputSchema: {},
        execute: () => ({
          type: "nod.tool-result",
          text: "img",
          images: [{ type: "image", mimeType: "image/png", data: "AAAA" }],
        }),
      },
    ];
    const { agent } = await agentWith(
      [{ toolCalls: [call("a", "nothing", {}), call("b", "boom", {}), call("c", "pic", {})] }, { text: "ok" }],
      { tools },
    );
    const ends = (await drain(agent.prompt("go"))).filter((e) => e.type === "tool_end");
    expect(ends).toEqual([
      { type: "tool_end", id: "a", name: "nothing", content: "null", isError: false },
      { type: "tool_end", id: "b", name: "boom", content: "nope", isError: true },
      { type: "tool_end", id: "c", name: "pic", content: "img", isError: false },
    ]);
    await agent.close();
    expect(hostToolResult({ a: 1 })).toEqual({ status: "success", output: '{"a":1}' });
    expect(() => hostToolResult("x".repeat(8 * 1024 * 1024 + 1))).toThrow(RangeError);
    expect(() => hostToolResult({ type: "nod.tool-result", text: "t", images: new Array(9).fill({}) })).toThrow(
      TypeError,
    );
  });

  test("an already aborted signal cancels without a request or a history change", async () => {
    const { agent, llm } = await agentWith([{ text: "later" }]);
    const controller = new AbortController();
    controller.abort();
    const turn = agent.prompt("wait", { signal: controller.signal });
    expect(await drain(turn)).toEqual([]);
    expect(await turn.result).toEqual({ stopReason: "cancelled", usage: {} });
    expect(llm.calls).toHaveLength(0);
    expect(decodeCheckpoint(await agent.checkpoint()).history).toHaveLength(0);
    expect(
      await (await drain(agent.prompt("now")), agent.checkpoint().then((b) => decodeCheckpoint(b).history.length)),
    ).toBe(1);
    await agent.close();
  });

  test("cancel through cancel(), break, and an AbortSignal", async () => {
    const { agent } = await agentWith([{ waitForAbort: true }, { chunks: ["a", "b"] }, { waitForAbort: true }]);
    const first = agent.prompt("one");
    first.cancel();
    await drain(first);
    expect((await first.result).stopReason).toBe("cancelled");

    const second = agent.prompt("two");
    for await (const _ of second) break;
    expect((await second.result).stopReason).toBe("cancelled");

    const controller = new AbortController();
    const third = agent.prompt("three", { signal: controller.signal });
    setTimeout(() => controller.abort(), 10);
    await drain(third);
    expect((await third.result).stopReason).toBe("cancelled");
    // The break arrived after the model had already finished, so that turn is saved complete.
    expect(decodeCheckpoint(await agent.checkpoint()).history.map((t) => t.kind)).toEqual([
      "interrupted",
      "assistant",
      "interrupted",
    ]);
    await agent.close();
  });

  test("one prompt and one consumer at a time; checkpoint is idle-only", async () => {
    const { agent } = await agentWith([{ waitForAbort: true }]);
    const turn = agent.prompt("busy");
    expect(() => agent.prompt("again")).toThrow("a prompt is already in progress for this session");
    await expect(agent.checkpoint()).rejects.toThrow("cannot checkpoint while a prompt is active");
    turn[Symbol.asyncIterator]();
    expect(() => turn[Symbol.asyncIterator]()).toThrow("a turn has only one event consumer");
    turn.cancel();
    await turn.result;
    await agent.close();
    expect(() => agent.prompt("closed")).toThrow("nod agent is closed");
  });

  test("close cancels the active turn", async () => {
    const { agent } = await agentWith([{ waitForAbort: true }]);
    const turn = agent.prompt("busy");
    await agent.close();
    expect((await turn.result).stopReason).toBe("cancelled");
  });

  test("checkpoint restores the conversation in a fresh agent", async () => {
    const { agent } = await agentWith([{ text: "hello", usage: { inputTokens: 3, outputTokens: 4 } }]);
    await drain(agent.prompt("hi"));
    const bytes = await agent.checkpoint();
    await agent.close();
    const decoded = decodeCheckpoint(bytes);
    expect(decoded.history).toHaveLength(1);
    expect(decoded.usage).toMatchObject({ inputTokens: 3, outputTokens: 4 });
    const { agent: restored, llm } = await agentWith([{ text: "again" }], { checkpoint: bytes });
    await drain(restored.prompt("more"));
    const roles = llm.calls[0]?.map((m) => `${m.role}:${m.content}`);
    expect(roles).toContain("user:hi");
    expect(roles).toContain("assistant:hello");
    expect(decodeCheckpoint(await restored.checkpoint()).usage).toMatchObject({ inputTokens: 13, outputTokens: 9 });
    await restored.close();
    await expect(
      createAgent({ auth: { provider: "codex" }, llm: scriptedLLM([]), checkpoint: new Uint8Array([1, 2, 3]) }),
    ).rejects.toThrow();
  });

  test("validates tools, instructions, prompts, and auth", async () => {
    const tool = (name: string): HostTool => ({ name, description: "", inputSchema: {}, execute: () => null });
    const base = { auth: { provider: "codex" as const }, llm: scriptedLLM([]) };
    await expect(createAgent({ ...base, tools: Array.from({ length: 65 }, (_, i) => tool(`t${i}`)) })).rejects.toThrow(
      RangeError,
    );
    await expect(createAgent({ ...base, tools: [tool("bad name")] })).rejects.toThrow("tool 0 has an invalid name");
    await expect(createAgent({ ...base, tools: [tool("a"), tool("a")] })).rejects.toThrow("duplicate tool name: a");
    await expect(createAgent({ ...base, tools: [{ ...tool("a"), execute: undefined as never }] })).rejects.toThrow(
      "requires execute()",
    );
    await expect(createAgent({ ...base, instructions: "x".repeat(64 * 1024 + 1) })).rejects.toThrow(RangeError);
    await expect(createAgent({ ...base, instructions: 5 as never })).rejects.toThrow(TypeError);
    await expect(createAgent({ auth: { provider: "openai" as never } })).rejects.toThrow(
      "auth.provider must be codex or grok",
    );
    await expect(createAgent({ auth: { provider: "codex" } })).rejects.toThrow("Not signed in");
    await expect(listModels({ auth: { provider: "grok" } })).rejects.toThrow("Not signed in");
    const { agent } = await agentWith([]);
    expect(() =>
      agent.prompt([{ type: "image", data: "x".repeat(5 * 1024 * 1024 + 1), mimeType: "image/png" }]),
    ).toThrow(RangeError);
    expect(() => agent.prompt([{ type: "audio" } as never])).toThrow("unsupported prompt block type: audio");
    expect(() =>
      agent.prompt(Array.from({ length: 9 }, () => ({ type: "image" as const, data: "AA", mimeType: "image/png" }))),
    ).toThrow(RangeError);
    await agent.close();
    expect(sdkApiVersion).toBe(1);
  });

  test("a slow reader pauses production instead of growing the queue", async () => {
    const events: string[] = [];
    const { agent } = await agentWith([{ chunks: Array.from({ length: 300 }, () => "x") }], {
      onEvent: (e) => events.push(e.type),
    });
    const turn = agent.prompt("flood");
    let settled = false;
    turn.result.then(() => {
      settled = true;
    });
    await new Promise((r) => setTimeout(r, 30));
    expect(settled).toBe(false);
    expect(events).toContain("output.backpressure");
    expect(await drain(turn)).toHaveLength(300);
    expect((await turn.result).stopReason).toBe("end_turn");
    await agent.close();
  });

  test("built-in tools are denied without a permissions handler and asked with one", async () => {
    const denied = await agentWith([{ toolCalls: [shellCall("s1", "touch made")] }, { text: "x" }]);
    const end = (await drain(denied.agent.prompt("touch"))).find((e) => e.type === "tool_end") as {
      content: string;
      isError: boolean;
    };
    expect(end.isError).toBe(true);
    expect(JSON.parse(end.content)).toMatchObject({
      error: { type: "tool_permission_denied", reason: "permission_required" },
    });
    await denied.agent.close();

    const seen: string[] = [];
    const allowed = await agentWith([{ toolCalls: [shellCall("s2", "touch made")] }, { text: "y" }], {
      permissions: (request: { label: string }) => {
        seen.push(request.label);
        return { outcome: "once" };
      },
    });
    const ok = (await drain(allowed.agent.prompt("touch"))).find((e) => e.type === "tool_end") as { isError: boolean };
    expect(ok.isError).toBe(false);
    expect(seen).toEqual(["shell.run touch made"]);
    await allowed.agent.close();
  });

  test("workspace.shell false removes the shell tool", async () => {
    const { agent, llm } = await agentWith([{ text: "ok" }], { workspace: { cwd, shell: false } });
    await drain(agent.prompt("hi"));
    await agent.close();
    expect(llm.calls[0]).toBeDefined();
  });
});

describe("sdk: adapters", () => {
  const spec = (name: string, description = "") => ({
    name,
    description,
    parameters: { type: "object", properties: {} },
    activity: "read" as const,
    requiresApproval: false,
    permissionTarget: "none" as const,
    decode: (args: unknown) => ({ ok: true as const, input: args }),
    call: async () => ({ status: "success" as const, output: "" }),
  });
  const fakeService = () => {
    const calls: unknown[] = [];
    let closed = false;
    const service: McpService & { close(): Promise<void>; calls: unknown[]; closed: () => boolean } = {
      calls,
      closed: () => closed,
      tools: () => [spec("mcp_srv_echo", "Echo"), spec("mcp_srv_fail"), spec("mcp_srv_echo")],
      search: async () => ({ text: "", selected: [] }),
      select: async () => ({ ok: true, text: "" }),
      serverNames: () => ["srv"],
      async features(request) {
        calls.push(request);
        return { status: "success", output: request.action === "resource_read" ? "RES" : "PROMPT" };
      },
      async call(alias, args) {
        calls.push({ alias, args });
        if (alias === "mcp_srv_fail")
          return { status: "failure", output: "failed hard", images: [{ id: 1, mime: "image/png", data: "QUJD" }] };
        return { status: "success", output: JSON.stringify(args) };
      },
      async close() {
        closed = true;
      },
    };
    return service;
  };

  test("createMcpTools maps selected tools, resources, and prompts", async () => {
    const service = fakeService();
    const mcp = await createMcpTools(service, {
      prefix: "gh_",
      resources: [{ server: "srv", uri: "repo://readme" }],
      prompts: [{ server: "srv", name: "review", arguments: { depth: "1" } }],
    });
    expect(mcp.tools.map((t) => t.name)).toEqual(["gh_mcp_srv_echo", "gh_mcp_srv_fail", "gh_mcp_srv_echo_2"]);
    expect(mcp.tools[0]?.description).toBe("Echo");
    expect(mcp.tools[1]?.description).toBe("MCP tool");
    expect(mcp.instructions).toBe("<mcp_resource>\nRES\n</mcp_resource>\n\n<mcp_prompt>\nPROMPT\n</mcp_prompt>");
    expect(service.calls).toEqual([
      { action: "resource_read", server: "srv", uri: "repo://readme" },
      { action: "prompt_get", server: "srv", name: "review", arguments: { depth: "1" } },
    ]);
    const signal = new AbortController().signal;
    expect(await mcp.tools[0]!.execute({ q: 1 }, { signal })).toBe('{"q":1}');
    await expect(mcp.tools[1]!.execute({}, { signal })).rejects.toMatchObject({
      message: "failed hard",
      toolResult: {
        type: "nod.tool-result",
        text: "failed hard",
        images: [{ type: "image", mimeType: "image/png", data: "QUJD" }],
      },
    });
    await mcp.close();
    expect(service.closed()).toBe(true);
    await expect(createMcpTools(service, { prefix: "bad prefix" })).rejects.toThrow(TypeError);
    await expect(createMcpTools({} as McpService)).rejects.toThrow("MCP service must provide tools() and call()");

    const { agent } = await agentWith([{ toolCalls: [call("m1", "gh_mcp_srv_echo", { x: 2 })] }, { text: "done" }], {
      tools: mcp.tools,
      instructions: mcp.instructions,
    });
    expect((await drain(agent.prompt("use mcp"))).find((e) => e.type === "tool_end")).toEqual({
      type: "tool_end",
      id: "m1",
      name: "gh_mcp_srv_echo",
      content: '{"x":2}',
      isError: false,
    });
    await agent.close();
  });

  test("skills adapter and SKILL.md loading", async () => {
    const dir = join(home, "skills", "review");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "SKILL.md"), '---\nname: review\ndescription: "Review code"\n---\nRead the diff first.\n');
    const record = await loadSkillFile(join(dir, "SKILL.md"));
    expect(record).toEqual({
      name: "review",
      description: "Review code",
      instructions: "Read the diff first.",
      resources: [],
      tools: [],
    });
    writeFileSync(join(home, "plain.md"), "Just text.\n");
    expect((await loadSkillFile(join(home, "plain.md"))).name).toBe("plain");
    writeFileSync(join(home, "broken.md"), "---\nname: x\n");
    await expect(loadSkillFile(join(home, "broken.md"))).rejects.toThrow("missing_closing_delimiter");

    const skills = createSkillsAdapter([
      { ...record, resources: [{ uri: 'a"b', text: "R" }], tools: [lookup] },
      { name: "other", instructions: "O" },
    ]);
    expect(skills.instructions).toBe(
      '<skill name="review">\n<description>Review code</description>\nRead the diff first.\n<resource uri="a&quot;b">\nR\n</resource>\n</skill>\n\n<skill name="other">\nO\n</skill>',
    );
    expect(skills.tools).toEqual([lookup]);
    expect(() => createSkillsAdapter([record, record])).toThrow("duplicate skill name: review");
    expect(() => createSkillsAdapter([{ name: "x", instructions: "y".repeat(64 * 1024) }])).toThrow(RangeError);
    expect(() => createSkillsAdapter([{ name: 1 } as never])).toThrow("skill 0 requires name and instructions");

    const { agent, llm } = await agentWith([{ text: "ok" }], { ...skills });
    await drain(agent.prompt("hi"));
    expect(llm.calls[0]?.[0]?.content).toContain('<skill name="review">');
    await agent.close();
  });
});
