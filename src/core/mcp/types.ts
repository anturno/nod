/** The MCP runtime as seen by the tools. Filled in by the MCP client module. */
import type { ToolResult, ToolSpec } from "../tools/spec.ts";

export type McpService = {
  /** Tools whose schemas are currently selected for the model, as mcp_<server>_<tool>. */
  tools(): ToolSpec[];
  search(query: string, server?: string): Promise<{ text: string; selected: string[]; notice?: string }>;
  select(name: string): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  features(request: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
  call(alias: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
  serverNames(): string[];
};

/** Configuration and runtime contracts shared by the MCP client, the commands, and the integrator. */
export type McpTransportType = "stdio" | "http" | "sse";
export type McpSource = "profile" | "project" | "acp";
export type McpAdmission = "pending" | "approved" | "rejected";

export type McpOAuthConfig = {
  resource?: string;
  issuer?: string;
  client_id?: string;
  client_secret_env?: string;
  client_metadata_url?: string;
  scopes?: string[];
};

export type McpServerConfig = {
  name: string;
  type: McpTransportType;
  command?: string[];
  environment?: Record<string, string>;
  url?: string;
  headers?: Record<string, string>;
  header_env?: Record<string, string>;
  bearer_token_env?: string;
  oauth?: McpOAuthConfig;
  enabled: boolean;
  required: boolean;
  startup_timeout_ms: number;
  operation_timeout_ms: number;
  restart_limit: number;
  source: McpSource;
  admission?: McpAdmission;
};

export type McpServerState =
  | "starting"
  | "ready"
  | "failed"
  | "unauthenticated"
  | "reloading"
  | "pending"
  | "rejected"
  | "disabled";

/** What `/mcp list` and `health()` show; never commands, env, headers, credentials, or URLs. */
export type McpServerHealth = {
  name: string;
  transport: McpTransportType;
  source: McpSource;
  required: boolean;
  state: McpServerState;
  admission?: McpAdmission;
  protocolVersion?: string;
  serverName?: string;
  serverVersion?: string;
  counts: { tools?: number; resources?: number; templates?: number; prompts?: number };
  failure?: string;
  retryInMs?: number;
  restarts: number;
};

export type McpToolDef = {
  name: string;
  title?: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type McpContent =
  | { type: "text"; text: string }
  | { type: "image"; data: string; mimeType: string }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "resource"; resource: { uri: string; text?: string; blob?: string; mimeType?: string } }
  | { type: "resource_link"; uri: string; name?: string; description?: string; mimeType?: string };

export type McpToolCallResult = { content: McpContent[]; structuredContent?: unknown; isError: boolean };

export type McpRuntime = McpService & {
  /** Connects required servers before resolving; optional servers keep connecting in the background. */
  start(): Promise<{ diagnostics: string[] }>;
  /** Builds and connects the next set before swapping; keeps the old set when a required server fails. */
  reload(next?: McpServerConfig[]): Promise<{ ok: boolean; diagnostics: string[] }>;
  health(): McpServerHealth[];
  /** Resolves once every in-flight connection attempt has finished (optional servers included). */
  settle(): Promise<void>;
  /** Configuration problems found by the last load (profile warnings, .mcp.json issues). */
  diagnostics(): string[];
  server(name: string): import("./client.ts").McpClient | undefined;
  close(): Promise<void>;
};

/** What every transport gives the client: a way to send frames and callbacks for what arrives. */
export type TransportHandlers = {
  onMessage(message: import("./jsonrpc.ts").JsonRpcMessage): void;
  /** The connection ended; `reason` is undefined for a clean close. */
  onClose(reason?: Error): void;
};
export type McpTransport = {
  send(message: import("./jsonrpc.ts").JsonRpcMessage): Promise<void>;
  close(): Promise<void>;
  /** Streamable HTTP: value of MCP-Protocol-Version after negotiation. */
  setProtocolVersion?(version: string): void;
  /** Streamable HTTP: forget the Mcp-Session-Id before a re-initialize. */
  resetSession?(): void;
  /** stdio: the last lines the server wrote to stderr. */
  stderrTail?(): string[];
};
