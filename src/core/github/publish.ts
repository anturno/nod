/** Draft parsing and `gh pr|issue create` (fx github_publish.zig). */
import type { WorkflowKind } from "./prompt.ts";

export type Draft = { title: string; body: string };
export type PublishResult = { ok: boolean; text: string };

export class InvalidGithubDraft extends Error {
  constructor() {
    super("InvalidGithubDraft");
  }
}

/** First non-blank line is the title; the rest, left-trimmed, is the body. */
export function parseDraft(text: string): Draft {
  const trimmed = text.trim();
  if (trimmed.length === 0) throw new InvalidGithubDraft();
  const firstBreak = trimmed.indexOf("\n");
  if (firstBreak < 0) return { title: trimmed, body: "" };
  const title = trimmed.slice(0, firstBreak).trim();
  if (title.length === 0) throw new InvalidGithubDraft();
  return { title, body: trimmed.slice(firstBreak + 1).replace(/^[ \t\r\n]+/, "") };
}

export const publishArgv = (kind: WorkflowKind, draft: Draft) => [
  "gh",
  kind,
  "create",
  "--title",
  draft.title,
  "--body",
  draft.body,
];

export function publish(
  kind: WorkflowKind,
  draft: Draft,
  deps: { cwd: string; env?: Record<string, string | undefined> },
): PublishResult {
  let r: ReturnType<typeof Bun.spawnSync>;
  try {
    r = Bun.spawnSync(publishArgv(kind, draft), { cwd: deps.cwd, env: deps.env, stdout: "pipe", stderr: "pipe" });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return { ok: false, text: "gh CLI not found in PATH" };
    throw err;
  }
  if (r.exitCode !== 0) return { ok: false, text: (r.stderr?.toString().trim() ?? "") || "gh command failed" };
  return { ok: true, text: (r.stdout?.toString().trim() ?? "") || "created successfully" };
}
