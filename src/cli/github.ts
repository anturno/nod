/** `nod pr` / `nod issue`: one drafting turn from a git snapshot, optionally published with the GitHub CLI. */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadConfig } from "../core/config/resolve.ts";
import { parseOverride } from "../core/context/limits.ts";
import { buildPrompt, type WorkflowKind } from "../core/github/prompt.ts";
import { parseDraft, publish } from "../core/github/publish.ts";
import { snapshot } from "../core/github/snapshot.ts";
import { resolveAccess } from "../core/workspace/access.ts";
import { ttyPrompter } from "./ask.ts";
import type { GlobalArgs } from "./global-args.ts";
import type { Io } from "./output.ts";
import { createRuntime } from "./runtime.ts";

const NO_GLOBAL: GlobalArgs = { contextLimits: [], addDirs: [], noAdditionalDirs: false, fullAccess: false, rest: [] };

export function parseWorkflowArgs(args: string[]): { auto: boolean; create: boolean; context: string } {
  let auto = false;
  let create = false;
  let i = 0;
  for (; i < args.length; i++) {
    if (args[i] === "--auto") auto = true;
    else if (args[i] === "--create") create = true;
    else break;
  }
  return { auto, create, context: args.slice(i).join(" ") };
}

export const runPr = (args: string[], io: Io, global?: GlobalArgs) => runGithub("pr", args, io, global);
export const runIssue = (args: string[], io: Io, global?: GlobalArgs) => runGithub("issue", args, io, global);

async function runGithub(kind: WorkflowKind, args: string[], io: Io, global = NO_GLOBAL): Promise<number> {
  const opts = parseWorkflowArgs(args);
  const snap = snapshot(io.cwd);
  if (!snap.inGitRepo) {
    io.stderr(`nod ${kind}: requires running inside a git repository\n`);
    return 1;
  }
  const prompt = buildPrompt(kind, opts.context, snap.text);
  const config = loadConfig({
    workspaceRoot: io.cwd,
    env: io.env,
    cli: {
      permissionMode: opts.auto ? "auto" : global.fullAccess ? "yolo" : undefined,
      contextLimits: global.contextLimits.map(parseOverride),
    },
  });
  const access = resolveAccess({ cwd: io.cwd }, config.additionalDirectories, {
    addDirs: global.addDirs,
    suppressSaved: global.noAdditionalDirs,
  });
  // ponytail: the drafting turn is not saved as a session; resume it from the printed draft if needed.
  const scratch = mkdtempSync(join(tmpdir(), `nod-${kind}-`));
  let text = "";
  try {
    const runtime = await createRuntime({
      config,
      access,
      sessionId: "",
      sessionDir: scratch,
      history: [],
      interactive: io.isTTY,
      prompter: io.isTTY ? ttyPrompter() : undefined,
    });
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.once("SIGINT", onSigint);
    try {
      const gen = runtime.loop.run({ text: prompt }, controller.signal);
      let next = await gen.next();
      while (!next.done) {
        const ev = next.value;
        if (ev.type === "text") {
          text += ev.text;
          if (!opts.create) io.stdout(ev.text);
        } else if (ev.type === "notice") io.stderr(`${ev.tone === "error" ? "✗" : "!"} ${ev.text}\n`);
        next = await gen.next();
      }
      const outcome = next.value;
      if (outcome.kind !== "completed") {
        io.stderr(`nod ${kind}: ${outcome.kind === "failed" ? outcome.error : outcome.kind}\n`);
        return 1;
      }
      text = outcome.text;
    } finally {
      process.off("SIGINT", onSigint);
      await runtime.close();
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  if (!opts.create) {
    if (text.length > 0 && !text.endsWith("\n")) io.stdout("\n");
    return 0;
  }
  let draft: ReturnType<typeof parseDraft>;
  try {
    draft = parseDraft(text);
  } catch {
    io.stderr(`nod ${kind}: failed to parse drafted ${kind === "pr" ? "PR" : "issue"} title/body\n`);
    return 1;
  }
  const published = publish(kind, draft, { cwd: io.cwd, env: io.env });
  if (!published.ok) {
    io.stderr(`nod ${kind}: ${published.text}\n`);
    return 1;
  }
  io.stdout(`${published.text}\n`);
  return 0;
}
