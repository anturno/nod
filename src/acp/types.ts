/** ACP wire shapes (protocol version 1) and the small mappings from the agent loop onto them. */
import { STEP_LIMIT_NOTICE } from "../core/agent/config.ts";
import type { TurnOutcome } from "../core/agent/loop.ts";
import type { McpServerConfig } from "../core/mcp/types.ts";
import { isToolOutputError } from "../core/tools/errors.ts";

export const PROTOCOL_VERSION = 1;

export type StopReason = "end_turn" | "max_output_tokens" | "max_model_turns" | "refused" | "cancelled";
export type ToolCallKind = "read" | "edit" | "delete" | "move" | "search" | "execute" | "think" | "fetch" | "other";
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed";
export type ModeId = "ask" | "code";

export const MODES: { id: ModeId; name: string; description: string }[] = [
  { id: "ask", name: "Ask", description: "Request approval for sensitive tool calls" },
  { id: "code", name: "Code", description: "Automatically review sensitive tool calls" },
];

export const PERMISSION_OPTIONS = [
  { optionId: "allow_once", name: "Allow once", kind: "allow_once" },
  { optionId: "allow_always", name: "Allow for this session", kind: "allow_always" },
  { optionId: "reject_once", name: "Reject", kind: "reject_once" },
] as const;

export type TextContent = { type: "text"; text: string };
export type ImageContent = { type: "image"; data: string; mimeType: string };

export type CommandResult = {
  kind: "command";
  command: string;
  cwd: string;
  exit_code: number | null;
  signal: string | null;
  timed_out: boolean;
  stdout_bytes: number;
  stderr_bytes: number;
  truncated: boolean;
};

export type SessionUpdate =
  | { sessionUpdate: "user_message_chunk"; messageId: string; content: TextContent | ImageContent }
  | { sessionUpdate: "agent_message_chunk"; messageId: string; content: TextContent }
  | { sessionUpdate: "agent_thought_chunk"; content: TextContent }
  | {
      sessionUpdate: "tool_call";
      toolCallId: string;
      name: string;
      title: string;
      kind: ToolCallKind;
      status: ToolCallStatus;
      rawInput?: unknown;
    }
  | {
      sessionUpdate: "tool_call_update";
      toolCallId: string;
      status: ToolCallStatus;
      content?: { type: "content"; content: TextContent }[];
      command_result?: CommandResult;
    }
  | { sessionUpdate: "usage_update"; used: number; size: number }
  | { sessionUpdate: "session_info_update"; title: string; updatedAt: string }
  | { sessionUpdate: "available_commands_update"; availableCommands: unknown[] }
  | { sessionUpdate: "current_mode_update"; currentModeId: ModeId };

export type PromptBlock =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; text: string } };

export type ConfigOption = {
  id: string;
  name: string;
  description?: string;
  category: string;
  type: "select";
  currentValue: string;
  options: { value: string; name: string; description?: string; permissionMode?: string }[];
};

export function mapToolKind(name: string): ToolCallKind {
  switch (name) {
    case "read_file":
    case "glob_files":
      return "read";
    case "grep_files":
    case "web_search":
    case "capability_search":
      return "search";
    case "web_fetch":
      return "fetch";
    case "write_file":
    case "edit_file":
      return "edit";
    case "shell":
      return "execute";
    default:
      return "other";
  }
}

/** The live tool_call_update content contract: denials keep their full text, everything else is a 200-byte preview. */
export function toolUpdateContentText(failed: boolean, output: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: binary output is exactly what must be omitted
  if (/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(output)) return "binary or non-utf8 tool output omitted";
  if (failed && isToolOutputError(output) && /"type":"tool_(permission_denied|review_held)"/.test(output))
    return output;
  return Buffer.from(output).subarray(0, 200).toString("utf8").replace(/�+$/, "");
}

/** Where the turn stopped, in ACP words. */
export function stopReasonFor(outcome: TurnOutcome, o: { cancelled: boolean }): StopReason {
  if (o.cancelled) return "cancelled";
  switch (outcome.kind) {
    case "completed":
      return outcome.text.endsWith(STEP_LIMIT_NOTICE) ? "max_model_turns" : "end_turn";
    case "interrupted":
      return "cancelled";
    case "failed":
      return /cut off/.test(outcome.error) ? "max_output_tokens" : "refused";
    case "paused":
      return "refused";
  }
}

export function parseRawInput(argumentsJson: string): unknown {
  try {
    return JSON.parse(argumentsJson);
  } catch {
    return undefined;
  }
}

export const isoTimestamp = (ms: number) => new Date(Math.max(ms, 0)).toISOString().replace(/\.\d{3}Z$/, "Z");

export const messageId = () => crypto.randomUUID().replace(/-/g, "");

type NameValue = { name: string; value: string };
const isNameValues = (v: unknown): v is NameValue[] =>
  Array.isArray(v) &&
  v.every(
    (e) =>
      typeof e === "object" &&
      e !== null &&
      typeof (e as NameValue).name === "string" &&
      typeof (e as NameValue).value === "string",
  );
const record = (pairs: NameValue[]) => Object.fromEntries(pairs.map((p) => [p.name, p.value]));

/** The client's `mcpServers` entries as core configs (source "acp"); null when malformed. */
export function parseMcpServers(raw: unknown): McpServerConfig[] | null {
  if (raw === undefined) return [];
  if (!Array.isArray(raw)) return null;
  const out: McpServerConfig[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) return null;
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== "string" || e.name.length === 0) return null;
    const base = {
      name: e.name,
      enabled: true,
      required: false,
      startup_timeout_ms: 30_000,
      operation_timeout_ms: 60_000,
      restart_limit: 3,
      source: "acp" as const,
    };
    if (e.type === "http" || e.type === "sse") {
      if (typeof e.url !== "string" || !/^https?:\/\//.test(e.url)) return null;
      if (e.headers !== undefined && !isNameValues(e.headers)) return null;
      out.push({ ...base, type: e.type, url: e.url, headers: record((e.headers as NameValue[] | undefined) ?? []) });
      continue;
    }
    if (e.type !== undefined && e.type !== "stdio") return null;
    if (typeof e.command !== "string" || e.command.length === 0) return null;
    if (e.args !== undefined && !(Array.isArray(e.args) && e.args.every((a) => typeof a === "string"))) return null;
    if (e.env !== undefined && !isNameValues(e.env)) return null;
    out.push({
      ...base,
      type: "stdio",
      command: [e.command, ...((e.args as string[] | undefined) ?? [])],
      environment: record((e.env as NameValue[] | undefined) ?? []),
    });
  }
  return out;
}
