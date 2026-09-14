/** One `session/prompt` turn: agent events become session/update frames; approvals and questions round-trip to the client. */

import type { Runtime } from "../cli/runtime.ts";
import { estimateMessagesTokens } from "../core/agent/compaction.ts";
import { modelCapabilities } from "../core/agent/config.ts";
import { projectHistory } from "../core/agent/history.ts";
import type { AgentEvent, TurnOutcome } from "../core/agent/loop.ts";
import type { HistoryTurn, ImageRef, ToolCall, UserTurn } from "../core/agent/types.ts";
import type { ApprovalDecision, ApprovalRequest } from "../core/permissions/index.ts";
import { deriveDisplay } from "../core/session/events.ts";
import { type Session, saveTurn, updateManifest } from "../core/session/store.ts";
import { generateTitle, shouldGenerateTitle } from "../core/session/title.ts";
import type { AskUser } from "../core/tools/spec.ts";
import { INVALID_PARAMS, RpcFailure } from "./jsonrpc.ts";
import {
  type CommandResult,
  isoTimestamp,
  mapToolKind,
  messageId,
  PERMISSION_OPTIONS,
  type PromptBlock,
  parseRawInput,
  type SessionUpdate,
  type StopReason,
  stopReasonFor,
  toolUpdateContentText,
} from "./types.ts";

export type PermissionOutcome = { outcome: { outcome: "selected"; optionId: string } | { outcome: "cancelled" } };
export type PermissionRequestParams = {
  sessionId: string;
  toolCall: { toolCallId: string; name: string; title: string; kind: string; status: "pending"; rawInput?: unknown };
  options: { optionId: string; name: string; kind: string; description?: string }[];
};

export const MAX_IMAGES = 8;
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024;
const IMAGE_MIMES = ["image/png", "image/jpeg", "image/gif", "image/webp"];

/** Text plus images from the prompt blocks; audio and malformed blocks are -32602. */
export function promptFromBlocks(raw: unknown): UserTurn {
  const invalid = () => new RpcFailure(INVALID_PARAMS, "Invalid params");
  if (!Array.isArray(raw)) throw invalid();
  const parts: string[] = [];
  const images: ImageRef[] = [];
  for (const block of raw as PromptBlock[]) {
    if (typeof block !== "object" || block === null) throw invalid();
    if (block.type === "text") {
      if (typeof block.text !== "string") throw invalid();
      parts.push(block.text);
    } else if (block.type === "image") {
      if (typeof block.data !== "string" || typeof block.mimeType !== "string" || !IMAGE_MIMES.includes(block.mimeType))
        throw new RpcFailure(INVALID_PARAMS, "Invalid image prompt block");
      if (block.data.length > MAX_IMAGE_BYTES || images.length >= MAX_IMAGES)
        throw new RpcFailure(INVALID_PARAMS, "Invalid image prompt block");
      images.push({ id: images.length + 1, mime: block.mimeType, data: block.data });
      parts.push(`[Image #${images.length}]`);
    } else if (block.type === "resource") {
      const r = block.resource;
      if (typeof r !== "object" || r === null || typeof r.uri !== "string" || typeof r.text !== "string")
        throw invalid();
      parts.push(`<embedded_resource uri="${r.uri.replace(/"/g, "&quot;")}">\n${r.text}\n</embedded_resource>`);
    } else throw invalid();
  }
  const text = parts.join("\n");
  if (text.trim().length === 0) throw invalid();
  return images.length ? { text, images } : { text };
}

export type TurnHost = {
  sessionId: string;
  session: Session;
  runtime: Runtime;
  sessionTitles: boolean;
  send(update: SessionUpdate): void;
  requestPermission(params: PermissionRequestParams, signal?: AbortSignal): Promise<PermissionOutcome>;
  log(line: string): void;
};

/** The prompter and askUser the runtime calls back into: both resolve through session/request_permission. */
export function turnCallbacks(host: Omit<TurnHost, "runtime">, current: () => ToolCall | undefined) {
  const prompter = async (request: ApprovalRequest, signal?: AbortSignal): Promise<ApprovalDecision> => {
    const call = current();
    const res = await host.requestPermission(
      {
        sessionId: host.sessionId,
        toolCall: {
          toolCallId: call?.id ?? messageId(),
          name: request.toolName,
          title: request.label,
          kind: mapToolKind(request.toolName),
          status: "pending",
          rawInput: call ? parseRawInput(call.arguments) : undefined,
        },
        options: [...PERMISSION_OPTIONS],
      },
      signal,
    );
    if (res.outcome.outcome !== "selected") return { outcome: "deny" };
    const id = res.outcome.optionId;
    return { outcome: id === "allow_once" ? "once" : id === "allow_always" ? "always" : "deny" };
  };
  const askUser: AskUser = async (questions, signal) => {
    const call = current();
    const answers: { question: string; answer: string }[] = [];
    for (const q of questions) {
      const res = await host.requestPermission(
        {
          sessionId: host.sessionId,
          toolCall: {
            toolCallId: call?.id ?? messageId(),
            name: "ask_user_question",
            title: q.question,
            kind: "other",
            status: "pending",
            rawInput: q,
          },
          options: [
            ...q.options.map((o, i) => ({
              optionId: `option_${i + 1}`,
              name: o.label,
              kind: "allow_once",
              ...(o.description ? { description: o.description } : {}),
            })),
            { optionId: "other", name: "Other", kind: "reject_once" },
          ],
        },
        signal,
      );
      if (res.outcome.outcome !== "selected") return null;
      const index = Number(/^option_(\d+)$/.exec(res.outcome.optionId)?.[1]) - 1;
      answers.push({ question: q.question, answer: q.options[index]?.label ?? "" });
    }
    return { answers };
  };
  return { prompter, askUser };
}

function commandResult(call: ToolCall, output: string, workspaceRoot: string): CommandResult | undefined {
  const args = parseRawInput(call.arguments) as { request?: Record<string, unknown> } | undefined;
  const req = args?.request ?? (args as Record<string, unknown> | undefined);
  if (req?.action !== "run" || typeof req.command !== "string") return undefined;
  let snap: Record<string, unknown>;
  try {
    snap = JSON.parse(output.split("\n<command_output_handle>")[0] as string);
  } catch {
    return undefined;
  }
  const delta = typeof snap.output_delta === "string" ? snap.output_delta : "";
  // ponytail: stdout and stderr are captured merged; stderr_bytes stays 0 until the shell splits them.
  return {
    kind: "command",
    command: req.command,
    cwd: typeof req.cwd === "string" ? req.cwd : workspaceRoot,
    exit_code: typeof snap.exit_code === "number" ? snap.exit_code : null,
    signal: typeof snap.signal === "string" ? snap.signal : null,
    timed_out: snap.state === "stopped" && snap.signal === "SIGKILL" && req.timeout_ms !== undefined,
    stdout_bytes: Buffer.byteLength(delta),
    stderr_bytes: 0,
    truncated: snap.output_truncated === true,
  };
}

/** Runs the turn, saves it, and reports how it stopped. `current` tracks the tool call the callbacks refer to. */
export async function runTurn(
  host: TurnHost,
  prompt: UserTurn,
  signal: AbortSignal,
  current: { call?: ToolCall },
): Promise<{ stopReason: StopReason; usage: { inputTokens: number; outputTokens: number } }> {
  const { runtime, session } = host;
  const state = runtime.state;
  const turnMessage = messageId();
  const before = { ...state.usage };
  let steps = 0;
  runtime.toolContext.images = prompt.images ?? [];
  host.send({
    sessionUpdate: "user_message_chunk",
    messageId: turnMessage,
    content: { type: "text", text: prompt.text },
  });
  for (const image of prompt.images ?? [])
    host.send({
      sessionUpdate: "user_message_chunk",
      messageId: turnMessage,
      content: { type: "image", data: image.data, mimeType: image.mime },
    });

  const onEvent = (ev: AgentEvent) => {
    switch (ev.type) {
      case "text":
        host.send({
          sessionUpdate: "agent_message_chunk",
          messageId: turnMessage,
          content: { type: "text", text: ev.text },
        });
        break;
      case "reasoning":
        host.send({ sessionUpdate: "agent_thought_chunk", content: { type: "text", text: ev.text } });
        break;
      case "step":
        steps = ev.step;
        break;
      case "tool_started":
        current.call = ev.call;
        host.send({
          sessionUpdate: "tool_call",
          toolCallId: ev.call.id,
          name: ev.call.name,
          title: ev.label,
          kind: mapToolKind(ev.call.name),
          status: "in_progress",
          rawInput: parseRawInput(ev.call.arguments),
        });
        break;
      case "tool_finished": {
        const failed = ev.result.status === "failure";
        const command =
          ev.call.name === "shell"
            ? commandResult(ev.call, ev.result.output, runtime.toolContext.workspaceRoot)
            : undefined;
        host.send({
          sessionUpdate: "tool_call_update",
          toolCallId: ev.call.id,
          status: failed ? "failed" : "completed",
          content: [
            { type: "content", content: { type: "text", text: toolUpdateContentText(failed, ev.result.output) } },
          ],
          ...(command ? { command_result: command } : {}),
        });
        break;
      }
      case "compaction": {
        const summary = state.history[0];
        if (summary?.kind === "compacted_summary") {
          saveTurn(session, summary);
          state.history = session.history;
        }
        break;
      }
      default:
        host.log(`event ${ev.type}: ${JSON.stringify(ev).slice(0, 200)}`);
    }
  };

  const gen = runtime.loop.run(prompt, signal);
  let outcome: TurnOutcome;
  for (;;) {
    const next = await gen.next();
    if (next.done) {
      outcome = next.value;
      break;
    }
    onEvent(next.value);
  }
  current.call = undefined;

  const after = state.usage;
  const usage = {
    inputTokens: (after.inputTokens ?? 0) - (before.inputTokens ?? 0),
    outputTokens: (after.outputTokens ?? 0) - (before.outputTokens ?? 0),
    cacheReadTokens: (after.cacheReadTokens ?? 0) - (before.cacheReadTokens ?? 0),
    reasoningTokens: (after.reasoningTokens ?? 0) - (before.reasoningTokens ?? 0),
    requestCount: steps,
  };
  const wantTitle = shouldGenerateTitle(session.manifest, { sessionTitles: host.sessionTitles });
  saveTurn(session, outcome.turn as HistoryTurn, usage);
  if (wantTitle) {
    const title = await generateTitle(runtime.llm.llm(runtime.model), prompt.text).catch(() => undefined);
    if (title) updateManifest(session, { title, title_generated: true });
  }
  host.send({
    sessionUpdate: "session_info_update",
    title: session.manifest.title ?? deriveDisplay(session.history).title,
    updatedAt: isoTimestamp(session.manifest.updated_at_ms),
  });
  const size = modelCapabilities(runtime.provider, runtime.model).contextWindow;
  if (size)
    host.send({
      sessionUpdate: "usage_update",
      used: estimateMessagesTokens(projectHistory(state.history), state.calibration ?? 0.25),
      size,
    });
  return {
    stopReason: stopReasonFor(outcome, { cancelled: signal.aborted }),
    usage: { inputTokens: usage.inputTokens, outputTokens: usage.outputTokens },
  };
}
