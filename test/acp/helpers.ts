/** A scripted model, a fake subscription binding, and an in-process ACP client over PassThrough streams. */
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { type AcpDeps, createAcpServer } from "../../src/acp/server.ts";
import type { ModelBinding } from "../../src/cli/runtime.ts";
import type { Completion, LLM, Message, ToolCall, Usage } from "../../src/core/agent/types.ts";
import { TITLE_INSTRUCTIONS } from "../../src/core/session/title.ts";
import type { Subscription } from "../../src/providers/providers.ts";

export type Reply = {
  text?: string;
  chunks?: string[];
  toolCalls?: ToolCall[];
  usage?: Usage;
  /** Block until the request signal aborts, then throw like a cancelled fetch. */
  waitForAbort?: boolean;
  /** Reject the request with this message. */
  fail?: string;
};

export type ScriptedLLM = LLM & { calls: Message[][] };

/** Replies in order; a title request answers "Title"; an exhausted script answers "Done.". */
export function scriptedLLM(replies: Reply[]): ScriptedLLM {
  const calls: Message[][] = [];
  const queue = [...replies];
  return {
    calls,
    stream: async function* (messages, _tools, signal): AsyncGenerator<{ type: "text"; text: string }, Completion> {
      if (messages[0]?.content === TITLE_INSTRUCTIONS) return { content: "Title", toolCalls: [] };
      calls.push(messages);
      const reply = queue.shift() ?? { text: "Done." };
      if (reply.fail) throw new Error(reply.fail);
      if (reply.waitForAbort) {
        await new Promise<void>((resolve) => {
          if (signal?.aborted) resolve();
          else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      const chunks = reply.chunks ?? (reply.text !== undefined ? [reply.text] : []);
      for (const chunk of chunks) yield { type: "text", text: chunk };
      return {
        content: chunks.join(""),
        toolCalls: reply.toolCalls ?? [],
        usage: reply.usage ?? { inputTokens: 10, outputTokens: 5 },
      };
    },
  };
}

export const shellCall = (id: string, command: string, extra: Record<string, unknown> = {}): ToolCall => ({
  id,
  name: "shell",
  arguments: JSON.stringify({ request: { action: "run", command, yield_time_ms: 5000, ...extra } }),
});

export function fakeBinding(llm: LLM, model = "gpt-5.4", listed = [model, "gpt-5.4-mini"]): ModelBinding {
  const sub: Subscription = {
    label: "fake",
    login: async () => {},
    logout: async () => "",
    signedIn: () => true,
    models: async () => listed,
    llm: () => llm,
  };
  return { provider: "codex", model, sub, listed };
}

export function tempHome(): { home: string; cwd: string } {
  const home = realpathSync.native(mkdtempSync(join(tmpdir(), "nod-acp-")));
  const cwd = join(home, "ws");
  mkdirSync(cwd);
  return { home, cwd };
}

type Rpc = {
  jsonrpc: string;
  id?: number | string | null;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: unknown;
};

/** Speaks to an in-process server the way an editor would; `out` holds every frame the server wrote. */
export function connect(deps: Partial<AcpDeps> & { cwd: string; env: Record<string, string | undefined> }) {
  const server = createAcpServer({ version: "0.0.0-test", signedInProviders: () => ["codex"], ...deps });
  const input = new PassThrough();
  const out: Rpc[] = [];
  const served = server.serve(input, {
    write(chunk: string) {
      for (const line of chunk.split("\n")) if (line.trim()) out.push(JSON.parse(line));
    },
  });
  let nextId = 1;
  const raw = (line: string) => input.write(line);
  const waitFor = async <T extends Rpc>(pred: (m: Rpc) => boolean, timeoutMs = 5000): Promise<T> => {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const found = out.find(pred);
      if (found) return found as T;
      if (Date.now() > deadline)
        throw new Error(`timed out waiting; frames so far: ${JSON.stringify(out).slice(0, 2000)}`);
      await new Promise((r) => setTimeout(r, 5));
    }
  };
  return {
    server,
    out,
    raw,
    /** Sends a request and resolves with its response frame. */
    async request(method: string, params: unknown = {}): Promise<Rpc & { id: number }> {
      const id = nextId++;
      raw(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return waitFor((m) => m.id === id && m.method === undefined);
    },
    /** Sends a request without waiting; returns the id. */
    send(method: string, params: unknown = {}): number {
      const id = nextId++;
      raw(`${JSON.stringify({ jsonrpc: "2.0", id, method, params })}\n`);
      return id;
    },
    notify(method: string, params: unknown = {}) {
      raw(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
    },
    respond(id: number | string, result: unknown) {
      raw(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
    },
    waitFor,
    response: (id: number) => waitFor((m) => m.id === id && m.method === undefined),
    /** The next server→client request of this method not yet seen. */
    serverRequest: (method: string, seen: Set<unknown>) =>
      waitFor((m) => m.method === method && m.id !== undefined && !seen.has(m.id)),
    updates: (kind?: string) =>
      out
        .filter((m) => m.method === "session/update")
        .map((m) => (m.params as { update: Record<string, unknown> }).update)
        .filter((u) => kind === undefined || u.sessionUpdate === kind),
    async close() {
      input.end();
      await served;
    },
  };
}
