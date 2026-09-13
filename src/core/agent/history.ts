/** Projects saved history turns into the provider-neutral message list a request is built from. */
import type { HistoryTurn, Message, ToolCall } from "./types.ts";

export const TURN_ABORTED_CONTEXT =
  "<turn_aborted>\nThe previous turn ended before completion. Any tools or commands may have partially executed. Do not continue this request unless the user explicitly asks to continue.\n</turn_aborted>";
export const INTERRUPTED_BEFORE_COMPLETION = "The previous response ended before completion.";

export function completedToolSummary(names: string[]): string {
  return `Interrupted by user after completing ${names.length} tool call${names.length === 1 ? "" : "s"}: ${names.join(", ")}.`;
}

/** The assistant text that closes an interrupted turn, so the model sees what happened. */
export function interruptedClosure(assistant: string | undefined, completed: string[]): string {
  const partial = assistant && assistant.length > 0 ? assistant : undefined;
  if (completed.length > 0) {
    const summary = completedToolSummary(completed);
    return partial ? `${partial}\n\n${summary}` : summary;
  }
  return partial ? `${partial}\n\n${INTERRUPTED_BEFORE_COMPLETION}` : INTERRUPTED_BEFORE_COMPLETION;
}

/** Every replayed function call has an output; calls without one are dropped so the history stays valid. */
function executionMessages(turn: Extract<HistoryTurn, { kind: "assistant" | "interrupted" }>): Message[] {
  const out: Message[] = [];
  turn.execution.steps.forEach((step, index) => {
    const answered = new Set(step.results.map((r) => r.toolCallId));
    const calls: ToolCall[] = step.toolCalls.filter((c) => answered.has(c.id));
    if (step.assistant || calls.length) out.push({ role: "assistant", content: step.assistant, toolCalls: calls });
    for (const call of calls) {
      const result = step.results.find((r) => r.toolCallId === call.id);
      if (result) out.push(result);
    }
    for (const feedback of step.feedback ?? []) out.push(feedback);
    for (const s of turn.execution.steering) if (s.afterStep === index) out.push({ role: "user", content: s.text });
  });
  return out;
}

export function projectHistory(history: HistoryTurn[]): Message[] {
  const out: Message[] = [];
  for (const turn of history) {
    switch (turn.kind) {
      case "compacted_summary":
        out.push({ role: "user", content: turn.handoff });
        break;
      case "assistant":
        out.push({ role: "user", content: turn.user.text, images: turn.user.images });
        out.push(...executionMessages(turn));
        out.push({ role: "assistant", content: turn.assistant, toolCalls: [] });
        break;
      case "interrupted":
        out.push({ role: "user", content: turn.user.text, images: turn.user.images });
        out.push(...executionMessages(turn));
        out.push({
          role: "assistant",
          content: interruptedClosure(turn.assistant, turn.completedToolNames),
          toolCalls: [],
        });
        out.push({ role: "user", content: TURN_ABORTED_CONTEXT });
        break;
    }
  }
  return out;
}
