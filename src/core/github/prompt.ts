/** The pull-request and issue drafting prompts. */

export type WorkflowKind = "pr" | "issue";

const SHARED = "Use this prepared git snapshot first and avoid shell commands unless they are truly necessary:";

export function buildPrompt(kind: WorkflowKind, context: string, snapshotText: string): string {
  const trimmed = context.trim();
  const extra = trimmed.length > 0 ? `Additional context: ${trimmed}. ` : "";
  return kind === "pr"
    ? `Draft a GitHub pull request for the current branch. Reply in the same natural language as the current session. ${extra}${SHARED}\n\n${snapshotText}\n\nIf you need more context, read relevant files. Return only: Title, blank line, then a GitHub-flavored Markdown body with sections '## Summary' and '## Testing'. Do not create the PR with gh or publish anything unless I explicitly ask you to.`
    : `Draft a GitHub issue from the current context. Reply in the same natural language as the current session. ${extra}${SHARED}\n\n${snapshotText}\n\nIf you need more context, inspect relevant files, errors, or logs. Return only: Title, blank line, then a GitHub-flavored Markdown body with sections '## Summary', '## Steps to Reproduce', '## Expected', and '## Actual'. Do not create the issue with gh or publish anything unless I explicitly ask you to.`;
}
