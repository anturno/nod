---
title: "Bun SDK"
description: "Embed the nod agent in a Bun application."
---

# Bun SDK

The `@anturno/nod/sdk` entry point embeds the nod agent in a Bun application. It runs in-process: no addon, no WebAssembly, no child process.

Start with the [readline chat or HTTP examples](https://nod.anturno.cloud/docs/lib/examples.md) for a runnable application. For method signatures, options, return types, and events, see the [API reference](https://nod.anturno.cloud/docs/lib/api.md).

## Install

```bash
bun add github:anturno/nod
```

The SDK requires Bun 1.4 or later. Its only runtime dependencies are the ones the CLI already has.

## Run a headless agent

One agent owns one in-memory conversation with three methods: `prompt()`, `checkpoint()`, and `close()`.

Sign in once with `nod login codex` or `nod login grok` before running this example; the SDK reuses that saved session.

```ts
import { createAgent } from "@anturno/nod/sdk";

const agent = await createAgent({
  auth: { provider: "codex" },
});

try {
  const turn = agent.prompt("Explain how a database index speeds up a query.");
  for await (const event of turn) {
    if (event.type === "text_delta") process.stdout.write(event.delta);
  }
  console.log(await turn.result); // { stopReason, usage }
} finally {
  await agent.close();
}
```

`auth` is required. `model` is optional and defaults to the provider's default. Agent options are named fields; `env` is only for `createTerminal()`.

A prompt accepts a string or text/resource blocks. Its stream emits `text_delta`, `reasoning_delta` when available, `tool_start`, and `tool_end`. Runtime diagnostics go to the optional `onEvent` callback, separately from model output.

Consume the stream before awaiting `turn.result`. Output is lossless and backpressured: a slow consumer pauses production. Waiting only for the result can stall on unread output. If you do not need events, drain them with `for await (const _ of turn) {}`.

Only one prompt can run at a time, and a turn has one event consumer. Breaking out of the iterator cancels the turn. You can also call `turn.cancel()`, close the agent, or pass an `AbortSignal`:

```ts
const controller = new AbortController();
const turn = agent.prompt("Wait for more instructions.", {
  signal: controller.signal,
});
controller.abort();
for await (const _ of turn) {
}
console.log((await turn.result).stopReason); // "cancelled"
```

An already-aborted signal makes no model request and does not change history. Transport or decoding failures reject the result. The SDK retries a retryable transport failure at most once, only before it delivers model output or performs tool actions. Cancellation prevents retries.

## Save and restore a conversation

Call `checkpoint()` when the agent is idle. It returns opaque, versioned bytes containing conversation history and usage. Your application owns storage:

```ts
const checkpoint = await agent.checkpoint();
await agent.close();

const restored = await createAgent({
  auth: { provider: "codex" },
  checkpoint,
});
// Continue with restored.prompt(...), then close the restored agent.
```

Restore only into a new agent. Credentials, model selection, instructions, tools, MCP clients, and skills are not in the checkpoint; resupply them when restoring. The terminal's `sessionStore` and `configStore` are not agent options.

## What the embedded agent can do

By default the embedded agent does not inherit the CLI's filesystem, shell, or built-in tools. Supply host tools explicitly:

```ts
const agent = await createAgent({
  auth: { provider: "codex" },
  instructions: "Use lookup to answer questions about product codes.",
  tools: [
    {
      name: "lookup",
      description: "Look up a product code.",
      inputSchema: {
        type: "object",
        properties: { code: { type: "string" } },
        required: ["code"],
      },
      async execute(input, { signal }) {
        return database.lookup(input.code, { signal });
      },
    },
  ],
});
```

`database` is your application's data client. Your application must validate and authorize actions inside `execute()`; host tools do not go through the permission callback. Cancellation aborts the tool's signal and stops waiting for its result. Tool callbacks must stop their own work when cancelled; late results and rejections are ignored.

`instructions` is the complete host-owned system context, limited to 64 KiB of UTF-8 including adapter text. The SDK adds no hidden base prompt. Without instructions, it sends no system message.

### Give the agent a workspace

Pass `workspace` to enable nod's built-in file and shell tools rooted at a directory:

```ts
const agent = await createAgent({
  auth: { provider: "codex" },
  workspace: { cwd: "/absolute/path/to/project" },
  permissions(request) {
    return request.kind === "file" ? { outcome: "once" } : { outcome: "deny" };
  },
});
```

Every sensitive built-in call, such as editing a file or running a command, is routed through `permissions` with the same [`ApprovalRequest`](https://nod.anturno.cloud/docs/lib/api.md#permissions) the CLI shows you. The default callback denies everything, so a workspace without a callback is read-only. `workspace.shell` supplies your own command runner when the host should execute commands instead of nod.

> **The embedded core is not the CLI**
>
> Importing the SDK does not grant operating-system access. Authority comes from the host tools you supply, or from a `workspace` you opt into and gate with `permissions`.

## Connect MCP and skills

`createMcpTools` adapts an already-connected, host-owned MCP client:

```ts
import { createAgent, createMcpTools } from "@anturno/nod/sdk";

const mcp = await createMcpTools(client, {
  prefix: "github_",
  resources: ["repo://instructions"],
  prompts: ["review"],
});
const agent = await createAgent({
  auth: { provider: "codex" },
  tools: mcp.tools,
  instructions: mcp.instructions,
});
// Run prompts, then close the agent and adapter.
await agent.close();
await mcp.close();
```

Your app owns `client`, its transport, authentication, elicitation, and connection cleanup. `client` can be a nod `McpRuntime` or any object implementing `listTools()` and `callTool(params, resultSchema?, options?)`, including an MCP TypeScript SDK v1 client. Tool catalogs support pagination up to 64 tools; text and structured results reach the model together. Tool images reach the model as images.

Use `createSkillsAdapter` for loaded skill records, or explicitly load a file:

```ts
import { createAgent, createSkillsAdapter, loadSkillFile } from "@anturno/nod/sdk";

const record = await loadSkillFile("./skills/review/SKILL.md");
const skills = createSkillsAdapter([record]);
const agent = await createAgent({
  auth: { provider: "codex" },
  ...skills,
});
```

The host chooses which skills to load; the agent does not scan directories automatically.

## HTTP routes

The agent works inside any Bun HTTP handler. Create it per request, or keep one per conversation and restore it from a checkpoint:

```ts
import { createAgent } from "@anturno/nod/sdk";

Bun.serve({
  async fetch(request) {
    const { prompt } = await request.json();
    const agent = await createAgent({ auth: { provider: "codex" } });
    try {
      let text = "";
      const turn = agent.prompt(prompt, { signal: request.signal });
      for await (const event of turn) {
        if (event.type === "text_delta") text += event.delta;
      }
      await turn.result;
      return Response.json({ text });
    } finally {
      await agent.close();
    }
  },
});
```

Add your application's authentication, input validation, and request limits around the route.

## Choose an entry point

| Import | Loads |
| --- | --- |
| `@anturno/nod/sdk` | `createAgent()`, `createTerminal()`, `createMcpTools()`, `createSkillsAdapter()`, `loadSkillFile()`, `listModels()`, and `sdkApiVersion` |
| `@anturno/nod/sdk/xterm` | `xtermAdapter()` and `encodeXtermKeyEvent()` for a browser page |

Importing the SDK does not connect to MCP servers, scan skills, spawn processes, or read workspace files.

## Discover models

```ts
import { listModels } from "@anturno/nod/sdk";

const models = await listModels({ auth: { provider: "codex" } });
```

`listModels()` returns sorted, unique model IDs with one catalog request to the provider. It accepts an optional `fetch` override and does not create an agent. Agent creation does not fetch the model catalog.

## Security boundaries

Your application controls credentials, tool execution, and network access. Keep provider tokens on the server, validate and authorize tool inputs, honor cancellation in your callbacks, and gate any `workspace` with a `permissions` callback that reflects what your users allowed.

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
