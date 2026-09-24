---
title: "SDK API reference"
description: "Interfaces, options, methods, return types, and events for the nod SDK."
---

# SDK API reference

This page documents the TypeScript API exported by `@anturno/nod/sdk`. Unlike the CLI, every interface below is a real exported type. For setup and examples, see the [Bun SDK](https://nod.anturno.cloud/docs/lib/node.md) guide.

## API index

**[Agent](#agent)**

| Function or method | Returns | Purpose |
| --- | --- | --- |
| [`createAgent(options)`](#createagent) | [`Promise<Agent>`](#agent) | Create one conversation. |
| [`agent.prompt(input, options?)`](#agentprompt) | [`Turn`](#turn) | Run a prompt and stream events. |
| [`agent.checkpoint()`](#agentcheckpoint) | `Promise<Uint8Array>` | Export conversation history and usage. |
| [`agent.close()`](#agentclose) | `Promise<void>` | Stop the agent and release its runtime. |

**[Turn](#turn)**

| Function or method | Returns | Purpose |
| --- | --- | --- |
| [`turn.cancel()`](#turncancel) | `void` | Cancel the active turn. |

**[TerminalRuntime](#terminalruntime)**

| Function or method | Returns | Purpose |
| --- | --- | --- |
| [`createTerminal(options)`](#createterminal) | [`Promise<TerminalRuntime>`](#terminalruntime) | Start the interactive terminal. |
| [`terminal.write(data)`](#terminalruntime) | `void` | Send terminal input. |
| [`terminal.resize()`](#terminalruntime) | `void` | Notify nod of a size change. |
| [`terminal.abort()`](#terminalruntime) | `void` | Stop the terminal and release listeners. |

**[McpTools](#mcptools)**

| Function or method | Returns | Purpose |
| --- | --- | --- |
| [`createMcpTools(client, options?)`](#createmcptools) | [`Promise<McpTools>`](#createmcptools) | Convert an MCP client's tools and context. |
| [`mcp.close()`](#createmcptools) | `Promise<void>` | Close the adapter and its client. |

**[SkillsAdapter](#skillsadapter)**

| Function or method | Returns | Purpose |
| --- | --- | --- |
| [`createSkillsAdapter(records)`](#createskillsadapter) | [`SkillsAdapter`](#createskillsadapter) | Convert loaded skill records. |
| [`loadSkillFile(path, options?)`](#loadskillfile) | [`Promise<SkillRecord>`](#createskillsadapter) | Read one skill file. |

**[Helpers](#helpers)**

| Function or method | Returns | Purpose |
| --- | --- | --- |
| [`listModels(options)`](#listmodels) | `Promise<string[]>` | List available model IDs. |
| [`xtermAdapter(term)`](#xtermadapter) | [`TerminalAdapter`](#terminaladapter) | Connect an xterm.js instance. |
| [`encodeXtermKeyEvent(event)`](#encodextermkeyevent) | `string \| null` | Encode special terminal keys. |

## Imports

```ts
import {
  createAgent,
  createTerminal,
  createMcpTools,
  createSkillsAdapter,
  loadSkillFile,
  listModels,
  sdkApiVersion,
} from "@anturno/nod/sdk";

import { xtermAdapter, encodeXtermKeyEvent } from "@anturno/nod/sdk/xterm";
```

`@anturno/nod/sdk` runs on Bun. `@anturno/nod/sdk/xterm` has no Bun dependency and is meant for a browser bundle. `sdkApiVersion` is currently `1`; it identifies the API revision, not the package version.

## Interfaces

| Interface | Describes |
| --- | --- |
| [`AgentOptions`](#agentoptions) | Credentials, model, instructions, tools, permissions, workspace, and checkpoint input. |
| [`Agent`](#agent) | The conversation's methods. |
| [`PromptInput` and `PromptOptions`](#promptinput-and-promptoptions) | Text, resources, images, and cancellation. |
| [`Turn`](#turn) | An event stream, result promise, and cancel method. |
| [`TurnEvent`](#turnevent) | Text, reasoning, and tool events. |
| [`TurnResult` and `Usage`](#turnresult-and-usage) | Stop reason and token counts. |
| [`HostTool`](#hosttool) | A tool's schema and execution callback. |
| [`ApprovalRequest` and `ApprovalDecision`](#permissions) | What the permission callback receives and returns. |
| [`DiagnosticEvent`](#diagnosticevent) | Runtime diagnostics sent to `onEvent`. |
| [`TerminalOptions`](#terminaloptions) | Terminal adapter, configuration, and stores. |
| [`TerminalRuntime`](#terminalruntime) | Terminal readiness, exit, and control methods. |
| [`TerminalAdapter`](#terminaladapter) | Input, output, and geometry supplied by your UI. |
| [`McpTools`](#createmcptools) | Adapted tools, instructions, and cleanup. |
| [`SkillRecord` and `SkillsAdapter`](#createskillsadapter) | Loaded skill text, resources, and tools. |

Shared notation used below:

```ts
type MaybePromise<T> = T | Promise<T>;
type Bytes = ArrayBuffer | ArrayBufferView;
type Fetch = typeof globalThis.fetch;
type Provider = "codex" | "grok";
type Auth = { provider: Provider } | { provider: Provider; token: string };
```

`{ provider }` reads the session saved by `nod login` under `~/.nod` (or `NOD_HOME`) and refreshes it when needed. `{ provider, token }` uses a subscription access token the host obtained itself and never touches disk.

## Agent

```ts
interface Agent {
  prompt(input: PromptInput, options?: PromptOptions): Turn;
  checkpoint(): Promise<Uint8Array>;
  close(): Promise<void>;
}
```

An agent has no `createSession()`, `setModel()`, or `history` property. To change creation options, save a checkpoint and restore it into a new agent with those options.

### createAgent

```ts
createAgent(options: AgentOptions): Promise<Agent>
```

Creates one in-memory conversation. The promise resolves after credential resolution and any checkpoint restore finish. No model request is made until the first prompt.

#### AgentOptions

```ts
interface AgentOptions {
  auth: Auth;
  model?: string;
  effort?: "auto" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
  instructions?: string | string[];
  tools?: HostTool[];
  checkpoint?: Bytes;
  fetch?: Fetch;
  onEvent?: (event: DiagnosticEvent) => void;
  permissions?: (request: ApprovalRequest, signal: AbortSignal) => MaybePromise<ApprovalDecision>;
  workspace?: { cwd: string; shell?: ShellRunner };
}
```

| Option | Required | Default | Behavior |
| --- | --- | --- | --- |
| `auth` | Yes | None | Provider and, optionally, a token. See [Auth](#interfaces). |
| `model` | No | The provider default | Model ID, at most 1 KiB of UTF-8. |
| `effort` | No | `"auto"` | Reasoning effort, when the model supports it. |
| `instructions` | No | No system message | Complete system instructions. An array joins non-empty entries with blank lines. At most 64 KiB of UTF-8 after joining. |
| `tools` | No | `[]` | Up to 64 explicit [host tools](#hosttool). No CLI tools are enabled automatically. |
| `checkpoint` | No | New conversation | Opaque bytes from `agent.checkpoint()`. The input is copied. |
| `fetch` | No | `globalThis.fetch` | Host-controlled HTTP transport. Preserve the supplied `AbortSignal`. |
| `onEvent` | No | None | Synchronous diagnostic callback. Model output is on the Turn stream instead. |
| `permissions` | No | Deny everything | Called for every sensitive built-in call when `workspace` is set. See [Permissions](#permissions). |
| `workspace` | No | None | Enables nod's built-in file and shell tools rooted at `cwd`. `shell` replaces the command runner. |

Do not pass `env`: the agent rejects it. Terminal settings, session stores, and CLI permission modes are not agent configuration.

Invalid options reject creation. A missing saved session for `auth.provider` and invalid checkpoints also reject the promise. See [Errors](#errors).

### agent.prompt

```ts
agent.prompt(input: PromptInput, options?: PromptOptions): Turn
```

Starts a turn in the conversation and returns a `Turn` immediately, not a promise. Read events with `for await`, then await `turn.result`.

```ts
import { createAgent } from "@anturno/nod/sdk";

const agent = await createAgent({ auth: { provider: "codex" } });
try {
  const turn = agent.prompt("Explain this schema.");
  for await (const event of turn) {
    if (event.type === "text_delta") process.stdout.write(event.delta);
  }
  const result = await turn.result;
  console.log(result.stopReason, result.usage);
} finally {
  await agent.close();
}
```

#### PromptInput and PromptOptions

```ts
type PromptInput = string | PromptBlock[];
type PromptBlock =
  | { type: "text"; text: string }
  | { type: "resource"; resource: { uri: string; text?: string } }
  | { type: "image"; mimeType: string; data: string };

interface PromptOptions {
  signal?: AbortSignal;
}
```

A string is equivalent to one text block. For a resource, pass its text explicitly; the URI identifies the resource and does not grant file access. Image blocks carry base64 `data` in PNG, JPEG, GIF, or WebP, up to eight per prompt and 5 MiB each. Audio blocks are not supported.

```ts
const turn = agent.prompt(
  [
    { type: "text", text: "Summarize this file." },
    {
      type: "resource",
      resource: {
        uri: "file:///workspace/schema.sql",
        text: "CREATE TABLE users (id INTEGER PRIMARY KEY);",
      },
    },
  ],
  { signal: controller.signal },
);
```

`prompt()` throws synchronously for malformed input, a closed agent, or another active prompt. An already-aborted signal returns a cancelled turn without making a model request or changing history. Network and runtime failures during execution reject the stream or result promise.

### agent.checkpoint

```ts
agent.checkpoint(): Promise<Uint8Array>
```

Returns opaque, versioned conversation bytes while the agent is idle. It rejects while a prompt is active or after the agent closes. Store the bytes without editing them and restore them only through `createAgent({ checkpoint, ...options })`. The format is the same recovery checkpoint the CLI writes for a session.

A checkpoint contains history and usage, not credentials, model selection, instructions, tools, MCP clients, or skills. Resupply those options on restoration. Protect stored checkpoints as conversation data.

```ts
const checkpoint = await agent.checkpoint();
await agent.close();
const restored = await createAgent({
  auth: { provider: "codex" },
  checkpoint,
});
// Continue with restored.prompt(...), then await restored.close().
```

### agent.close

```ts
agent.close(): Promise<void>
```

Cancels an active turn, releases blocked output, and waits for the runtime to exit. Repeated calls are safe. The agent cannot be prompted or checkpointed afterward. Closing an agent does not close host-owned database connections or MCP clients.

## Turn

```ts
interface Turn extends AsyncIterable<TurnEvent> {
  result: Promise<TurnResult>;
  cancel(): void;
}
```

A turn permits one event consumer. Read the stream even when you only need the result:

```ts
const turn = agent.prompt("Summarize the discussion.");
for await (const _ of turn) {
}
const result = await turn.result;
```

A slow reader pauses output production instead of growing an unlimited queue. Awaiting only `turn.result` can stall while unread events wait to be consumed. Breaking out of the iterator cancels the turn. Do not start another prompt until the current one settles.

### turn.cancel

```ts
turn.cancel(): void
```

Requests cancellation without waiting for completion. It aborts model requests and the signals passed to host tools. Continue draining the stream and await `turn.result` to observe completion. Calling `cancel()` again, or after the turn finishes, has no effect.

```ts
const controller = new AbortController();
const turn = agent.prompt("Review the schema.", { signal: controller.signal });
controller.abort(); // Equivalent to requesting cancellation with turn.cancel().
for await (const _ of turn) {
}
console.log((await turn.result).stopReason);
```

Cancellation stops waiting for tool callbacks; it cannot stop JavaScript work that ignores its signal. Late tool results and rejections are ignored.

### TurnEvent

```ts
type TurnEvent =
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_start"; id: string; name: string }
  | {
      type: "tool_end";
      id: string;
      name: string;
      content?: string;
      isError: boolean;
    };
```

| Event | Fields | Meaning |
| --- | --- | --- |
| `text_delta` | `delta` | Append this text to the answer. |
| `reasoning_delta` | `delta` | Reasoning text when the provider supplies it. |
| `tool_start` | `id`, `name` | A tool call started. |
| `tool_end` | `id`, `name`, `content?`, `isError` | A tool call completed or failed. Match it to its start by `id`. |

`tool_end.content` is the available text result, not the original JavaScript return value. There is no separate final-result event; use `turn.result` after reading the stream.

### TurnResult and Usage

```ts
interface TurnResult {
  stopReason: StopReason;
  usage: Usage;
}

type StopReason = "end_turn" | "max_output_tokens" | "max_model_turns" | "refused" | "cancelled";

interface Usage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
}
```

| Stop reason | Meaning |
| --- | --- |
| `end_turn` | The turn ended normally. |
| `max_output_tokens` | The response reached its output-token limit. |
| `max_model_turns` | The turn reached its model-step limit. |
| `refused` | The model refused the request. |
| `cancelled` | The turn was cancelled. |

`usage` is always an object. Its fields are optional: missing counts are omitted, not replaced with zero. A prompt cancelled before it starts returns `{ stopReason: "cancelled", usage: {} }`. Transport or decoding failures reject rather than returning a successful result with missing output.

## HostTool

```ts
type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

interface HostTool {
  name: string;
  description: string;
  inputSchema: Record<string, JsonValue>;
  execute(input: unknown, context: { signal: AbortSignal }): MaybePromise<JsonValue | undefined | RichToolResult>;
}

interface RichToolResult {
  type: "nod.tool-result";
  text: string;
  images: Array<{ type: "image"; mimeType: string; data: string }>;
  isError?: boolean;
}
```

Tool names must be unique, contain 1–64 letters, digits, underscores, or hyphens, and have a JSON-serializable object schema. Your callback must validate and authorize actions before executing them.

Strings return as text. Other ordinary results are JSON-encoded; `undefined` becomes `"null"`. A thrown error becomes a failed tool result with its message. Use `RichToolResult` for image results: `data` is base64, with PNG, JPEG, GIF, and WebP supported. Ordinary objects are not interpreted as images.

Up to eight images are allowed, each with at most 5 MiB of base64 data and an 8 MiB serialized rich-result limit. Keep tool results small and honor `context.signal`.

## Permissions

```ts
interface ApprovalRequest {
  toolName: string;
  label: string;
  kind: "command" | "file" | "mcp" | "other" | "confirm";
  detail?: string;
  preparation?: string;
  targets: string[];
  suggestedGrants: string[];
}

interface ApprovalDecision {
  outcome: "once" | "always" | "deny";
  note?: string;
}
```

The callback runs only for built-in tools enabled by `workspace`, and only for calls the CLI would also stop on: file changes, commands, and external paths. `once` runs the call; `always` runs it and grants `suggestedGrants` for the rest of the agent's life; `deny` refuses it, and `note` is returned to the model with the refusal. The callback receives the turn's `AbortSignal`; a cancelled turn aborts a pending decision. Without a callback every request is denied.

## TerminalRuntime

```ts
interface TerminalRuntime {
  interactive: Promise<void>;
  exited: Promise<number>;
  write(data: string | Uint8Array): void;
  resize(): void;
  abort(): void;
}
```

| Member | Behavior |
| --- | --- |
| `interactive` | Resolves after the terminal reaches its input loop and optional adapter `drain()` finishes. Rejects if nod exits before reaching that loop or draining fails. |
| `exited` | Resolves with the exit code. An explicit abort uses `130`. |
| `write(data)` | Sends text or bytes as input. Ctrl+C string input also cancels host effects; it does not immediately destroy the runtime. |
| `resize()` | Wakes nod to read the adapter's current `cols` and `rows`. It takes no dimensions. |
| `abort()` | Stops the runtime and releases data, key, and resize subscriptions. Returns immediately; await `exited` for the exit code. |

### createTerminal

```ts
createTerminal(options: TerminalOptions): Promise<TerminalRuntime>
```

Starts the interactive terminal, not a headless `Agent`. It runs the same Ink interface as the `nod` command, in-process, drawing to your adapter instead of a TTY. Await `runtime.interactive` before sending input.

#### TerminalOptions

```ts
interface TerminalOptions {
  terminal: TerminalAdapter;
  env?: Record<string, string>;
  args?: string[];
  fetch?: Fetch;
  onEvent?: (event: DiagnosticEvent) => void;
  interruptKey?: string;
  configStore?: ConfigStore;
  promptHistoryStore?: PromptHistoryStore;
  sessionStore?: SessionStore;
  oauthSessionStore?: OAuthSessionStore;
  openUrl?: (url: string) => MaybePromise<boolean>;
  workspace?: WorkspaceAdapter;
}
```

| Option | Default | Behavior |
| --- | --- | --- |
| `terminal` | Required | UI adapter for input, output, and size. |
| `env` | `process.env` | Terminal environment, including `NOD_HOME`, `NOD_MODEL`, or `NOD_PERMISSION_MODE`. |
| `args` | `[]` | Terminal CLI arguments, such as `["--resume", "last"]`. |
| `fetch` | `globalThis.fetch` | Host HTTP transport. |
| `onEvent` | None | Diagnostic callback. |
| `interruptKey` | `"\x03"` (Ctrl+C) | String input containing this key also cancels active host effects. `""` disables this detection. |
| Stores, `openUrl`, `workspace` | Files under `~/.nod` | Optional terminal host integrations listed below. |

Store methods can return their value directly or in a promise. See [Terminal embedding](https://nod.anturno.cloud/docs/lib/terminal.md) for method signatures and revision rules:

| Interface | Contract |
| --- | --- |
| `ConfigStore` | [`get(id)` and `set(id, value)`](https://nod.anturno.cloud/docs/lib/terminal.md#config-store) |
| `PromptHistoryStore` | [`load`, `append`, and `clear`](https://nod.anturno.cloud/docs/lib/terminal.md#prompt-history-store) |
| `SessionStore` | [`load`, `commit`, `list`, and `remove`](https://nod.anturno.cloud/docs/lib/terminal.md#session-store) |
| `OAuthSessionStore` | [`load`, `commit`, and `remove`](https://nod.anturno.cloud/docs/lib/terminal.md#device-login) |
| `WorkspaceAdapter` | [`info`, `permission`, and `exec`](https://nod.anturno.cloud/docs/lib/terminal.md#workspace-adapter) |

When a store is omitted, the terminal uses the same files the CLI uses under `~/.nod`. These stores do not configure a headless agent. Use agent creation options and checkpoints instead.

### TerminalAdapter

```ts
interface TerminalAdapter {
  readonly cols: number;
  readonly rows: number;
  write(bytes: Uint8Array): void;
  onData(callback: (data: string) => void): () => void;
  onResize(callback: () => void): () => void;
  onKeyData?(callback: (data: string) => void): () => void;
  drain?(): MaybePromise<void>;
}
```

Subscription methods return unsubscribe functions. Keep dimensions current before emitting a resize. Use `drain()` when your UI needs to flush pending output before the terminal is considered interactive. The standard xterm adapter handles the subscriptions for you.

## McpTools

### createMcpTools

```ts
createMcpTools(client: McpClient, options?: McpOptions): Promise<McpTools>

interface McpOptions {
  prefix?: string;
  resources?: string[];
  prompts?: Array<string | { name: string; arguments?: Record<string, string> }>;
}

interface McpTools {
  tools: HostTool[];
  instructions: string;
  close(): Promise<void>;
}
```

`McpClient` is your already-connected client: a nod `McpRuntime`, or any object implementing `listTools()` and `callTool(params, resultSchema?, options?)`, such as an MCP TypeScript SDK v1 client. Resource options also require `readResource({ uri })`; prompt options require `getPrompt({ name, arguments? })`.

| Option | Default | Behavior |
| --- | --- | --- |
| `prefix` | `""` | Prefix for model-facing tool names; letters, digits, underscores, and hyphens only. |
| `resources` | `[]` | Resource URIs whose text is added to instructions. |
| `prompts` | `[]` | Prompt names or name/arguments objects whose text is added to instructions. |

Creation lists tools, follows pagination, and fetches the requested context. More than 64 tools, invalid or repeated cursors, duplicate original tool names, or instructions larger than 64 KiB fail creation. Tool names are normalized for model APIs; calls to the client retain the original names. Non-text prompt/resource context is replaced with an omission notice.

Pass `mcp.tools` and `mcp.instructions` into `createAgent()`. Tool cancellation reaches the client's third `callTool` argument as `{ signal }`. `mcp.close()` calls `client.close()` if supplied, once. Close the agent first. The host chooses and authenticates the client and remains responsible for transport setup.

## SkillsAdapter

### createSkillsAdapter

```ts
createSkillsAdapter(records: SkillRecord[]): SkillsAdapter

interface SkillRecord {
  name: string;
  description?: string;
  instructions: string;
  resources?: Array<{ uri: string; text: string }>;
  tools?: HostTool[];
}

interface SkillsAdapter {
  instructions: string;
  tools: HostTool[];
}
```

Combines up to 64 loaded records into instructions and a tool array. Skill names must be unique. Resource text is included directly; this function does not fetch resources or read files. Invalid records, duplicate names, or combined instructions larger than 64 KiB throw. Pass the returned fields into `createAgent({ auth, ...skills })`.

### loadSkillFile

```ts
loadSkillFile(path: string, options?: LoadSkillOptions): Promise<SkillRecord>

interface LoadSkillOptions {
  readFile?: (path: string, encoding: "utf8") => MaybePromise<string>;
  resources?: Array<{ uri: string; text: string }>;
  tools?: HostTool[];
}
```

Reads one file as UTF-8 using Bun's file API, or the supplied function. It uses the same `SKILL.md` frontmatter parser as the CLI: `name` and `description`, with the remaining text as instructions. Without a name, it uses the filename without `.md`. It does not scan directories or load referenced files. File errors and unterminated frontmatter reject the promise.

## Helpers

### listModels

```ts
listModels(options: ListModelsOptions): Promise<string[]>

interface ListModelsOptions {
  auth: Auth;
  fetch?: Fetch;
}
```

Returns sorted, unique model IDs for the provider in `auth`. `fetch` defaults to the global implementation. This performs one catalog request to the provider without creating an agent. The promise rejects on invalid options, a missing session, or a failed HTTP response. Agent creation does not call this function automatically.

### xtermAdapter

```ts
xtermAdapter(term: import("@xterm/xterm").Terminal): TerminalAdapter
```

Wraps an xterm.js terminal and forwards input, output, geometry, and resize notifications. It installs a custom key handler for nod-specific key encodings when xterm supports that hook. The host still owns opening and disposing the xterm.js instance.

### encodeXtermKeyEvent

```ts
encodeXtermKeyEvent(event: KeyboardEvent): string | null
```

Returns an escape sequence for Shift+Enter (`\x1b[13;2u`) and supported Meta+Backspace (`\x1b\x7f`) or Meta+arrow (`\x1bb`, `\x1bf`) key combinations. Returns `null` for keys it does not handle, non-keydown events, or Alt/Ctrl combinations. `null` means the terminal should use its normal handling.

## DiagnosticEvent

`onEvent` receives runtime diagnostics, not the `TurnEvent` stream:

```ts
interface DiagnosticEvent {
  type: string;
  timestamp: number;
  [detail: string]: unknown;
}
```

`timestamp` is milliseconds from `performance.now()`, not a Unix timestamp. The callback runs synchronously; exceptions thrown by it are ignored. Treat event-specific fields as diagnostics rather than the answer/result API.

| Event | Additional fields |
| --- | --- |
| `runtime.start`, `runtime.ready` | Terminal events include `surface: "terminal"`. |
| `runtime.exit` | `code`; terminal events also include `surface`. |
| `transport.start` | `attempt`, `method`, `endpoint`, `model` when selected. |
| `transport.response` | `attempt`, `status`, `elapsedMs`, `requestId`, `model`, `provider`. Header-derived values can be `null` or absent. |
| `transport.error` | `attempt`, `elapsedMs`, `error` (error name). |
| `transport.retry` | `attempt`, `nextAttempt`, `elapsedMs`, `error`. |
| `output.backpressure` | `bufferedBytes`, `bufferedEvents`. |
| `permission.request`, `permission.decision` | `toolName`, `kind`, and the decision `outcome`. |
| `terminal.resize`, `terminal.size` | `cols`, `rows`. |

Transport metadata omits credentials and raw headers, but events can name tools and models. Do not log the entire diagnostic stream as if it were free of sensitive data.

## Errors

| Operation | Failure behavior |
| --- | --- |
| `createAgent`, `createTerminal` | Reject on invalid options, a missing saved session for the provider, or initialization failure. |
| `agent.prompt` | Throws for invalid input, a closed agent, or a concurrent prompt. |
| Turn iteration and `turn.result` | Reject on transport, decoding, or runtime failure. Normal cancellation resolves with `stopReason: "cancelled"`. |
| `agent.checkpoint` | Rejects during an active turn, after close, or if export fails. |
| `listModels` | Rejects invalid options, a missing session, or HTTP errors. |
| Host tool callback | A thrown error is sent to the model as a failed tool result. |
| Session stores | A stale revision throws an error whose `code` is `NOD_SESSION_REVISION_CONFLICT` or `NOD_OAUTH_SESSION_REVISION_CONFLICT`. |

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
