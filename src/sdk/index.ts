/** @anturno/nod/sdk: the agent in-process (one conversation: prompt, checkpoint, close), host tools, MCP and skills adapters. */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { type StopReason, stopReasonFor } from "../acp/types.ts";
import { assembleRuntime, type ModelBinding, type Runtime } from "../cli/runtime.ts";
import { decodeCheckpoint, encodeCheckpoint } from "../core/agent/checkpoint.ts";
import type { AgentEvent } from "../core/agent/loop.ts";
import type { Effort, ImageRef, LLM, UserTurn } from "../core/agent/types.ts";
import { loadConfig } from "../core/config/resolve.ts";
import type { McpService } from "../core/mcp/types.ts";
import type { ApprovalDecision, ApprovalRequest } from "../core/permissions/index.ts";
import { parseSkillFile } from "../core/skills/frontmatter.ts";
import type { ToolResult, ToolSpec } from "../core/tools/spec.ts";
import { resolveAccess } from "../core/workspace/access.ts";
import type { CredentialSource } from "../providers/auth/store.ts";
import { codex, codexModels } from "../providers/codex.ts";
import { grok, grokModels } from "../providers/grok.ts";
import { type Provider, subscriptions } from "../providers/providers.ts";

export { createTerminal, type TerminalAdapter, type TerminalOptions, type TerminalRuntime } from "./terminal.ts";
export { encodeXtermKeyEvent, xtermAdapter } from "./xterm.ts";
export type { StopReason };

export const sdkApiVersion = 1;

export const MAX_TOOLS = 64;
export const MAX_INSTRUCTIONS_BYTES = 64 * 1024;
export const MAX_IMAGES = 8;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
export const MAX_RESULT_BYTES = 8 * 1024 * 1024;
const MAX_UNREAD_EVENTS = 256;
const MAX_UNREAD_BYTES = 1024 * 1024;

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type ToolImage = { type: "image"; mimeType: string; data: string };
export type RichToolResult = { type: "nod.tool-result"; text: string; images: ToolImage[]; isError?: boolean };
export type HostTool = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  execute(
    input: unknown,
    context: { signal: AbortSignal },
  ): JsonValue | undefined | RichToolResult | Promise<JsonValue | undefined | RichToolResult>;
};

export type Auth = { provider: Provider; token?: string };
export type DiagnosticEvent = { type: string; timestamp: number; [detail: string]: unknown };
export type PermissionHandler = (
  request: ApprovalRequest,
  signal?: AbortSignal,
) => ApprovalDecision | Promise<ApprovalDecision>;

export type AgentOptions = {
  auth: Auth;
  model?: string;
  effort?: Effort;
  instructions?: string | string[];
  tools?: HostTool[];
  checkpoint?: Uint8Array | ArrayBuffer;
  fetch?: typeof fetch;
  onEvent?: (event: DiagnosticEvent) => void;
  /** Decides the built-in tools' sensitive actions. Default: deny. */
  permissions?: PermissionHandler;
  workspace?: { cwd: string; shell?: boolean };
  /** A model implementation instead of the subscription; for tests. */
  llm?: LLM;
};

export type PromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; text?: string } };
export type PromptInput = string | PromptBlock[];

export type TurnEvent =
  | { type: "text_delta"; delta: string }
  | { type: "reasoning_delta"; delta: string }
  | { type: "tool_start"; id: string; name: string }
  | { type: "tool_end"; id: string; name: string; content?: string; isError: boolean };
export type Usage = { inputTokens?: number; outputTokens?: number; cacheReadTokens?: number; reasoningTokens?: number };
export type TurnResult = { stopReason: StopReason; usage: Usage };
export type Turn = AsyncIterable<TurnEvent> & { result: Promise<TurnResult>; cancel(): void };
export type Agent = {
  prompt(input: PromptInput, options?: { signal?: AbortSignal }): Turn;
  checkpoint(): Promise<Uint8Array>;
  close(): Promise<void>;
};

const utf8 = (s: string) => Buffer.byteLength(s);
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

function normalizeTools(value: HostTool[] | undefined): HostTool[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new TypeError("tools must be an array");
  if (value.length > MAX_TOOLS) throw new RangeError(`tools cannot contain more than ${MAX_TOOLS} entries`);
  const names = new Set<string>();
  return value.map((tool, index) => {
    if (!tool || typeof tool !== "object") throw new TypeError(`tool ${index} must be an object`);
    const { name, description, inputSchema, execute } = tool;
    if (typeof name !== "string" || !/^[A-Za-z0-9_-]{1,64}$/.test(name))
      throw new TypeError(`tool ${index} has an invalid name`);
    if (names.has(name)) throw new TypeError(`duplicate tool name: ${name}`);
    names.add(name);
    if (typeof description !== "string") throw new TypeError(`tool ${name} requires a description`);
    if (typeof execute !== "function") throw new TypeError(`tool ${name} requires execute()`);
    if (!inputSchema || typeof inputSchema !== "object" || Array.isArray(inputSchema))
      throw new TypeError(`tool ${name} requires an object inputSchema`);
    let schema: Record<string, unknown>;
    try {
      schema = JSON.parse(JSON.stringify(inputSchema));
    } catch {
      throw new TypeError(`tool ${name} inputSchema must be JSON-serializable`);
    }
    return { name, description, inputSchema: schema, execute: execute.bind(tool) };
  });
}

export function normalizeInstructions(value: string | string[] | undefined): string {
  let text: string;
  if (value === undefined) text = "";
  else if (typeof value === "string") text = value;
  else if (Array.isArray(value) && value.every((v) => typeof v === "string")) text = value.filter(Boolean).join("\n\n");
  else throw new TypeError("instructions must be a string or an array of strings");
  if (utf8(text) > MAX_INSTRUCTIONS_BYTES)
    throw new RangeError(`instructions exceed the ${MAX_INSTRUCTIONS_BYTES} byte nod limit`);
  return text;
}

/** What the model reads for a host tool's return value: text as is, undefined as "null", the rest as JSON. */
export function hostToolResult(value: unknown): ToolResult {
  const rich = value as RichToolResult | undefined;
  if (rich?.type === "nod.tool-result") {
    if (typeof rich.text !== "string" || !Array.isArray(rich.images) || rich.images.length > MAX_IMAGES)
      throw new TypeError("invalid typed tool result");
    let bytes = utf8(rich.text);
    const images: ImageRef[] = rich.images.map((image, i) => {
      if (
        image?.type !== "image" ||
        typeof image.data !== "string" ||
        typeof image.mimeType !== "string" ||
        image.mimeType.length > 128 ||
        image.data.length > MAX_IMAGE_BYTES
      )
        throw new TypeError("invalid tool image");
      bytes += image.data.length;
      if (bytes > MAX_RESULT_BYTES) throw new RangeError("typed tool result exceeds the result limit");
      return { id: i + 1, mime: image.mimeType, data: image.data };
    });
    return { status: rich.isError ? "failure" : "success", output: rich.text, images };
  }
  const output = typeof value === "string" ? value : value === undefined ? "null" : (JSON.stringify(value) ?? "null");
  if (utf8(output) > MAX_RESULT_BYTES) throw new RangeError("Host tool result exceeded the response frame limit");
  return { status: "success", output };
}

function hostToolSpec(tool: HostTool): ToolSpec<unknown> {
  return {
    name: tool.name,
    description: tool.description,
    parameters: tool.inputSchema,
    activity: "read",
    requiresApproval: false,
    permissionTarget: "none",
    decode: (args) => ({ ok: true, input: args }),
    readsOnly: () => true,
    label: () => tool.name,
    async call(input, ctx) {
      const signal = ctx.signal ?? new AbortController().signal;
      try {
        return hostToolResult(await tool.execute(input, { signal }));
      } catch (e) {
        const attached = (e as { toolResult?: RichToolResult })?.toolResult;
        if (attached?.type === "nod.tool-result") {
          try {
            return { ...hostToolResult({ ...attached, isError: true }), status: "failure" };
          } catch {}
        }
        return { status: "failure", output: e instanceof Error ? e.message : String(e) };
      }
    },
  };
}

export function normalizePromptInput(input: PromptInput): UserTurn {
  if (typeof input === "string") return { text: input };
  if (!Array.isArray(input)) throw new TypeError("prompt input must be a string or an array of prompt blocks");
  const parts: string[] = [];
  const images: ImageRef[] = [];
  input.forEach((block, index) => {
    if (!block || typeof block !== "object") throw new TypeError(`prompt block ${index} must be an object`);
    if (block.type === "text") {
      if (typeof block.text !== "string") throw new TypeError(`text prompt block ${index} requires text`);
      parts.push(block.text);
    } else if (block.type === "image") {
      if (typeof block.data !== "string" || !IMAGE_MIMES.includes(block.mimeType))
        throw new TypeError(`image prompt block ${index} requires base64 data and a png, jpeg, gif, or webp mimeType`);
      if (block.data.length > MAX_IMAGE_BYTES) throw new RangeError(`image prompt block ${index} exceeds 5 MiB`);
      if (images.length >= MAX_IMAGES) throw new RangeError(`a prompt carries at most ${MAX_IMAGES} images`);
      images.push({ id: images.length + 1, mime: block.mimeType, data: block.data });
      parts.push(`[Image #${images.length}]`);
    } else if (block.type === "resource") {
      const r = block.resource;
      if (typeof r?.uri !== "string") throw new TypeError(`resource prompt block ${index} requires uri`);
      if (r.text !== undefined && typeof r.text !== "string")
        throw new TypeError(`resource prompt block ${index} text must be a string`);
      parts.push(`<embedded_resource uri="${r.uri.replace(/"/g, "&quot;")}">\n${r.text ?? ""}\n</embedded_resource>`);
    } else throw new TypeError(`unsupported prompt block type: ${String((block as { type: unknown }).type)}`);
  });
  return images.length ? { text: parts.join("\n"), images } : { text: parts.join("\n") };
}

const checkpointBytes = (value: Uint8Array | ArrayBuffer | undefined): Uint8Array | undefined => {
  if (value === undefined) return undefined;
  if (value instanceof Uint8Array) return value.slice();
  if (value instanceof ArrayBuffer) return new Uint8Array(value.slice(0));
  throw new TypeError("checkpoint must be an ArrayBuffer or typed array");
};

function llmFor(auth: Auth, model: string, fetcher: typeof fetch | undefined): LLM {
  const credential: CredentialSource | undefined = auth.token
    ? async () => ({ token: auth.token as string, accountId: "" })
    : undefined;
  if (!credential && !fetcher) return subscriptions[auth.provider].llm(model);
  const opts = { model, ...(fetcher ? { fetcher } : {}), ...(credential ? { credential } : {}) };
  return auth.provider === "codex" ? codex(opts) : grok(opts);
}

function checkAuth(auth: Auth) {
  if (!auth || typeof auth !== "object" || (auth.provider !== "codex" && auth.provider !== "grok"))
    throw new TypeError("auth.provider must be codex or grok");
  if (auth.token !== undefined && (typeof auth.token !== "string" || auth.token.length === 0))
    throw new TypeError("auth.token must be a non-empty string");
  if (!auth.token && !subscriptions[auth.provider].signedIn())
    throw new Error(`Not signed in. Run: nod login ${auth.provider}`);
}

/** The subscription's model ids. */
export async function listModels(options: { auth: Auth; fetch?: typeof fetch }): Promise<string[]> {
  checkAuth(options.auth);
  const { auth } = options;
  if (!auth.token && !options.fetch) return subscriptions[auth.provider].models();
  const opts = {
    ...(options.fetch ? { fetcher: options.fetch } : {}),
    ...(auth.token
      ? { credential: (async () => ({ token: auth.token as string, accountId: "" })) as CredentialSource }
      : {}),
  };
  return auth.provider === "codex" ? codexModels(opts) : grokModels(opts);
}

export async function createAgent(options: AgentOptions): Promise<Agent> {
  if (!options || typeof options !== "object") throw new TypeError("createAgent() options must be an object");
  const emit = (type: string, detail: Record<string, unknown> = {}) => {
    try {
      options.onEvent?.({ type, timestamp: performance.now(), ...detail });
    } catch {}
  };
  const hostTools = normalizeTools(options.tools);
  const instructions = normalizeInstructions(options.instructions);
  const restored = (() => {
    const bytes = checkpointBytes(options.checkpoint);
    return bytes ? decodeCheckpoint(bytes) : undefined;
  })();
  if (!options.llm) checkAuth(options.auth);
  emit("runtime.start");
  const cwd = options.workspace?.cwd ?? process.cwd();
  const config = loadConfig({ workspaceRoot: cwd, env: process.env, cli: { model: options.model } });
  if (options.effort) config.effort = options.effort;
  const model = options.model ?? config.model;
  if (!model) throw new Error(`model is required: the ${options.auth.provider} subscription names no default model`);
  const llm = options.llm ?? llmFor(options.auth, model, options.fetch);
  const binding: ModelBinding = {
    provider: options.auth?.provider ?? "codex",
    model,
    sub: { ...subscriptions[options.auth?.provider ?? "codex"], llm: () => llm, signedIn: () => true },
    listed: [model],
  };
  const sessionDir = mkdtempSync(join(tmpdir(), "nod-sdk-"));
  const permissions = options.permissions;
  const prompter = permissions
    ? async (request: ApprovalRequest, signal?: AbortSignal) => {
        emit("permission.request", { request });
        const decision = await permissions(request, signal);
        emit("permission.resolve", { decision });
        return decision;
      }
    : undefined;
  const runtime: Runtime = await assembleRuntime(
    {
      config,
      access: resolveAccess({ cwd }, config.additionalDirectories),
      sessionId: "",
      sessionDir,
      history: restored?.history ?? [],
      interactive: prompter !== undefined,
      prompter,
      extraInstructions: instructions,
      permissionMode: "ask",
    },
    binding,
  );
  if (restored) runtime.state.usage = restored.usage;
  // ponytail: the loop shares this array with the runtime, so host tools are merged in place.
  if (options.workspace?.shell === false)
    runtime.tools.splice(runtime.tools.findIndex((t) => t.name === "shell") >>> 0, 1);
  for (const tool of hostTools) {
    const at = runtime.tools.findIndex((t) => t.name === tool.name);
    if (at >= 0) runtime.tools.splice(at, 1);
    runtime.tools.push(hostToolSpec(tool));
  }
  emit("runtime.ready");

  const state = runtime.state;
  let activeTurn: Turn | undefined;
  let closing = false;

  const eventFor = (ev: AgentEvent): TurnEvent | null => {
    switch (ev.type) {
      case "text":
        return { type: "text_delta", delta: ev.text };
      case "reasoning":
        return { type: "reasoning_delta", delta: ev.text };
      case "tool_started":
        return { type: "tool_start", id: ev.call.id, name: ev.call.name };
      case "tool_finished":
        return {
          type: "tool_end",
          id: ev.call.id,
          name: ev.call.name,
          content: ev.result.output,
          isError: ev.result.status === "failure",
        };
      default:
        return null;
    }
  };

  function startTurn(prompt: UserTurn, signal?: AbortSignal): Turn {
    if (signal !== undefined && typeof signal?.addEventListener !== "function")
      throw new TypeError("prompt signal must be an AbortSignal");
    const queue: { event: TurnEvent; size: number }[] = [];
    let queuedBytes = 0;
    let waiter: { resolve: (r: IteratorResult<TurnEvent>) => void; reject: (e: Error) => void } | undefined;
    let resumeOutput: (() => void) | undefined;
    let iteratorTaken = false;
    let finished = false;
    let cancelled = false;
    let failure: Error | undefined;
    let reportedPressure = false;
    const controller = new AbortController();
    const cancel = () => {
      if (finished || cancelled) return;
      cancelled = true;
      controller.abort();
      resumeOutput?.();
      resumeOutput = undefined;
    };
    const push = async (event: TurnEvent) => {
      if (cancelled) return;
      const size = utf8(JSON.stringify(event));
      while (queue.length && (queue.length >= MAX_UNREAD_EVENTS || size > MAX_UNREAD_BYTES - queuedBytes)) {
        if (!reportedPressure) {
          reportedPressure = true;
          emit("output.backpressure", { bufferedBytes: queuedBytes, bufferedEvents: queue.length });
        }
        await new Promise<void>((resolve) => {
          resumeOutput = resolve;
        });
        if (cancelled) return;
      }
      if (waiter) {
        const w = waiter;
        waiter = undefined;
        w.resolve({ value: event, done: false });
      } else {
        queue.push({ event, size });
        queuedBytes += size;
      }
    };
    const turn: Turn = {
      cancel,
      result: undefined as unknown as Promise<TurnResult>,
      [Symbol.asyncIterator]() {
        if (iteratorTaken) throw new Error("a turn has only one event consumer");
        iteratorTaken = true;
        return {
          next(): Promise<IteratorResult<TurnEvent>> {
            const head = queue.shift();
            if (head) {
              queuedBytes -= head.size;
              resumeOutput?.();
              resumeOutput = undefined;
              return Promise.resolve({ value: head.event, done: false });
            }
            if (failure) return Promise.reject(failure);
            if (finished) return Promise.resolve({ value: undefined, done: true });
            return new Promise((resolve, reject) => {
              waiter = { resolve, reject };
            });
          },
          return(): Promise<IteratorResult<TurnEvent>> {
            cancel();
            return Promise.resolve({ value: undefined, done: true });
          },
        };
      },
    };
    if (signal?.aborted) {
      finished = true;
      turn.result = Promise.resolve({ stopReason: "cancelled", usage: {} });
      return turn;
    }
    activeTurn = turn;
    signal?.addEventListener("abort", cancel, { once: true });
    turn.result = (async (): Promise<TurnResult> => {
      const before = { ...state.usage };
      const gen = runtime.loop.run(prompt, controller.signal);
      for (;;) {
        const next = await gen.next();
        if (next.done) {
          state.history.push(next.value.turn);
          const after = state.usage;
          const usage: Usage = {
            inputTokens: (after.inputTokens ?? 0) - (before.inputTokens ?? 0),
            outputTokens: (after.outputTokens ?? 0) - (before.outputTokens ?? 0),
          };
          const cacheRead = (after.cacheReadTokens ?? 0) - (before.cacheReadTokens ?? 0);
          const reasoning = (after.reasoningTokens ?? 0) - (before.reasoningTokens ?? 0);
          if (cacheRead > 0) usage.cacheReadTokens = cacheRead;
          if (reasoning > 0) usage.reasoningTokens = reasoning;
          return { stopReason: stopReasonFor(next.value, { cancelled }), usage };
        }
        const event = eventFor(next.value);
        if (event) await push(event);
      }
    })()
      .catch((e: Error) => {
        failure = e;
        throw e;
      })
      .finally(() => {
        finished = true;
        resumeOutput?.();
        resumeOutput = undefined;
        signal?.removeEventListener("abort", cancel);
        if (activeTurn === turn) activeTurn = undefined;
        const w = waiter;
        waiter = undefined;
        if (w) failure ? w.reject(failure) : w.resolve({ value: undefined, done: true });
      });
    void turn.result.catch(() => {});
    return turn;
  }

  return {
    prompt(input, promptOptions = {}) {
      if (closing) throw new Error("nod agent is closed");
      if (activeTurn) throw new Error("a prompt is already in progress for this session");
      return startTurn(normalizePromptInput(input), promptOptions.signal);
    },
    async checkpoint() {
      if (closing) throw new Error("nod agent is closed");
      if (activeTurn) throw new Error("cannot checkpoint while a prompt is active");
      return encodeCheckpoint(state.history, state.usage);
    },
    async close() {
      if (closing) return;
      closing = true;
      const turn = activeTurn;
      turn?.cancel();
      await turn?.result.catch(() => {});
      await runtime.close();
      rmSync(sessionDir, { recursive: true, force: true });
      emit("runtime.exit", { code: 0 });
    },
  };
}

// ---- MCP ---------------------------------------------------------------------------------------

export type McpToolsOptions = {
  prefix?: string;
  /** Resources read into the instructions: `{ server, uri }`. */
  resources?: { server: string; uri: string }[];
  /** Prompts rendered into the instructions: `{ server, name, arguments? }`. */
  prompts?: { server: string; name: string; arguments?: Record<string, string> }[];
};
export type McpTools = { tools: HostTool[]; instructions: string; close(): Promise<void> };

/** Host tools over an McpService's selected tools, plus resource and prompt text as instructions. */
export async function createMcpTools(service: McpService, options: McpToolsOptions = {}): Promise<McpTools> {
  if (!service || typeof service.tools !== "function" || typeof service.call !== "function")
    throw new TypeError("MCP service must provide tools() and call()");
  const prefix = options.prefix ?? "";
  if (typeof prefix !== "string" || !/^[A-Za-z0-9_-]*$/.test(prefix))
    throw new TypeError("MCP prefix must contain only letters, digits, underscore, or hyphen");
  const specs = service.tools();
  if (specs.length > MAX_TOOLS) throw new RangeError(`MCP tools exceed the ${MAX_TOOLS} tool nod limit`);
  const names = new Set<string>();
  const tools: HostTool[] = specs.map((spec) => {
    const base = `${prefix}${spec.name}`.replace(/[^A-Za-z0-9_-]/g, "_");
    let name = base.slice(0, 64);
    for (let suffix = 2; names.has(name); suffix++) {
      const tail = `_${suffix}`;
      name = `${base.slice(0, 64 - tail.length)}${tail}`;
    }
    names.add(name);
    return {
      name,
      description: spec.description || "MCP tool",
      inputSchema: spec.parameters,
      async execute(input, { signal }) {
        const result = await service.call(spec.name, (input ?? {}) as Record<string, unknown>, signal);
        const images = (result.images ?? []).map((i) => ({ type: "image" as const, mimeType: i.mime, data: i.data }));
        const rich: RichToolResult | null = images.length
          ? { type: "nod.tool-result", text: result.output, images }
          : null;
        if (result.status === "failure") {
          const error = new Error(result.output || `MCP tool ${spec.name} failed`) as Error & {
            toolResult?: RichToolResult;
          };
          if (rich) error.toolResult = rich;
          throw error;
        }
        return rich ?? result.output;
      },
    };
  });
  const sections: string[] = [];
  const feature = async (label: string, request: Record<string, unknown>) => {
    if (typeof service.features !== "function") throw new TypeError("MCP service does not provide features()");
    const result = await service.features(request);
    if (result.status === "failure") throw new Error(result.output);
    if (result.output) sections.push(`<${label}>\n${result.output}\n</${label}>`);
  };
  for (const r of options.resources ?? [])
    await feature("mcp_resource", { action: "resource_read", server: r.server, uri: r.uri });
  for (const p of options.prompts ?? [])
    await feature("mcp_prompt", { action: "prompt_get", server: p.server, name: p.name, arguments: p.arguments ?? {} });
  const instructions = sections.join("\n\n");
  if (utf8(instructions) > MAX_INSTRUCTIONS_BYTES)
    throw new RangeError(`MCP instructions exceed the ${MAX_INSTRUCTIONS_BYTES} byte nod limit`);
  let closed = false;
  return {
    tools,
    instructions,
    async close() {
      if (closed) return;
      closed = true;
      await (service as { close?: () => Promise<void> | void }).close?.();
    },
  };
}

// ---- Skills ------------------------------------------------------------------------------------

export type SkillRecord = {
  name: string;
  description?: string;
  instructions: string;
  resources?: { uri: string; text: string }[];
  tools?: HostTool[];
};
export type SkillsAdapter = { instructions: string; tools: HostTool[] };

const escapeAttribute = (value: string) =>
  value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");

/** Up to 64 loaded skills as one instructions block plus their tools. */
export function createSkillsAdapter(records: SkillRecord[]): SkillsAdapter {
  if (!Array.isArray(records) || records.length > MAX_TOOLS)
    throw new TypeError(`skills must be an array with at most ${MAX_TOOLS} records`);
  const names = new Set<string>();
  const sections: string[] = [];
  const tools: HostTool[] = [];
  records.forEach((record, index) => {
    if (!record || typeof record.name !== "string" || typeof record.instructions !== "string")
      throw new TypeError(`skill ${index} requires name and instructions`);
    if (names.has(record.name)) throw new TypeError(`duplicate skill name: ${record.name}`);
    names.add(record.name);
    const resources = (record.resources ?? [])
      .map((r) => {
        if (typeof r?.uri !== "string" || typeof r?.text !== "string")
          throw new TypeError(`skill ${record.name} has an invalid resource`);
        return `<resource uri="${escapeAttribute(r.uri)}">\n${r.text}\n</resource>`;
      })
      .join("\n");
    sections.push(
      [
        `<skill name="${escapeAttribute(record.name)}">`,
        record.description ? `<description>${record.description}</description>` : "",
        record.instructions,
        resources,
        "</skill>",
      ]
        .filter(Boolean)
        .join("\n"),
    );
    if (record.tools !== undefined) {
      if (!Array.isArray(record.tools)) throw new TypeError(`skill ${record.name} tools must be an array`);
      tools.push(...record.tools);
    }
  });
  const instructions = sections.join("\n\n");
  if (utf8(instructions) > MAX_INSTRUCTIONS_BYTES)
    throw new RangeError(`skill instructions exceed the ${MAX_INSTRUCTIONS_BYTES} byte nod limit`);
  return { instructions, tools };
}

/** One SKILL.md as a record: frontmatter name/description, the body as instructions. */
export async function loadSkillFile(
  path: string,
  options: { resources?: SkillRecord["resources"]; tools?: HostTool[] } = {},
): Promise<SkillRecord> {
  const parsed = parseSkillFile(readFileSync(path));
  if (parsed.status === "invalid") throw new Error(`${path}: invalid SKILL.md (${parsed.cause})`);
  return {
    name: parsed.status === "valid" ? parsed.name : basename(path).replace(/\.md$/i, ""),
    description: parsed.status === "valid" ? parsed.description : "",
    instructions: parsed.body.trim(),
    resources: options.resources ?? [],
    tools: options.tools ?? [],
  };
}
