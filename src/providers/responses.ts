/** The LLM contract over an OpenAI Responses API stream. Shared by the ChatGPT and Grok subscription backends. */
import type {
  Completion,
  LLM,
  Message,
  StreamEvent,
  StreamOptions,
  ToolCall,
  ToolSpec,
  Usage,
} from "../core/agent/types.ts";
import type { Credential, CredentialSource } from "./auth/store.ts";

export type ResponsesOptions = {
  /** Used in error messages. */
  name: string;
  url: string;
  model: string;
  credential: CredentialSource;
  headers: (credential: Credential) => Record<string, string>;
  /** Merged into every request body. */
  extraBody?: Record<string, unknown>;
  /** Send tool_choice and parallel_tool_calls even without tools (the Codex endpoint expects them). */
  alwaysToolFields?: boolean;
  fetcher?: typeof fetch;
};

const RETRIES = 4;

/** System messages become instructions, which the Codex endpoint requires. Reasoning is not replayed. */
export function buildBody(
  model: string,
  messages: Message[],
  tools: ToolSpec[],
  opts: Pick<ResponsesOptions, "extraBody" | "alwaysToolFields"> = {},
  options: StreamOptions = {},
) {
  const instructions =
    messages.flatMap((m) => (m.role === "system" ? [m.content] : [])).join("\n\n") || "You are a helpful assistant.";
  const input = messages.flatMap((m): object[] => {
    if (m.role === "tool") return [{ type: "function_call_output", call_id: m.toolCallId, output: m.content }];
    if (m.role !== "assistant") {
      if (m.role !== "user") return [];
      const images = (m.images ?? []).map((i) => ({
        type: "input_image",
        image_url: `data:${i.mime};base64,${i.data}`,
      }));
      return [{ role: "user", content: [{ type: "input_text", text: m.content }, ...images] }];
    }
    const text = m.content
      ? [{ type: "message", role: "assistant", content: [{ type: "output_text", text: m.content }] }]
      : [];
    return [
      ...text,
      ...m.toolCalls.map((c) => ({ type: "function_call", call_id: c.id, name: c.name, arguments: c.arguments })),
    ];
  });
  const providerTools = options.providerTools ?? [];
  const toolFields =
    tools.length || providerTools.length || opts.alwaysToolFields
      ? {
          tools: [
            ...tools.map((t) => ({
              type: "function",
              name: t.name,
              description: t.description,
              parameters: t.parameters,
              strict: false,
            })),
            ...providerTools,
          ],
          tool_choice: options.toolChoice ?? "auto",
          parallel_tool_calls: options.parallelToolCalls ?? true,
        }
      : {};
  const limits = options.maxOutputTokens ? { max_output_tokens: options.maxOutputTokens } : {};
  const effort = options.effort && options.effort !== "auto" ? { reasoning: { effort: options.effort } } : {};
  return {
    model,
    instructions,
    input,
    ...toolFields,
    ...limits,
    store: false,
    stream: true,
    ...opts.extraBody,
    ...(effort.reasoning ? { reasoning: { ...(opts.extraBody?.reasoning as object), ...effort.reasoning } } : {}),
  };
}

type SseEvent = {
  type?: string;
  delta?: string;
  item?: { type?: string; call_id?: string; name?: string; arguments?: string };
  response?: {
    error?: { message?: string };
    incomplete_details?: { reason?: string };
    usage?: {
      input_tokens?: number;
      output_tokens?: number;
      input_tokens_details?: { cached_tokens?: number };
      output_tokens_details?: { reasoning_tokens?: number };
    };
  };
  message?: string;
};

function usageOf(e: SseEvent): Usage | undefined {
  const u = e.response?.usage;
  if (!u) return undefined;
  return {
    inputTokens: u.input_tokens,
    outputTokens: u.output_tokens,
    cacheReadTokens: u.input_tokens_details?.cached_tokens,
    reasoningTokens: u.output_tokens_details?.reasoning_tokens,
  };
}

async function* events(body: ReadableStream<Uint8Array>): AsyncGenerator<SseEvent> {
  let buffer = "";
  const decoder = new TextDecoder();
  for await (const chunk of body) {
    buffer += decoder.decode(chunk, { stream: true }).replaceAll("\r\n", "\n");
    for (let end = buffer.indexOf("\n\n"); end >= 0; end = buffer.indexOf("\n\n")) {
      const data = buffer
        .slice(0, end)
        .split("\n")
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice(5).trimStart())
        .join("\n");
      buffer = buffer.slice(end + 2);
      if (data === "[DONE]") return;
      if (data) yield JSON.parse(data) as SseEvent;
    }
  }
}

export async function* parseStream(name: string, response: Response): AsyncGenerator<StreamEvent, Completion> {
  if (!response.body) throw new Error(`${name} returned an empty response.`);
  let content = "";
  const toolCalls: ToolCall[] = [];
  for await (const event of events(response.body)) {
    switch (event.type) {
      case "response.output_text.delta":
        content += event.delta ?? "";
        if (event.delta) yield { type: "text", text: event.delta };
        break;
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_text.delta":
        if (event.delta) yield { type: "reasoning", text: event.delta };
        break;
      case "response.output_item.added":
        if (event.item?.type?.endsWith("_call") && event.item.type !== "function_call")
          yield { type: "provider_tool", name: event.item.type.replace(/_call$/, ""), status: "started" };
        break;
      case "response.output_item.done":
        if (event.item?.type === "function_call")
          toolCalls.push({
            id: event.item.call_id || `call_${toolCalls.length}`,
            name: event.item.name ?? "",
            arguments: event.item.arguments ?? "",
          });
        else if (event.item?.type?.endsWith("_call"))
          yield { type: "provider_tool", name: event.item.type.replace(/_call$/, ""), status: "completed" };
        break;
      case "response.failed":
        throw new Error(`${name}: ${event.response?.error?.message ?? "the response failed"}`);
      case "response.incomplete":
        return {
          content,
          toolCalls,
          usage: usageOf(event),
          incomplete: event.response?.incomplete_details?.reason ?? "unknown reason",
        };
      case "error":
        throw new Error(`${name}: ${event.message ?? "stream error"}`);
      case "response.completed":
        return { content, toolCalls, usage: usageOf(event) };
    }
  }
  return { content, toolCalls };
}

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal?.addEventListener("abort", () => (clearTimeout(timer), resolve()), { once: true });
  });

function errorMessage(text: string) {
  try {
    const json = JSON.parse(text) as { error?: { message?: string } | string; detail?: string; message?: string };
    return (typeof json.error === "string" ? json.error : json.error?.message) ?? json.detail ?? json.message ?? text;
  } catch {
    return text.slice(0, 500);
  }
}

export function responsesLLM(opts: ResponsesOptions): LLM {
  const fetcher = opts.fetcher ?? fetch;
  return {
    async *stream(messages, tools, signal, options) {
      const body = JSON.stringify(buildBody(opts.model, messages, tools, opts, options));
      // Nothing has been yielded before a response is accepted, so replaying after a 401 or 429 is safe.
      let refreshed = false;
      let mode: "if_needed" | "force" = "if_needed";
      for (let attempt = 0; ; attempt++) {
        const credential = await opts.credential(mode);
        mode = "if_needed";
        const res = await fetcher(opts.url, {
          method: "POST",
          headers: {
            ...opts.headers(credential),
            authorization: `Bearer ${credential.token}`,
            "content-type": "application/json",
            accept: "text/event-stream",
          },
          body,
          signal,
        });
        if (res.ok) return yield* parseStream(opts.name, res);
        const text = await res.text();
        if (res.status === 401 && !refreshed) {
          refreshed = true;
          mode = "force";
          continue;
        }
        if ((res.status === 429 || res.status >= 500) && attempt < RETRIES) {
          await sleep(Math.min(2000 * 2 ** attempt, 20_000), signal);
          if (signal?.aborted) throw signal.reason;
          continue;
        }
        throw new Error(`${opts.name} (${res.status}): ${errorMessage(text)}`);
      }
    },
  };
}
