/** Child agents as seen by the subagent tool. Filled in by the subagent module. */

export type SubagentOptions = { model?: string; effort?: string; instructions?: string };
export type SubagentOutcome =
  | { ok: true; result: string; toolCalls: { name: string; status: string }[] }
  | { ok: false; error_code: string; message?: string };

export type SubagentService = {
  run(task: string, opts: SubagentOptions, signal?: AbortSignal): Promise<SubagentOutcome>;
  message(agent: string, message: string, opts: SubagentOptions, signal?: AbortSignal): Promise<SubagentOutcome>;
};
