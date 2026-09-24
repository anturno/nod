/** Provider-neutral contracts shared by the agent loop, the tools, the providers, and the UIs. */

export type ToolCall = { id: string; name: string; arguments: string };
export type ToolStatus = "success" | "failure";
export type ImageRef = { id: number; mime: string; data: string; path?: string };

/** What the runtime remembers about one tool result beyond the text the model saw. */
export type ToolResultMemory = {
  outputHandle?: string;
  preview?: string;
  outputBytes: number;
  storedBytes: number;
  truncated: boolean;
  commandOutputHandle?: string;
};

export type Message =
  | { role: "system"; content: string }
  | { role: "user"; content: string; images?: ImageRef[]; permissionFeedback?: boolean; toolCallId?: string }
  | { role: "assistant"; content: string; toolCalls: ToolCall[] }
  | { role: "tool"; toolCallId: string; name: string; content: string; status?: ToolStatus; memory?: ToolResultMemory };

export type ToolSpec = { name: string; description: string; parameters: Record<string, unknown> };
export type StreamEvent =
  | { type: "reasoning" | "text"; text: string }
  | { type: "provider_tool"; name: string; status: "started" | "completed" };
export type Usage = {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  reasoningTokens?: number;
};
export type Completion = { content: string; toolCalls: ToolCall[]; usage?: Usage; incomplete?: string };

export type StreamOptions = {
  toolChoice?: "auto" | "required" | "none";
  maxOutputTokens?: number;
  parallelToolCalls?: boolean;
  /** Provider-executed tools sent verbatim in the request, such as {"type":"web_search"}. */
  providerTools?: Record<string, unknown>[];
  effort?: string;
};

/** The model. Streams reasoning and text as it arrives and returns the finished reply. */
export type LLM = {
  stream(
    messages: Message[],
    tools: ToolSpec[],
    signal?: AbortSignal,
    options?: StreamOptions,
  ): AsyncGenerator<StreamEvent, Completion>;
};

export type ToolStep = {
  assistant: string;
  toolCalls: ToolCall[];
  results: Extract<Message, { role: "tool" }>[];
  feedback?: Extract<Message, { role: "user" }>[];
};
export type ExecutionMemory = { steps: ToolStep[]; steering: { text: string; afterStep: number }[] };
export type UserTurn = { text: string; images?: ImageRef[] };

export type HistoryTurn =
  | { kind: "assistant"; user: UserTurn; assistant: string; execution: ExecutionMemory }
  | {
      kind: "interrupted";
      user: UserTurn;
      assistant?: string;
      activeToolCall?: ToolCall;
      completedToolNames: string[];
      execution: ExecutionMemory;
      reason: "cancelled" | "failed";
      origin: "turn" | "compaction";
    }
  | { kind: "compacted_summary"; handoff: string; removedTurns: number };

export type PermissionMode = "ask" | "auto" | "yolo";
export type DenialReason =
  | "user_denied"
  | "auto_denied"
  | "review_caution"
  | "review_evidence_incomplete"
  | "review_unavailable"
  | "policy_denied"
  | "permission_required";

export type Provider = "codex" | "grok";
export type Effort = "auto" | "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
