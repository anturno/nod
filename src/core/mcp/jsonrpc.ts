/** JSON-RPC 2.0 peer shared by the MCP transports and the ACP server: envelope validation, ids, timeouts, cancellation. */
import { MAX_FRAME_BYTES } from "./limits.ts";

export type JsonRpcId = number | string;
export type JsonRpcError = { code: number; message: string; data?: unknown };
export type JsonRpcMessage = {
  jsonrpc: "2.0";
  id?: JsonRpcId | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: JsonRpcError;
};

export class JsonRpcRemoteError extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}
export class JsonRpcFrameError extends Error {}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const validId = (id: unknown): id is JsonRpcId | null =>
  id === null || typeof id === "string" || (typeof id === "number" && Number.isFinite(id));

/** Validates one decoded JSON value as a request, notification, or response. */
export function validateMessage(value: unknown): JsonRpcMessage {
  if (!isObject(value)) throw new JsonRpcFrameError("JSON-RPC message must be an object");
  if (value.jsonrpc !== "2.0") throw new JsonRpcFrameError('JSON-RPC message requires "jsonrpc":"2.0"');
  if ("id" in value && !validId(value.id)) throw new JsonRpcFrameError("JSON-RPC id must be a string, number, or null");
  if (typeof value.method === "string") {
    if ("params" in value && value.params !== undefined && !isObject(value.params) && !Array.isArray(value.params))
      throw new JsonRpcFrameError("JSON-RPC params must be an object or array");
    return value as JsonRpcMessage;
  }
  if ("method" in value) throw new JsonRpcFrameError("JSON-RPC method must be a string");
  const hasResult = "result" in value;
  const hasError = "error" in value;
  if (hasResult === hasError) throw new JsonRpcFrameError("JSON-RPC response requires exactly one of result or error");
  if (hasError) {
    const e = value.error;
    if (!isObject(e) || typeof e.code !== "number" || typeof e.message !== "string")
      throw new JsonRpcFrameError("JSON-RPC error requires numeric code and string message");
  }
  if (!("id" in value)) throw new JsonRpcFrameError("JSON-RPC response requires an id");
  return value as JsonRpcMessage;
}

/** Parses one NDJSON frame; the byte cap protects the process from a hostile peer. */
export function parseFrame(line: string, maxBytes = MAX_FRAME_BYTES): JsonRpcMessage {
  if (Buffer.byteLength(line) > maxBytes) throw new JsonRpcFrameError("request frame too large");
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new JsonRpcFrameError("JSON-RPC frame is not valid JSON");
  }
  return validateMessage(parsed);
}

export const encodeFrame = (message: object): string => `${JSON.stringify(message)}\n`;

export type RequestOptions = { timeoutMs?: number; signal?: AbortSignal };

export type JsonRpcPeer = {
  request(method: string, params?: unknown, options?: RequestOptions): Promise<unknown>;
  notify(method: string, params?: unknown): Promise<void>;
  /** Feed one validated incoming message (a transport calls this). */
  receive(message: JsonRpcMessage): void;
  /** Rejects every pending request; used when the transport closes. */
  fail(error: Error): void;
  pending(): number;
};

export type PeerOptions = {
  send(message: JsonRpcMessage): Promise<void> | void;
  onNotification?(method: string, params: unknown): void;
  /** Returns the result, or throws JsonRpcRemoteError to answer with an error. */
  onRequest?(method: string, params: unknown): Promise<unknown> | unknown;
  defaultTimeoutMs?: number;
  /** Method name of the cancellation notification sent when a request is aborted or times out. */
  cancelMethod?: string | null;
};

export function createJsonRpcPeer(options: PeerOptions): JsonRpcPeer {
  const pending = new Map<JsonRpcId, { resolve(v: unknown): void; reject(e: Error): void; cleanup(): void }>();
  let nextId = 1;
  const cancelMethod = options.cancelMethod === undefined ? "notifications/cancelled" : options.cancelMethod;

  const settle = (id: JsonRpcId, fn: (entry: { resolve(v: unknown): void; reject(e: Error): void }) => void) => {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    entry.cleanup();
    fn(entry);
  };

  const respond = async (message: JsonRpcMessage) => {
    const id = message.id as JsonRpcId;
    try {
      if (!options.onRequest) throw new JsonRpcRemoteError(-32601, `Method not found: ${message.method}`);
      const result = await options.onRequest(message.method as string, message.params);
      await options.send({ jsonrpc: "2.0", id, result: result ?? {} });
    } catch (e) {
      const error =
        e instanceof JsonRpcRemoteError
          ? { code: e.code, message: e.message, ...(e.data !== undefined ? { data: e.data } : {}) }
          : { code: -32603, message: e instanceof Error ? e.message : String(e) };
      await Promise.resolve(options.send({ jsonrpc: "2.0", id, error })).catch(() => {});
    }
  };

  return {
    request(method, params, opts = {}) {
      const id = nextId++;
      const timeoutMs = opts.timeoutMs ?? options.defaultTimeoutMs;
      return new Promise<unknown>((resolve, reject) => {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const cancel = (reason: string, error: Error) => {
          settle(id, (entry) => entry.reject(error));
          if (cancelMethod)
            Promise.resolve(
              options.send({ jsonrpc: "2.0", method: cancelMethod, params: { requestId: id, reason } }),
            ).catch(() => {});
        };
        const onAbort = () => cancel("client cancelled", abortError());
        const cleanup = () => {
          if (timer) clearTimeout(timer);
          opts.signal?.removeEventListener("abort", onAbort);
        };
        pending.set(id, { resolve, reject, cleanup });
        if (opts.signal?.aborted) return onAbort();
        opts.signal?.addEventListener("abort", onAbort, { once: true });
        if (timeoutMs && timeoutMs > 0)
          timer = setTimeout(
            () => cancel("timeout", new Error(`MCP request ${method} timed out after ${timeoutMs} ms`)),
            timeoutMs,
          );
        Promise.resolve(
          options.send({ jsonrpc: "2.0", id, method, ...(params === undefined ? {} : { params }) }),
        ).catch((e: unknown) => settle(id, (entry) => entry.reject(e instanceof Error ? e : new Error(String(e)))));
      });
    },
    async notify(method, params) {
      await options.send({ jsonrpc: "2.0", method, ...(params === undefined ? {} : { params }) });
    },
    receive(message) {
      if (typeof message.method === "string") {
        if (message.id === undefined || message.id === null) options.onNotification?.(message.method, message.params);
        else void respond(message);
        return;
      }
      if (message.id === null || message.id === undefined) return;
      settle(message.id, (entry) =>
        message.error
          ? entry.reject(new JsonRpcRemoteError(message.error.code, message.error.message, message.error.data))
          : entry.resolve(message.result),
      );
    },
    fail(error) {
      for (const id of [...pending.keys()]) settle(id, (entry) => entry.reject(error));
    },
    pending: () => pending.size,
  };
}

export const abortError = (): Error => Object.assign(new Error("The operation was aborted."), { name: "AbortError" });
export const isAbortError = (e: unknown): boolean => e instanceof Error && e.name === "AbortError";
