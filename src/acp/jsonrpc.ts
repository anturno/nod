/** NDJSON JSON-RPC 2.0 framing for the ACP server: one message per line, 8 MiB per input line. */

export const MAX_FRAME_BYTES = 8 * 1024 * 1024;

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;
export const INTERNAL_ERROR = -32603;
export const FRAME_TOO_LARGE = -32000;

export type Id = number | string | null;
export type RpcError = { code: number; message: string; data?: unknown };
export type Message = {
  jsonrpc?: string;
  id?: Id;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: RpcError;
};

/** A parsed line, a parse failure, or an oversized line (already skipped through its newline). */
export type Frame = { kind: "message"; message: Message } | { kind: "parse_error" } | { kind: "too_large" };

export class RpcFailure extends Error {
  constructor(
    readonly code: number,
    message: string,
    readonly data?: unknown,
  ) {
    super(message);
  }
}

/** Reads NDJSON frames from a byte stream; ends when the stream ends. */
export async function* readFrames(
  input: AsyncIterable<Uint8Array | string>,
  maxBytes = MAX_FRAME_BYTES,
): AsyncGenerator<Frame> {
  let pending: Buffer[] = [];
  let pendingBytes = 0;
  let discarding = false;
  const flush = (): Frame | null => {
    const line = Buffer.concat(pending).toString("utf8").trim();
    pending = [];
    pendingBytes = 0;
    if (line.length === 0) return null;
    try {
      const parsed: unknown = JSON.parse(line);
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return { kind: "parse_error" };
      return { kind: "message", message: parsed as Message };
    } catch {
      return { kind: "parse_error" };
    }
  };
  for await (const chunk of input) {
    let buf = typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk);
    for (;;) {
      const nl = buf.indexOf(10);
      if (nl < 0) {
        if (!discarding) {
          pending.push(buf);
          pendingBytes += buf.length;
          if (pendingBytes > maxBytes) {
            pending = [];
            pendingBytes = 0;
            discarding = true;
            yield { kind: "too_large" };
          }
        }
        break;
      }
      const head = buf.subarray(0, nl);
      buf = buf.subarray(nl + 1);
      if (discarding) {
        discarding = false;
        continue;
      }
      pending.push(head);
      pendingBytes += head.length;
      if (pendingBytes > maxBytes) {
        pending = [];
        pendingBytes = 0;
        yield { kind: "too_large" };
        continue;
      }
      const frame = flush();
      if (frame) yield frame;
    }
  }
  if (!discarding && pendingBytes > 0) {
    const frame = flush();
    if (frame) yield frame;
  }
}

export const response = (id: Id, result: unknown) => ({ jsonrpc: "2.0", id, result });
export const errorResponse = (id: Id, code: number, message: string, data?: unknown) => ({
  jsonrpc: "2.0",
  id,
  error: { code, message, ...(data === undefined ? {} : { data }) },
});
export const notification = (method: string, params: unknown) => ({ jsonrpc: "2.0", method, params });
export const request = (id: Id, method: string, params: unknown) => ({ jsonrpc: "2.0", id, method, params });

export const encodeFrame = (message: unknown) => `${JSON.stringify(message)}\n`;
