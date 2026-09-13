/** `nod ask`: one prompt, one turn, plain or JSON output, optional session resume and recovery continuation. */
import { createReadStream, createWriteStream, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { extname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import type { HistoryTurn, ImageRef, UserTurn } from "../core/agent/types.ts";
import { loadConfig } from "../core/config/resolve.ts";
import { parseOverride } from "../core/context/limits.ts";
import type { ApprovalDecision, ApprovalRequest } from "../core/permissions/index.ts";
import { findLastSession } from "../core/session/catalog.ts";
import { SessionError } from "../core/session/id.ts";
import { clearRecovery, interruptedTurn, readRecovery, writeRecovery } from "../core/session/recovery.ts";
import {
  createSession,
  deleteSession,
  openSession,
  type Session,
  saveTurn,
  updateManifest,
} from "../core/session/store.ts";
import { generateTitle, shouldGenerateTitle } from "../core/session/title.ts";
import { appendGeneration } from "../core/usage/store.ts";
import { resolveAccess } from "../core/workspace/access.ts";
import { parseAskArgs } from "./ask-args.ts";
import type { GlobalArgs } from "./global-args.ts";
import { CliUsageError } from "./global-args.ts";
import type { Io } from "./output.ts";
import { createRuntime } from "./runtime.ts";

export const MAX_PROMPT_BYTES = 4 * 1024 * 1024;
const MIME: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

export type AskResult = {
  output: string;
  final_output: string;
  exit_code: number;
  model: string;
  session_id: string;
  steps: number;
  tool_calls: { name: string; status: string }[];
  usage: { input_tokens: number | null; output_tokens: number | null };
  error?: string;
};

export const renderAskJson = (r: AskResult) => `${JSON.stringify(r)}\n`;

const failed = (error: string, partial: Partial<AskResult> = {}): AskResult => ({
  output: "",
  final_output: "",
  exit_code: 1,
  model: "",
  session_id: "",
  steps: 0,
  tool_calls: [],
  usage: { input_tokens: null, output_tokens: null },
  ...partial,
  error,
});

export function loadImages(paths: string[], cwd: string): ImageRef[] {
  return paths.map((p, i) => {
    const abs = resolve(cwd, p);
    const mime = MIME[extname(abs).toLowerCase()];
    if (!mime) throw new CliUsageError("ImagePreparationFailed", `unsupported image type: ${p}`);
    const bytes = readFileSync(abs);
    if (bytes.length > 5 * 1024 * 1024) throw new CliUsageError("ImagePreparationFailed", `image exceeds 5 MiB: ${p}`);
    return { id: i + 1, mime, data: bytes.toString("base64"), path: abs };
  });
}

/** y / a / n on the controlling terminal; the plain-text sibling of the shell's approval panel. */
export function ttyPrompter(): (request: ApprovalRequest) => Promise<ApprovalDecision> {
  return (request) =>
    new Promise((done) => {
      const out = createWriteStream("/dev/tty");
      const rl = createInterface({ input: createReadStream("/dev/tty"), output: out, terminal: false });
      const lines = [`nod wants to run: ${request.label}`];
      if (request.preparation?.detail) lines.push(request.preparation.detail);
      out.write(`${lines.join("\n")}\n[y] once  [a] always this session  [n] deny > `);
      rl.once("line", (line) => {
        rl.close();
        out.end();
        const c = line.trim().toLowerCase();
        done({ outcome: c === "y" || c === "yes" ? "once" : c === "a" ? "always" : "deny" });
      });
    });
}

async function readStdin(): Promise<string> {
  const text = await new Response(Bun.stdin.stream()).text();
  if (Buffer.byteLength(text) > MAX_PROMPT_BYTES)
    throw new CliUsageError("PromptResourceLimitExceeded", "prompt exceeds 4 MiB");
  return text;
}

export async function runAsk(argv: string[], global: GlobalArgs, io: Io): Promise<number> {
  const args = parseAskArgs(argv);
  const json = args.json;
  const emitFailure = (code: string, message: string, partial?: Partial<AskResult>) => {
    if (json) io.stdout(renderAskJson(failed(code, partial)));
    else io.stderr(`error: ${message}\n`);
    return 1;
  };
  const cwd = io.cwd;
  let config: ReturnType<typeof loadConfig>;
  try {
    config = loadConfig({
      workspaceRoot: cwd,
      env: io.env,
      cli: {
        permissionMode:
          args.permission === "auto"
            ? "auto"
            : args.permission === "full-access" || global.fullAccess
              ? "yolo"
              : undefined,
        contextLimits: global.contextLimits.map(parseOverride),
      },
    });
  } catch (e) {
    return emitFailure("ConfigInvalid", (e as Error).message);
  }
  const access = resolveAccess({ cwd }, config.additionalDirectories, {
    addDirs: global.addDirs,
    suppressSaved: global.noAdditionalDirs,
  });
  const deps = { home: config.home, cwd, now: Date.now };

  let session: Session | undefined;
  let scratch: string | undefined;
  let sessionDir: string;
  let sessionId: string;
  try {
    if (args.resume) {
      const id = args.resume.kind === "id" ? args.resume.id : findLastSession(deps, "workspace")?.id;
      if (!id) return emitFailure("SessionNotFound", "no saved session to resume in this workspace");
      session = openSession(deps, id, { rebindWorkspace: true });
    } else if (!args.noSave)
      session = createSession(deps, {
        provider: config.provider,
        model: config.model ?? null,
        effort: config.effort,
        fast_mode: config.fastMode,
      });
    if (session) {
      sessionDir = session.dir;
      sessionId = session.id;
    } else {
      scratch = mkdtempSync(join(tmpdir(), "nod-ask-"));
      sessionDir = scratch;
      sessionId = "";
    }
  } catch (e) {
    const code = e instanceof SessionError ? e.code : "SessionOpenFailed";
    return emitFailure(code, (e as Error).message);
  }

  try {
    let prompt: UserTurn;
    const pending = session ? readRecovery(session.dir) : undefined;
    if (args.continueRecovery) {
      if (!pending)
        return emitFailure("NoRecoveryCheckpoint", "the session has no recovery checkpoint to continue", {
          session_id: sessionId,
        });
      prompt = pending.user;
    } else {
      if (pending && session) {
        saveTurn(session, interruptedTurn(pending) as unknown as HistoryTurn);
        clearRecovery(session.dir);
      }
      const text = args.promptArgs.length > 0 ? args.promptArgs.join(" ") : await readStdin();
      if (text.trim().length === 0) return emitFailure("PromptEmpty", "prompt is empty", { session_id: sessionId });
      prompt = { text, images: loadImages(args.images, cwd) };
    }

    const runtime = await createRuntime({
      config,
      access,
      sessionId,
      sessionDir,
      history: session?.history ?? [],
      interactive: args.promptPermissions,
      prompter: args.promptPermissions ? ttyPrompter() : undefined,
      images: prompt.images,
      extraInstructions: args.system,
    });
    const controller = new AbortController();
    const onSigint = () => controller.abort();
    process.once("SIGINT", onSigint);
    const toolCalls: AskResult["tool_calls"] = [];
    let output = "";
    let steps = 0;
    const progress = (line: string) => {
      if (!args.quiet && !json) io.stderr(`${line}\n`);
    };
    const before = { ...runtime.state.usage };
    const run = async () => {
      const gen = runtime.loop.run(prompt, controller.signal);
      for (;;) {
        const next = await gen.next();
        if (next.done) return next.value;
        const ev = next.value;
        if (ev.type === "text") {
          output += ev.text;
          if (!json) io.stdout(ev.text);
        } else if (ev.type === "step") {
          steps = ev.step;
          // Each request's text starts on its own line, so two replies do not run together.
          if (output.length > 0 && !output.endsWith("\n")) {
            output += "\n";
            if (!json) io.stdout("\n");
          }
        } else if (ev.type === "tool_started") progress(`● ${ev.label}`);
        else if (ev.type === "tool_finished") toolCalls.push({ name: ev.call.name, status: ev.result.status });
        else if (ev.type === "notice") progress(`${ev.tone === "error" ? "✗" : "!"} ${ev.text}`);
        else if (ev.type === "recovery") progress(`! recovery: ${ev.strategy} in ${ev.delayMs}ms`);
      }
    };
    let outcome: Awaited<ReturnType<typeof run>>;
    try {
      outcome = await run();
    } finally {
      process.off("SIGINT", onSigint);
      await runtime.close();
    }
    if (!json && output.length > 0 && !output.endsWith("\n")) io.stdout("\n");

    const after = runtime.state.usage;
    const usage = {
      inputTokens: (after.inputTokens ?? 0) - (before.inputTokens ?? 0),
      outputTokens: (after.outputTokens ?? 0) - (before.outputTokens ?? 0),
      cacheReadTokens: (after.cacheReadTokens ?? 0) - (before.cacheReadTokens ?? 0),
      reasoningTokens: (after.reasoningTokens ?? 0) - (before.reasoningTokens ?? 0),
      requestCount: steps,
    };
    if (session) {
      const wantsTitle = shouldGenerateTitle(session.manifest, { sessionTitles: config.sessionTitles });
      saveTurn(session, outcome.turn as HistoryTurn, usage);
      if (outcome.kind === "paused" || outcome.kind === "failed") {
        writeRecovery(session.dir, {
          version: 2,
          disposition: "continuable",
          turn_id: session.history.length,
          user: prompt,
          assistant_source: outcome.kind === "paused" ? "" : "",
          cause: outcome.kind === "failed" ? outcome.error : outcome.reason,
          action: outcome.kind === "paused" ? "pause" : "stop",
          tool_state: "none",
          fast_mode: config.fastMode,
          max_provider_attempts: 10,
          consumed_provider_attempts: runtime.state.attempts,
        });
      } else if (pending && args.continueRecovery) clearRecovery(session.dir);
      if (steps > 0)
        appendGeneration(
          { home: config.home, now: Date.now },
          {
            id: `${session.id}-${session.history.length}`,
            created_at_ms: Date.now(),
            model: runtime.model,
            input_tokens: usage.inputTokens,
            output_tokens: usage.outputTokens,
            cache_read_tokens: usage.cacheReadTokens,
            cache_write_tokens: 0,
            reasoning_tokens: usage.reasoningTokens,
            billable_web_search_calls: 0,
            total_cost: 0,
          },
        );
      if (wantsTitle && outcome.kind === "completed") {
        const title = await generateTitle(runtime.llm.llm(runtime.model), prompt.text);
        if (title) updateManifest(session, { title, title_generated: true });
      }
    }
    const exitCode = outcome.kind === "completed" ? 0 : outcome.kind === "interrupted" ? 130 : 1;
    const result: AskResult = {
      output,
      final_output: outcome.kind === "completed" ? outcome.text : output,
      exit_code: exitCode === 130 ? 1 : exitCode,
      model: runtime.model,
      session_id: sessionId,
      steps,
      tool_calls: toolCalls,
      usage: { input_tokens: usage.inputTokens, output_tokens: usage.outputTokens },
    };
    if (outcome.kind === "failed") result.error = outcome.error;
    else if (outcome.kind === "paused") result.error = `paused: ${outcome.reason}`;
    else if (outcome.kind === "interrupted") result.error = "interrupted";
    if (json) io.stdout(renderAskJson(result));
    else if (result.error) io.stderr(`error: ${result.error}\n`);
    return exitCode;
  } catch (e) {
    if (e instanceof CliUsageError) return emitFailure(e.code, e.message, { session_id: sessionId });
    const message = (e as Error).message;
    return emitFailure(/sign(ed)? in/i.test(message) ? "AuthRequired" : "AskFailed", message, {
      session_id: sessionId,
    });
  } finally {
    session?.close();
    // A session that never received a turn leaves nothing behind.
    if (session && session.history.length === 0 && !session.manifest.has_checkpoint) deleteSession(deps, session.id);
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  }
}
