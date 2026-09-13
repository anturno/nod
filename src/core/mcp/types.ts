/** The MCP runtime as seen by the tools. Filled in by the MCP client module. */
import type { ToolResult, ToolSpec } from "../tools/spec.ts";

export type McpService = {
  /** Tools whose schemas are currently selected for the model, as mcp_<server>_<tool>. */
  tools(): ToolSpec[];
  search(query: string, server?: string): Promise<{ text: string; selected: string[] }>;
  select(name: string): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  features(request: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
  call(alias: string, args: Record<string, unknown>, signal?: AbortSignal): Promise<ToolResult>;
  serverNames(): string[];
};
