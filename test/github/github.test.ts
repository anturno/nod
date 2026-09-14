import { describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseWorkflowArgs, runIssue, runPr } from "../../src/cli/github.ts";
import type { Io } from "../../src/cli/output.ts";
import { buildPrompt } from "../../src/core/github/prompt.ts";
import { parseDraft, publish, publishArgv } from "../../src/core/github/publish.ts";
import { formatSnapshot, isGitRepository, snapshot } from "../../src/core/github/snapshot.ts";

const tmp = () => realpathSync.native(mkdtempSync(join(tmpdir(), "nod-github-")));
const git = (cwd: string, ...args: string[]) => {
  const r = Bun.spawnSync(["git", "-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd });
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
};

describe("github snapshot", () => {
  test("formats fallbacks exactly", () => {
    expect(formatSnapshot({})).toBe(
      "Git snapshot\nBranch: unavailable\n\nStatus:\nunavailable\n\nRecent commits:\nunavailable\n\nStaged diff stat:\nnone\n\nUnstaged diff stat:\nnone\n",
    );
  });

  test("reads branch, status, log, and diff stats from a repo", () => {
    const cwd = tmp();
    expect(isGitRepository(cwd)).toBe(false);
    expect(snapshot(cwd).inGitRepo).toBe(false);
    git(cwd, "init", "-q", "-b", "main");
    writeFileSync(join(cwd, "a.txt"), "one\n");
    git(cwd, "add", "a.txt");
    git(cwd, "commit", "-q", "-m", "first");
    writeFileSync(join(cwd, "a.txt"), "one\ntwo\n");
    writeFileSync(join(cwd, "b.txt"), "b\n");
    git(cwd, "add", "b.txt");
    const snap = snapshot(cwd);
    expect(snap.inGitRepo).toBe(true);
    expect(snap.text).toContain("Branch: main\n");
    expect(snap.text).toContain("\nStatus:\n## main\n");
    expect(snap.text).toContain(" M a.txt\n");
    expect(snap.text).toContain("A  b.txt\n");
    expect(snap.text).toMatch(/\nRecent commits:\n[0-9a-f]+ first\n/);
    expect(snap.text).toContain("\nStaged diff stat:\nb.txt | 1 +\n");
    expect(snap.text).toContain("\nUnstaged diff stat:\na.txt | 1 +\n");
  });
});

describe("github prompts and drafts", () => {
  test("pr and issue prompts follow the contract", () => {
    const pr = buildPrompt("pr", " ready for review \n", "Git snapshot\nBranch: feature\n");
    expect(pr).toContain("Draft a GitHub pull request for the current branch.");
    expect(pr).toContain("Additional context: ready for review.");
    expect(pr).toContain("Git snapshot\nBranch: feature\n");
    expect(pr).toContain("## Summary");
    expect(pr).toContain("## Testing");
    expect(pr).not.toContain("## Steps to Reproduce");
    expect(pr).toContain("Do not create the PR with gh or publish anything unless I explicitly ask you to.");
    const issue = buildPrompt("issue", " \t\r\n", "Git snapshot\nBranch: unavailable\n");
    expect(issue).toContain("Draft a GitHub issue from the current context.");
    expect(issue).not.toContain("Additional context:");
    for (const s of ["## Summary", "## Steps to Reproduce", "## Expected", "## Actual"]) expect(issue).toContain(s);
    expect(issue).toContain("Do not create the issue with gh or publish anything unless I explicitly ask you to.");
  });

  test("parseDraft takes the first line as the title", () => {
    expect(parseDraft("Title\n\n## Summary\nhello")).toEqual({ title: "Title", body: "## Summary\nhello" });
    expect(parseDraft("Title only")).toEqual({ title: "Title only", body: "" });
    expect(parseDraft("  Title with space  \n\n  body ")).toEqual({ title: "Title with space", body: "body" });
    expect(() => parseDraft(" \n\t ")).toThrow("InvalidGithubDraft");
  });

  test("publishes through gh and reports its failures", () => {
    expect(publishArgv("pr", { title: "A title", body: "Body" })).toEqual([
      "gh",
      "pr",
      "create",
      "--title",
      "A title",
      "--body",
      "Body",
    ]);
    expect(publishArgv("issue", { title: "A", body: "B" })[1]).toBe("issue");
    const bin = tmp();
    const log = join(bin, "gh.log");
    writeFileSync(
      join(bin, "gh"),
      `#!/bin/sh\nprintf '%s\\n' "$@" > "${log}"\nif [ "$1" = issue ]; then echo "boom" >&2; exit 1; fi\necho "https://github.com/o/r/pull/1"\n`,
    );
    chmodSync(join(bin, "gh"), 0o755);
    const env = { ...process.env, PATH: `${bin}:${process.env.PATH}` };
    expect(publish("pr", { title: "T", body: "B\nC" }, { cwd: bin, env })).toEqual({
      ok: true,
      text: "https://github.com/o/r/pull/1",
    });
    expect(Bun.file(log).text()).resolves.toBe("pr\ncreate\n--title\nT\n--body\nB\nC\n");
    expect(publish("issue", { title: "T", body: "" }, { cwd: bin, env })).toEqual({ ok: false, text: "boom" });
    expect(
      publish("pr", { title: "T", body: "" }, { cwd: bin, env: { ...env, PATH: bin.replace("nod", "no") } }),
    ).toEqual({
      ok: false,
      text: "gh CLI not found in PATH",
    });
  });
});

describe("nod pr / nod issue", () => {
  test("parses leading flags and joins the context", () => {
    expect(parseWorkflowArgs(["--auto", "--create", "ready", "now"])).toEqual({
      auto: true,
      create: true,
      context: "ready now",
    });
    expect(parseWorkflowArgs(["ready", "--auto"])).toEqual({ auto: false, create: false, context: "ready --auto" });
  });

  test("refuses to run outside a git repository", async () => {
    const cwd = tmp();
    const err: string[] = [];
    const io: Io = { stdout: () => {}, stderr: (t) => void err.push(t), env: { NOD_HOME: cwd }, cwd, isTTY: false };
    expect(await runPr(["ctx"], io)).toBe(1);
    expect(await runIssue([], io)).toBe(1);
    expect(err).toEqual([
      "nod pr: requires running inside a git repository\n",
      "nod issue: requires running inside a git repository\n",
    ]);
  });
});
