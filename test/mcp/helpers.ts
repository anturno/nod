import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { JsonRpcMessage } from "../../src/core/mcp/jsonrpc.ts";
import type { McpServerConfig, McpTransport, TransportHandlers } from "../../src/core/mcp/types.ts";

export const tempDir = (prefix = "nod-mcp-") => realpathSync.native(mkdtempSync(join(tmpdir(), prefix)));

export const FIXTURE = join(import.meta.dir, "fixtures", "stdio-server.ts");
export const fixtureCommand = () => [process.execPath, FIXTURE];

export const stdioConfig = (name: string, extra: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name,
  type: "stdio",
  command: fixtureCommand(),
  enabled: true,
  required: false,
  startup_timeout_ms: 5000,
  operation_timeout_ms: 5000,
  restart_limit: 1,
  source: "profile",
  ...extra,
});

export const httpConfig = (name: string, url: string, extra: Partial<McpServerConfig> = {}): McpServerConfig => ({
  name,
  type: "http",
  url,
  enabled: true,
  required: false,
  startup_timeout_ms: 5000,
  operation_timeout_ms: 5000,
  restart_limit: 1,
  source: "profile",
  ...extra,
});

export type FakeHandler = (method: string, params: unknown, ctx: { push(m: JsonRpcMessage): void }) => unknown;

/** An in-process server: `handler` answers requests; returning `undefined` for a notification is fine. */
export function fakeTransport(handler: FakeHandler, options: { log?: JsonRpcMessage[] } = {}) {
  let handlers: TransportHandlers | undefined;
  const transport = {
    open(h: TransportHandlers): McpTransport {
      handlers = h;
      return {
        async send(message) {
          options.log?.push(message);
          const push = (m: JsonRpcMessage) => h.onMessage(m);
          if (message.id === undefined || message.id === null) {
            handler(message.method as string, message.params, { push });
            return;
          }
          try {
            const result = await handler(message.method as string, message.params, { push });
            queueMicrotask(() => push({ jsonrpc: "2.0", id: message.id as number, result: result ?? {} }));
          } catch (e) {
            const err = e as { code?: number; message: string; data?: unknown };
            queueMicrotask(() =>
              push({
                jsonrpc: "2.0",
                id: message.id as number,
                error: { code: err.code ?? -32603, message: err.message, data: err.data },
              }),
            );
          }
        },
        async close() {
          h.onClose();
        },
      };
    },
    /** Server-initiated traffic. */
    push: (m: JsonRpcMessage) => handlers?.onMessage(m),
    drop: (reason?: Error) => handlers?.onClose(reason),
  };
  return transport;
}

export const initResult = (version = "2025-11-25", extra: Record<string, unknown> = {}) => ({
  protocolVersion: version,
  capabilities: { tools: { listChanged: true }, resources: {}, prompts: {} },
  serverInfo: { name: "fake", version: "1" },
  ...extra,
});
