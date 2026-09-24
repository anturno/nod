import { expect, test } from "bun:test";
import type { Completion, Message, StreamEvent } from "../../src/core/agent/types.ts";
import type { CredentialSource } from "../../src/providers/auth/store.ts";
import { codex } from "../../src/providers/codex.ts";
import { grok } from "../../src/providers/grok.ts";
import { buildBody } from "../../src/providers/responses.ts";

const sse = (events: object[]) =>
  new Response(events.map((e) => `event: x\ndata: ${JSON.stringify(e)}\n\n`).join(""), {
    headers: { "content-type": "text/event-stream" },
  });

async function drain(stream: AsyncGenerator<StreamEvent, Completion>) {
  const events: StreamEvent[] = [];
  let r: IteratorResult<StreamEvent, Completion>;
  while (!(r = await stream.next()).done) events.push(r.value);
  return { events, completion: r.value };
}

const history: Message[] = [
  { role: "system", content: "Be brief." },
  { role: "user", content: "hi" },
  { role: "assistant", content: "Looking.", toolCalls: [{ id: "c0", name: "bash", arguments: '{"command":"ls"}' }] },
  { role: "tool", toolCallId: "c0", name: "bash", content: "a.ts" },
];

test("maps messages to Responses input with system messages as instructions", () => {
  expect(buildBody("m", history, [])).toEqual({
    model: "m",
    instructions: "Be brief.",
    input: [
      { role: "user", content: [{ type: "input_text", text: "hi" }] },
      { type: "message", role: "assistant", content: [{ type: "output_text", text: "Looking." }] },
      { type: "function_call", call_id: "c0", name: "bash", arguments: '{"command":"ls"}' },
      { type: "function_call_output", call_id: "c0", output: "a.ts" },
    ],
    store: false,
    stream: true,
  });
  expect(buildBody("m", [], [], { alwaysToolFields: true })).toMatchObject({
    instructions: "You are a helpful assistant.",
    tools: [],
    tool_choice: "auto",
  });
});

test("codex streams text, reasoning and tool calls with subscription headers", async () => {
  let request: Request | undefined;
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    request = new Request(url, init);
    return sse([
      { type: "response.reasoning_summary_text.delta", delta: "Think." },
      { type: "response.output_text.delta", delta: "Run" },
      { type: "response.output_text.delta", delta: "ning." },
      {
        type: "response.output_item.done",
        item: { type: "function_call", call_id: "call_1", name: "bash", arguments: '{"command":"ls"}' },
      },
      { type: "response.completed", response: {} },
    ]);
  }) as typeof fetch;
  const credential: CredentialSource = async () => ({ token: "tok", accountId: "acct" });
  const { events, completion } = await drain(
    codex({ model: "gpt-x", fetcher, credential, sessionId: "sess" }).stream(history, []),
  );

  expect(events).toEqual([
    { type: "reasoning", text: "Think." },
    { type: "text", text: "Run" },
    { type: "text", text: "ning." },
  ]);
  expect(completion).toEqual({
    content: "Running.",
    toolCalls: [{ id: "call_1", name: "bash", arguments: '{"command":"ls"}' }],
  });
  expect(request!.url).toBe("https://chatgpt.com/backend-api/codex/responses");
  expect(Object.fromEntries(request!.headers)).toMatchObject({
    authorization: "Bearer tok",
    "chatgpt-account-id": "acct",
    originator: "nod",
    "session-id": "sess",
  });
  const body = await request!.json();
  expect(body).toMatchObject({
    model: "gpt-x",
    tool_choice: "auto",
    parallel_tool_calls: true,
    reasoning: { summary: "auto" },
  });
  expect(body).not.toHaveProperty("max_output_tokens");
});

test("a 401 forces one refresh and replays the request", async () => {
  const modes: string[] = [];
  const credential: CredentialSource = async (mode) => (
    modes.push(mode), { token: mode === "force" ? "fresh" : "stale", accountId: "acct" }
  );
  const auths: string[] = [];
  const fetcher = (async (_: RequestInfo | URL, init?: RequestInit) => {
    const auth = new Headers(init?.headers).get("authorization")!;
    auths.push(auth);
    return auth === "Bearer stale"
      ? new Response("{}", { status: 401 })
      : sse([{ type: "response.output_text.delta", delta: "ok" }, { type: "response.completed" }]);
  }) as typeof fetch;
  const { completion } = await drain(codex({ model: "m", fetcher, credential }).stream([], []));
  expect(completion.content).toBe("ok");
  expect(modes).toEqual(["if_needed", "force"]);
  expect(auths).toEqual(["Bearer stale", "Bearer fresh"]);

  const always401 = (async () =>
    new Response(JSON.stringify({ detail: "Unauthorized" }), { status: 401 })) as unknown as typeof fetch;
  expect(codex({ model: "m", fetcher: always401, credential }).stream([], []).next()).rejects.toThrow(
    "ChatGPT (401): Unauthorized",
  );
});

test("a failed response is thrown", async () => {
  const fetcher = (async () =>
    sse([{ type: "response.failed", response: { error: { message: "quota exceeded" } } }])) as unknown as typeof fetch;
  const credential: CredentialSource = async () => ({ token: "t", accountId: "a" });
  expect(codex({ model: "m", fetcher, credential }).stream([], []).next()).rejects.toThrow("quota exceeded");
});

test("grok sends CLI headers and omits tool fields without tools", async () => {
  let request: Request | undefined;
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    if (String(url) === "https://x.ai/cli/stable") return new Response("1.2.3\n");
    request = new Request(url, init);
    return sse([{ type: "response.completed" }]);
  }) as typeof fetch;
  const credential: CredentialSource = async () => ({ token: "tok", accountId: "user-7" });
  await drain(
    grok({ model: "grok-x", fetcher, credential, sessionId: "conv" }).stream([{ role: "user", content: "hi" }], []),
  );

  expect(request!.url).toBe("https://cli-chat-proxy.grok.com/v1/responses");
  expect(Object.fromEntries(request!.headers)).toMatchObject({
    "x-xai-token-auth": "xai-grok-cli",
    "x-grok-client-version": "1.2.3",
    "x-grok-model-override": "grok-x",
    "x-grok-user-id": "user-7",
    "x-grok-conv-id": "conv",
  });
  const body = await request!.json();
  expect(body).not.toHaveProperty("tools");
  expect(body).not.toHaveProperty("tool_choice");
});
