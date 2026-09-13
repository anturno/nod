/** The git snapshot the pr/issue prompts start from (fx git_context.zig). */

export type GitSnapshot = { inGitRepo: boolean; text: string };
export type SnapshotParts = { branch?: string; status?: string; log?: string; staged?: string; unstaged?: string };

function git(cwd: string, ...args: string[]): string | undefined {
  try {
    const r = Bun.spawnSync(["git", "--no-optional-locks", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) return undefined;
    const text = r.stdout.toString().trim();
    return text.length > 0 ? text : undefined;
  } catch {
    return undefined;
  }
}

export const isGitRepository = (cwd: string) => git(cwd, "rev-parse", "--is-inside-work-tree") === "true";

const body = (value: string | undefined, fallback: string) => {
  const text = value ?? fallback;
  return text.endsWith("\n") ? text : `${text}\n`;
};

export function formatSnapshot(p: SnapshotParts): string {
  return (
    `Git snapshot\nBranch: ${p.branch ?? "unavailable"}\n` +
    `\nStatus:\n${body(p.status, "unavailable")}` +
    `\nRecent commits:\n${body(p.log, "unavailable")}` +
    `\nStaged diff stat:\n${body(p.staged, "none")}` +
    `\nUnstaged diff stat:\n${body(p.unstaged, "none")}`
  );
}

export function snapshot(cwd: string): GitSnapshot {
  return {
    inGitRepo: isGitRepository(cwd),
    text: formatSnapshot({
      branch: git(cwd, "branch", "--show-current"),
      status: git(cwd, "status", "--short", "--branch"),
      log: git(cwd, "log", "--oneline", "-5"),
      staged: git(cwd, "diff", "--stat", "--cached"),
      unstaged: git(cwd, "diff", "--stat"),
    }),
  };
}
