/** The ACP server: one connection, one active session, one active prompt; JSON-RPC over NDJSON streams. */

import { assembleRuntime, type ModelBinding, type Runtime } from "../cli/runtime.ts";
import { modelCapabilities } from "../core/agent/config.ts";
import type { Effort, PermissionMode, Provider, ToolCall } from "../core/agent/types.ts";
import { loadConfig, type ResolvedConfig } from "../core/config/resolve.ts";
import type { LimitOverride } from "../core/context/limits.ts";
import type { McpServerConfig, McpService } from "../core/mcp/types.ts";
import type { Grant } from "../core/permissions/index.ts";
import { listSessions } from "../core/session/catalog.ts";
import { SessionError } from "../core/session/id.ts";
import { createSession, openSession, type Session, updateManifest } from "../core/session/store.ts";
import { type AccessScope, resolveAccess } from "../core/workspace/access.ts";
import { isSubscription, pickModel, type Subscription, subscriptions } from "../providers/providers.ts";
import {
  encodeFrame,
  errorResponse,
  FRAME_TOO_LARGE,
  type Id,
  INTERNAL_ERROR,
  INVALID_PARAMS,
  INVALID_REQUEST,
  METHOD_NOT_FOUND,
  type Message,
  notification,
  PARSE_ERROR,
  RpcFailure,
  readFrames,
  response,
  request as rpcRequest,
} from "./jsonrpc.ts";
import {
  type PermissionOutcome,
  type PermissionRequestParams,
  promptFromBlocks,
  runTurn,
  turnCallbacks,
} from "./prompt.ts";
import {
  type ConfigOption,
  isoTimestamp,
  MODES,
  type ModeId,
  mapToolKind,
  messageId,
  PROTOCOL_VERSION,
  parseMcpServers,
  parseRawInput,
  type SessionUpdate,
  toolUpdateContentText,
} from "./types.ts";

export type AcpDeps = {
  cwd: string;
  env: Record<string, string | undefined>;
  version: string;
  /** Process-level model override; wins over the model stored in a loaded session. */
  model?: string;
  addDirs?: string[];
  noAdditionalDirs?: boolean;
  contextLimits?: LimitOverride[];
  log?: (line: string) => void;
  now?: () => number;
  /** The subscription and model for a session; tests inject a fake binding. */
  bind?: (provider: Provider | undefined, model: string | undefined) => Promise<ModelBinding>;
  signedInProviders?: () => Provider[];
  /** Builds the MCP service for the session's servers (client ∪ approved project); wired by the integrator. */
  mcp?: (servers: McpServerConfig[]) => Promise<McpService | undefined>;
};

type Active = {
  session: Session;
  config: ResolvedConfig;
  access: AccessScope;
  binding: ModelBinding;
  mode: ModeId;
  permissionMode: PermissionMode;
  effort: Effort;
  mcpServers: McpServerConfig[];
  grants: Grant[];
  runtime?: Runtime;
  turn?: { controller: AbortController; cancelled: boolean };
};

export type AcpHealth = {
  initialized: boolean;
  session?: {
    id: string;
    provider: Provider;
    model: string;
    mode: ModeId;
    mcpServers: { name: string; transport: string; source: string }[];
  };
};

const invalidParams = (message = "Invalid params") => new RpcFailure(INVALID_PARAMS, message);
const str = (v: unknown): string | undefined => (typeof v === "string" && v.length > 0 ? v : undefined);
const obj = (v: unknown): Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : {};

/** The default binding: the signed-in subscription's model list plus the picked model. */
export async function bindSubscription(
  provider: Provider | undefined,
  model: string | undefined,
): Promise<ModelBinding> {
  const picked = await pickModel(provider, model);
  const listed = await picked.sub.models().catch(() => [] as string[]);
  return { provider: picked.provider, model: picked.model, sub: picked.sub, listed };
}

export function createAcpServer(deps: AcpDeps) {
  const log = deps.log ?? (() => {});
  const now = deps.now ?? Date.now;
  const bind = deps.bind ?? bindSubscription;
  const signedIn =
    deps.signedInProviders ??
    (() => (Object.keys(subscriptions) as Provider[]).filter((p) => (subscriptions[p] as Subscription).signedIn()));
  let initialized = false;
  let active: Active | undefined;
  let write: (message: unknown) => void = () => {};
  let nextRequestId = 1;
  const pending = new Map<Id, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

  const send = (sessionId: string, update: SessionUpdate) =>
    write(notification("session/update", { sessionId, update }));

  const sendRequest = (method: string, params: unknown, signal?: AbortSignal): Promise<unknown> =>
    new Promise((resolve, reject) => {
      const id = nextRequestId++;
      const settle = (fn: () => void) => {
        if (!pending.has(id)) return;
        pending.delete(id);
        fn();
      };
      pending.set(id, { resolve: (v) => settle(() => resolve(v)), reject: (e) => settle(() => reject(e)) });
      signal?.addEventListener("abort", () => settle(() => resolve({ outcome: { outcome: "cancelled" } })), {
        once: true,
      });
      write(rpcRequest(id, method, params));
    });

  const requestPermission = async (
    params: PermissionRequestParams,
    signal?: AbortSignal,
  ): Promise<PermissionOutcome> => {
    const raw = obj(await sendRequest("session/request_permission", params, signal));
    const outcome = obj(raw.outcome);
    return outcome.outcome === "selected" && typeof outcome.optionId === "string"
      ? { outcome: { outcome: "selected", optionId: outcome.optionId } }
      : { outcome: { outcome: "cancelled" } };
  };

  const loadCfg = (model: string | undefined) =>
    loadConfig({
      workspaceRoot: deps.cwd,
      env: deps.env,
      cli: { model, contextLimits: deps.contextLimits },
    });

  const sessionDeps = (config: ResolvedConfig) => ({ home: config.home, cwd: deps.cwd, now });

  async function closeActive() {
    if (!active) return;
    const a = active;
    active = undefined;
    a.turn?.controller.abort();
    await a.runtime?.close();
    a.session.close();
  }

  async function activate(session: Session, config: ResolvedConfig, mcpServers: McpServerConfig[]): Promise<Active> {
    const stored = session.manifest;
    const provider = deps.model ? config.provider : ((stored.provider as Provider | null) ?? config.provider);
    const model = deps.model ?? stored.model ?? config.model;
    let binding: ModelBinding;
    try {
      binding = await bind(provider, model);
    } catch (e) {
      session.close();
      throw new RpcFailure(INTERNAL_ERROR, (e as Error).message);
    }
    const access = resolveAccess({ cwd: deps.cwd }, config.additionalDirectories, {
      addDirs: deps.addDirs ?? [],
      suppressSaved: deps.noAdditionalDirs ?? false,
    });
    active = {
      session,
      config,
      access,
      binding,
      mode: config.permissionMode === "ask" ? "ask" : "code",
      permissionMode: config.permissionMode,
      effort: stored.effort ?? config.effort,
      mcpServers,
      grants: [],
    };
    log(
      `session ${session.id} active provider=${binding.provider} model=${binding.model} mcp=[${mcpServers.map((s) => s.name).join(",")}]`,
    );
    return active;
  }

  function configOptions(a: Active): ConfigOption[] {
    const out: ConfigOption[] = [];
    if (signedIn().length >= 2)
      out.push({
        id: "provider",
        name: "Provider",
        category: "model",
        type: "select",
        currentValue: a.binding.provider,
        options: [
          { value: "codex", name: "ChatGPT subscription" },
          { value: "grok", name: "Grok subscription" },
        ],
      });
    const models = a.binding.listed.map((id) => ({ value: id, name: id }));
    if (!a.binding.listed.includes(a.binding.model)) models.push({ value: a.binding.model, name: a.binding.model });
    out.push({
      id: "model",
      name: "Model",
      category: "model",
      type: "select",
      currentValue: a.binding.model,
      options: models,
    });
    out.push({
      id: "mode",
      name: "Session Mode",
      description: "Controls how the agent requests permission",
      category: "mode",
      type: "select",
      currentValue: a.mode,
      options: MODES.map((m) => ({ ...m, value: m.id, permissionMode: m.id === "ask" ? "ask" : "auto" })).map(
        ({ id: _id, ...rest }) => rest,
      ),
    });
    const efforts = modelCapabilities(a.binding.provider, a.binding.model).efforts ?? [];
    if (efforts.length) {
      const options = [{ value: "auto", name: "default" }, ...efforts.map((e) => ({ value: e, name: e }))];
      if (!options.some((o) => o.value === a.effort)) options.push({ value: a.effort, name: a.effort });
      out.push({
        id: "effort",
        name: "Reasoning Effort",
        description: "Controls how much the model thinks before responding",
        category: "thought_level",
        type: "select",
        currentValue: a.effort,
        options,
      });
    }
    return out;
  }

  const modes = (a: Active) => ({ currentModeId: a.mode, availableModes: MODES });

  function replay(a: Active) {
    const id = a.session.id;
    for (const turn of a.session.history) {
      if (turn.kind === "compacted_summary") continue;
      const userMessage = messageId();
      if (turn.user.text.length > 0)
        send(id, {
          sessionUpdate: "user_message_chunk",
          messageId: userMessage,
          content: { type: "text", text: turn.user.text },
        });
      for (const image of turn.user.images ?? [])
        send(id, {
          sessionUpdate: "user_message_chunk",
          messageId: userMessage,
          content: { type: "image", data: image.data, mimeType: image.mime },
        });
      for (const step of turn.execution.steps) {
        if (step.assistant.length > 0)
          send(id, {
            sessionUpdate: "agent_message_chunk",
            messageId: messageId(),
            content: { type: "text", text: step.assistant },
          });
        for (const call of step.toolCalls) {
          send(id, {
            sessionUpdate: "tool_call",
            toolCallId: call.id,
            name: call.name,
            title: call.name,
            kind: mapToolKind(call.name),
            status: "pending",
            rawInput: parseRawInput(call.arguments),
          });
          const result = step.results.find((r) => r.toolCallId === call.id);
          if (!result) continue;
          const failed = result.status === "failure";
          send(id, {
            sessionUpdate: "tool_call_update",
            toolCallId: call.id,
            status: failed ? "failed" : "completed",
            ...(result.content.length
              ? {
                  content: [
                    { type: "content", content: { type: "text", text: toolUpdateContentText(failed, result.content) } },
                  ],
                }
              : {}),
          });
        }
      }
      const text = turn.kind === "assistant" ? turn.assistant : (turn.assistant ?? "");
      if (text.length > 0)
        send(id, { sessionUpdate: "agent_message_chunk", messageId: messageId(), content: { type: "text", text } });
      if (turn.kind === "interrupted")
        send(id, {
          sessionUpdate: "agent_message_chunk",
          messageId: messageId(),
          content: { type: "text", text: "The previous response ended before completion." },
        });
    }
  }

  async function runtimeFor(a: Active, current: { call?: ToolCall }): Promise<Runtime> {
    if (a.runtime) return a.runtime;
    const host = {
      sessionId: a.session.id,
      session: a.session,
      sessionTitles: a.config.sessionTitles,
      send: (u: SessionUpdate) => send(a.session.id, u),
      requestPermission,
      log,
    };
    const { prompter, askUser } = turnCallbacks(host, () => current.call);
    const runtime = await assembleRuntime(
      {
        config: { ...a.config, effort: a.effort, permissionMode: a.permissionMode },
        access: a.access,
        sessionId: a.session.id,
        sessionDir: a.session.dir,
        history: a.session.history,
        interactive: true,
        prompter,
        askUser,
        permissionMode: a.permissionMode,
      },
      a.binding,
    );
    runtime.policy.grants = a.grants;
    const mcp = await deps.mcp?.(a.mcpServers);
    if (mcp) runtime.toolContext.mcp = mcp;
    a.runtime = runtime;
    return runtime;
  }

  async function dropRuntime(a: Active) {
    const r = a.runtime;
    a.runtime = undefined;
    await r?.close();
  }

  const requireActive = (params: Record<string, unknown>, checkId = true): Active => {
    if (!active) throw new RpcFailure(INVALID_REQUEST, "No active session");
    if (checkId && params.sessionId !== undefined && params.sessionId !== active.session.id) throw invalidParams();
    return active;
  };
  const noPrompt = (a: Active | undefined) => {
    if (a?.turn) throw new RpcFailure(INVALID_REQUEST, "a prompt is already in progress");
  };

  async function openForRestore(params: Record<string, unknown>, withReplay: boolean) {
    noPrompt(active);
    const sessionId = str(params.sessionId);
    if (!sessionId || !str(params.cwd)) throw invalidParams();
    const mcpServers = parseMcpServers(params.mcpServers);
    if (!mcpServers) throw invalidParams();
    const config = loadCfg(deps.model);
    let session: Session;
    try {
      session = openSession(sessionDeps(config), sessionId, { rebindWorkspace: true });
    } catch (e) {
      if (e instanceof SessionError)
        throw invalidParams(
          e.code === "not_found" ? "Session not found" : e.code === "invalid_id" ? "Invalid session ID" : e.message,
        );
      throw new RpcFailure(INTERNAL_ERROR, (e as Error).message);
    }
    await closeActive();
    const a = await activate(session, config, mcpServers);
    if (withReplay) replay(a);
    const result = { configOptions: configOptions(a), modes: modes(a) };
    queueMicrotask(() => send(a.session.id, { sessionUpdate: "available_commands_update", availableCommands: [] }));
    return result;
  }

  const handlers: Record<string, (params: Record<string, unknown>) => Promise<unknown> | unknown> = {
    async "session/new"(params) {
      noPrompt(active);
      if (!str(params.cwd)) throw invalidParams();
      const mcpServers = parseMcpServers(params.mcpServers);
      if (!mcpServers) throw invalidParams();
      const config = loadCfg(deps.model);
      await closeActive();
      const session = createSession(sessionDeps(config), {
        provider: config.provider,
        model: config.model ?? null,
        effort: config.effort,
        fast_mode: config.fastMode,
      });
      const a = await activate(session, config, mcpServers);
      const result = { sessionId: session.id, configOptions: configOptions(a), modes: modes(a) };
      queueMicrotask(() => send(session.id, { sessionUpdate: "available_commands_update", availableCommands: [] }));
      return result;
    },
    "session/load": (params) => openForRestore(params, true),
    "session/resume": (params) => openForRestore(params, false),
    async "session/close"(params) {
      const a = requireActive(params);
      noPrompt(a);
      await closeActive();
      return {};
    },
    "session/list"(params) {
      const config = loadCfg(deps.model);
      const cursor = params.cursor;
      if (cursor !== undefined && typeof cursor !== "string") throw invalidParams();
      try {
        const page = listSessions(sessionDeps(config), { cursor, scope: "workspace" });
        return {
          sessions: page.sessions.map((s) => ({
            sessionId: s.id,
            cwd: s.workspace_root,
            ...(s.title ? { title: s.title } : {}),
            updatedAt: isoTimestamp(s.updated_at_ms),
          })),
          ...(page.next_cursor ? { nextCursor: page.next_cursor } : {}),
        };
      } catch (e) {
        if (e instanceof SessionError) throw invalidParams();
        throw e;
      }
    },
    async "session/set_config_option"(params) {
      const a = requireActive(params);
      const value = params.value;
      switch (params.configId) {
        case "model": {
          const model = str(value);
          if (!model) throw invalidParams("Invalid session model");
          updateManifest(a.session, { model });
          if (!deps.model) {
            a.binding = await bind(a.binding.provider, model).catch((e: Error) => {
              throw invalidParams(e.message);
            });
            await dropRuntime(a);
          }
          break;
        }
        case "provider": {
          if (typeof value !== "string" || !isSubscription(value)) throw invalidParams("Invalid provider");
          a.binding = await bind(value, undefined).catch((e: Error) => {
            throw invalidParams(e.message);
          });
          updateManifest(a.session, { provider: value, model: a.binding.model });
          await dropRuntime(a);
          break;
        }
        case "mode":
          if (value !== "ask" && value !== "code") throw invalidParams();
          await setMode(a, value);
          break;
        case "effort": {
          const effort = str(value) as Effort | undefined;
          const efforts = modelCapabilities(a.binding.provider, a.binding.model).efforts;
          if (!effort) throw invalidParams("Invalid reasoning effort");
          if (!efforts?.length) throw invalidParams("Reasoning effort is unavailable for the active model");
          if (effort !== "auto" && !efforts.includes(effort))
            throw invalidParams("Reasoning effort is not available for the active model");
          a.effort = effort;
          updateManifest(a.session, { effort });
          await dropRuntime(a);
          break;
        }
        default:
          throw invalidParams();
      }
      return { configOptions: configOptions(a) };
    },
    async "session/set_mode"(params) {
      const a = requireActive(params);
      const mode = params.modeId;
      if (mode !== "ask" && mode !== "code") throw invalidParams();
      await setMode(a, mode);
      queueMicrotask(() => send(a.session.id, { sessionUpdate: "current_mode_update", currentModeId: mode }));
      return {};
    },
  };

  async function setMode(a: Active, mode: ModeId) {
    a.mode = mode;
    a.permissionMode = mode === "ask" ? "ask" : "auto";
    await dropRuntime(a);
  }

  async function handlePrompt(params: Record<string, unknown>) {
    const a = requireActive(params);
    if (!str(params.sessionId)) throw invalidParams();
    noPrompt(a);
    const prompt = promptFromBlocks(params.prompt);
    const controller = new AbortController();
    a.turn = { controller, cancelled: false };
    const current: { call?: ToolCall } = {};
    try {
      const runtime = await runtimeFor(a, current);
      return await runTurn(
        {
          sessionId: a.session.id,
          session: a.session,
          runtime,
          sessionTitles: a.config.sessionTitles,
          send: (u) => send(a.session.id, u),
          requestPermission,
          log,
        },
        prompt,
        controller.signal,
        current,
      );
    } finally {
      if (active === a) a.turn = undefined;
    }
  }

  async function dispatch(message: Message) {
    const id = message.id ?? null;
    const fail = (e: unknown) => {
      if (e instanceof RpcFailure) return errorResponse(id, e.code, e.message, e.data);
      log(`internal error in ${message.method}: ${(e as Error).stack ?? e}`);
      return errorResponse(id, INTERNAL_ERROR, (e as Error).message ?? "Internal error");
    };
    const method = message.method as string;
    const params = obj(message.params);
    if (method === "initialize") {
      if (initialized) return write(errorResponse(id, INVALID_REQUEST, "Already initialized"));
      if (typeof params.protocolVersion !== "number")
        return write(errorResponse(id, INVALID_PARAMS, "Invalid initialize params"));
      initialized = true;
      return write(
        response(id, {
          protocolVersion: PROTOCOL_VERSION,
          agentCapabilities: {
            loadSession: true,
            promptCapabilities: { image: true, audio: false, embeddedContext: true },
            mcpCapabilities: { http: true, sse: true },
            sessionCapabilities: { list: {}, resume: {}, close: {} },
          },
          agentInfo: { name: "nod", title: "nod", version: deps.version },
          authMethods: [],
        }),
      );
    }
    if (!initialized) return write(errorResponse(id, INVALID_REQUEST, "Not initialized. Call initialize first."));
    if (method === "session/prompt") {
      // Runs in the background so cancel, permission answers, and question answers keep flowing.
      try {
        return write(response(id, await handlePrompt(params)));
      } catch (e) {
        return write(fail(e));
      }
    }
    const handler = handlers[method];
    if (!handler) return write(errorResponse(id, METHOD_NOT_FOUND, "Method not found"));
    try {
      write(response(id, await handler(params)));
    } catch (e) {
      write(fail(e));
    }
  }

  /** A response to one of our requests (permission, question) or a notification. */
  function onMessage(message: Message) {
    if (message.method === undefined) {
      const waiter = message.id === undefined ? undefined : pending.get(message.id);
      if (!waiter) return write(errorResponse(message.id ?? null, INVALID_REQUEST, "Invalid Request"));
      if (message.error) waiter.reject(new Error(message.error.message));
      else waiter.resolve(message.result);
      return;
    }
    if (message.method === "session/cancel" && active?.turn) {
      active.turn.cancelled = true;
      active.turn.controller.abort();
    }
  }

  return {
    /** Serves one connection until the input ends; frames go to `output`. */
    async serve(input: AsyncIterable<Uint8Array | string>, output: { write(chunk: string): unknown }) {
      write = (message) => {
        output.write(encodeFrame(message));
      };
      // Requests run in arrival order; a prompt is detached so cancel and answers keep flowing while it runs.
      let chain = Promise.resolve();
      for await (const frame of readFrames(input)) {
        if (frame.kind === "too_large") {
          write(errorResponse(null, FRAME_TOO_LARGE, "request frame too large"));
          continue;
        }
        if (frame.kind === "parse_error") {
          write(errorResponse(null, PARSE_ERROR, "Parse error"));
          continue;
        }
        const message = frame.message;
        if (message.jsonrpc !== "2.0" || (message.method !== undefined && typeof message.method !== "string")) {
          write(errorResponse(message.id ?? null, INVALID_REQUEST, "Invalid Request"));
          continue;
        }
        if (message.method === undefined || message.id === undefined || message.id === null) {
          onMessage(message);
          continue;
        }
        if (message.method === "session/prompt") void chain.then(() => dispatch(message));
        else chain = chain.then(() => dispatch(message)).catch(() => {});
      }
      await chain;
      await closeActive();
    },
    health(): AcpHealth {
      return {
        initialized,
        ...(active
          ? {
              session: {
                id: active.session.id,
                provider: active.binding.provider,
                model: active.binding.model,
                mode: active.mode,
                mcpServers: active.mcpServers.map((s) => ({ name: s.name, transport: s.type, source: s.source })),
              },
            }
          : {}),
      };
    },
    close: closeActive,
  };
}
