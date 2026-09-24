import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { binding } from "../../evals/run.ts";
import { assembleRuntime } from "../../src/cli/runtime.ts";
import type { Completion, LLM, Message } from "../../src/core/agent/types.ts";
import { loadConfig } from "../../src/core/config/resolve.ts";
import { createSession, saveTurn } from "../../src/core/session/store.ts";
import { resolveAccess } from "../../src/core/workspace/access.ts";
import type { Subscription } from "../../src/providers/providers.ts";
import type { TerminalCore } from "../../src/ui/core/terminal.ts";
import { CANCELLED_NOTICE } from "../../src/ui/core/transcript.ts";
import { runTui } from "../../src/ui/index.tsx";
import { C, palette } from "../../src/ui/theme.ts";

class Tty extends PassThrough {
  isTTY = true;
  columns = 100;
  rows = 30;
  setRawMode() {}
  ref() {}
  unref() {}
}

let home: string;
let cwd: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nod-tui-"));
  cwd = join(home, "ws");
  mkdirSync(cwd);
  settings({});
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

/** Titles off by default so the fake model only sees the prompts the test sends. */
const settings = (json: Record<string, unknown>) =>
  writeFileSync(join(home, "settings.json"), JSON.stringify({ session_titles: false, ...json }), { mode: 0o600 });

const reply = (content: string, toolCalls: Completion["toolCalls"] = []): Completion => ({ content, toolCalls });
const shellCall = (id: string, command: string) => ({
  id,
  name: "shell",
  arguments: JSON.stringify({ request: { action: "run", command } }),
});

/** An LLM that answers from a queue; a queued function may block (gate) or throw on abort. */
function scripted(replies: (Completion | ((signal?: AbortSignal) => Promise<Completion>))[]) {
  const seen: Message[][] = [];
  const llm: LLM = {
    async *stream(messages, _tools, signal) {
      seen.push(messages);
      const next = replies.shift();
      if (!next) return reply("Done.");
      // `return await`: Bun hangs an async generator that returns a promise rejected later.
      return typeof next === "function" ? await next(signal) : next;
    },
  };
  return { llm, seen };
}

const blocked = (signal?: AbortSignal) =>
  new Promise<Completion>((resolve, reject) => {
    const abort = () => reject(new Error("aborted"));
    if (signal?.aborted) return abort();
    signal?.addEventListener("abort", abort, { once: true });
    gate.release = () => {
      signal?.removeEventListener("abort", abort);
      resolve(reply("after the gate"));
    };
  });
const gate: { release: () => void } = { release: () => {} };

function subscriptionsFor(llm: LLM): Record<"codex" | "grok", Subscription> {
  const codex = binding(llm, "gpt-5.4").sub;
  return {
    codex: { ...codex, models: async () => ["gpt-5.4", "gpt-5.4-mini"] },
    grok: { ...codex, label: "Grok", signedIn: () => false },
  };
}

type Shell = {
  send(keys: string): Promise<void>;
  see(text: string, timeoutMs?: number): Promise<void>;
  core(): TerminalCore;
  screen(): string;
  exit(): Promise<number>;
};

/** Runs the TUI on a fake terminal with a fake subscription; keys are pushed, the screen is polled. */
function shell(
  llm: LLM,
  o: { env?: Record<string, string>; resume?: { kind: "picker" }; fileIndex?: string[] } = {},
): Shell {
  const stdout = new Tty();
  const stdin = new Tty();
  let out = "";
  stdout.on("data", (d: Buffer) => (out += d));
  let core: TerminalCore | undefined;
  const env = { NOD_HOME: home, ...o.env };
  const exited = runTui({
    cwd,
    env,
    resume: o.resume,
    stdin,
    stdout,
    patchConsole: false,
    hooks: {
      onCore: (c) => (core = c),
      subscriptions: subscriptionsFor(llm),
      fileIndex: () => o.fileIndex ?? [],
      branch: null,
      notify: { turnEnd() {}, attention() {} },
      makeRuntime: (r) =>
        assembleRuntime(
          {
            config: loadConfig({ workspaceRoot: cwd, env }),
            access: resolveAccess({ cwd }, []),
            sessionId: r.sessionId,
            sessionDir: r.sessionDir,
            history: r.history,
            interactive: true,
            prompter: r.prompter,
            askUser: r.askUser,
            permissionMode: r.permissionMode,
          },
          binding(llm, r.model ?? "gpt-5.4"),
        ),
    },
  });
  // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI escapes
  const screen = () => out.replace(/\x1B\[[0-9;?<>]*[A-Za-z~]/g, "");
  const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
  return {
    async send(keys) {
      stdin.push(keys);
      await sleep(40);
    },
    async see(text, timeoutMs = 1500) {
      const until = Date.now() + timeoutMs;
      while (!screen().includes(text)) {
        if (Date.now() > until) throw new Error(`never saw ${JSON.stringify(text)} in:\n${screen().slice(-2000)}`);
        await sleep(10);
      }
    },
    core: () => core as TerminalCore,
    screen,
    async exit() {
      stdin.push("\x03\x03");
      return exited;
    },
  };
}

test("the approval panel shows the command and 1 runs it", async () => {
  settings({ permission_mode: "ask" });
  const { llm } = scripted([reply("", [shellCall("c0", "touch marker.txt")]), reply("Created.")]);
  const t = shell(llm);
  await t.see("nod");
  await t.send("make a marker\r");
  await t.see("Would you like to run the following command?");
  expect(t.screen()).toContain("touch marker.txt");
  expect(t.screen()).toContain("2. Yes, and don't ask again for this exact command");
  await t.send("1");
  await t.see("Created.");
  expect(existsSync(join(cwd, "marker.txt"))).toBe(true);
  expect(t.screen()).toContain("● Ran touch marker.txt");
  expect(await t.exit()).toBe(130);
});

test("shift+enter (kitty and ESC-CR) inserts a newline instead of submitting", async () => {
  const { llm, seen } = scripted([]);
  const t = shell(llm);
  await t.see("nod");
  await t.send("a\x1b[13;2ub\x1b\rc");
  expect(t.core().store.get().editor.text).toBe("a\nb\nc");
  expect(seen).toHaveLength(0);
  await t.exit();
});

test("enter during a turn queues the draft as steering; esc cancels with the notice", async () => {
  const { llm, seen } = scripted([blocked, reply("second done")]);
  const t = shell(llm);
  await t.see("nod");
  await t.send("first\r");
  await t.see("Thinking");
  await t.send("second\r");
  await t.see("queued");
  expect(t.core().store.get().pending).toEqual({ text: "second" });
  await t.send("\x1b");
  await new Promise((r) => setTimeout(r, 60));
  await t.see(CANCELLED_NOTICE);
  // The withdrawn follow-up returns to the composer.
  expect(t.core().store.get().editor.text).toBe("second");
  expect(t.core().store.get().pending).toBeNull();
  expect(seen).toHaveLength(1);
  await t.exit();
});

test("a queued follow-up runs as the next turn when the model finishes first", async () => {
  const { llm, seen } = scripted([blocked, reply("second done")]);
  const t = shell(llm);
  await t.see("nod");
  await t.send("first\r");
  await t.see("Thinking");
  await t.send("second\r");
  await t.see("queued");
  gate.release();
  await t.see("second done");
  expect(seen).toHaveLength(2);
  expect(seen[1]?.at(-1)?.content).toBe("second");
  await t.exit();
});

test("ctrl+c twice exits 130 and once only arms the hint", async () => {
  const { llm } = scripted([]);
  const t = shell(llm);
  await t.see("nod");
  await t.send("\x03");
  await t.see("press ctrl+c again to exit");
  await t.send("\x03");
  expect(await t.exit()).toBe(130);
});

test("/ opens the command menu with categories, /mod⇥ completes, and /nope is reported", async () => {
  const { llm } = scripted([]);
  const t = shell(llm);
  await t.see("nod");
  await t.send("/");
  await t.see("Commands");
  expect(t.screen()).toContain("General");
  expect(t.screen()).toContain("Show interactive help");
  await t.send("mod\t");
  expect(t.core().store.get().editor.text).toBe("/model ");
  await t.send("\x15/nope\r");
  await t.see("Unknown command /nope");
  await t.exit();
});

test("@ opens the file picker and enter inserts the path", async () => {
  const { llm } = scripted([]);
  const t = shell(llm, { fileIndex: ["README.md", "src/app.ts"] });
  await t.see("nod");
  await t.send("see @app");
  await t.see("src/app.ts");
  await t.send("\r");
  expect(t.core().store.get().editor.text).toBe("see src/app.ts ");
  await t.exit();
});

test("/models walks provider → model → effort → fast and saves the choice", async () => {
  const { llm } = scripted([]);
  const t = shell(llm);
  await t.see("nod");
  await t.send("/models\r");
  await t.see("Models 2");
  expect(t.screen()).toContain("gpt-5.4-mini");
  expect(t.screen()).toContain("400K context · 128K output · Fast");
  await t.send("\x1b[B\x1b[A\r");
  await t.see("Effort · gpt-5.4");
  expect(t.core().store.get().editor.text).toBe("/model gpt-5.4");
  await t.send("\x1b[B\r");
  await t.see("Fast mode · gpt-5.4");
  await t.send("\r");
  await t.see("model codex/gpt-5.4 · medium");
  const saved = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
  expect(saved.models.codex).toBe("gpt-5.4");
  expect(saved.effort).toBe("medium");
  expect(t.core().store.get().surface).toBeNull();
  await t.exit();
});

test("/resume lists saved sessions and enter resumes one", async () => {
  const other = createSession({ home, cwd, now: Date.now });
  saveTurn(other, {
    kind: "assistant",
    user: { text: "older prompt" },
    assistant: "older reply",
    execution: { steps: [], steering: [] },
  });
  other.close();
  const { llm } = scripted([]);
  const t = shell(llm);
  await t.see("nod");
  await t.send("/resume\r");
  await t.see("Sessions 1");
  expect(t.screen()).toContain("Current workspace");
  expect(t.screen()).toContain("1 turn");
  await t.send("\r");
  await t.see("older reply");
  expect(t.core().session().id).toBe(other.id);
  await t.exit();
});

test("ctrl+o opens Review, → switches to Full transcript, esc closes", async () => {
  const { llm } = scripted([reply("hello there")]);
  const t = shell(llm);
  await t.see("nod");
  await t.send("hi\r");
  await t.see("hello there");
  await t.send("\x0f");
  await t.see("Full transcript");
  expect(t.core().store.get().screen).toEqual({ kind: "review", scroll: 0 });
  await t.send("\x1b[C");
  expect(t.core().store.get().screen).toEqual({ kind: "full", scroll: 0 });
  await t.see("✓ turn 1");
  await t.send("\x1b");
  await new Promise((r) => setTimeout(r, 60));
  expect(t.core().store.get().screen).toBeNull();
  await t.exit();
});

test("collapse_tool_calls folds consecutive calls into a summary", async () => {
  settings({ collapse_tool_calls: true, permission_mode: "yolo" });
  writeFileSync(join(cwd, "a.txt"), "A");
  writeFileSync(join(cwd, "b.txt"), "B");
  const read = (id: string, path: string) => ({ id, name: "read_file", arguments: JSON.stringify({ path }) });
  const { llm } = scripted([reply("", [read("r1", "a.txt"), read("r2", "b.txt")]), reply("read both")]);
  const t = shell(llm);
  await t.see("nod");
  await t.send("read\r");
  await t.see("read both");
  expect(t.screen()).toContain("● 2 tool calls · 2 read");
  await t.exit();
});

test("NOD_THEME=light paints the light palette; NOD_SOUND=off never bells", async () => {
  const { llm } = scripted([reply("ok")]);
  const t = shell(llm, { env: { NOD_THEME: "light", NOD_SOUND: "off" } });
  await t.see("nod");
  expect(t.core().store.get().theme).toBe("light");
  await t.send("hi\r");
  await t.see("ok");
  expect(C.foreground).toBe(palette(true).foreground);
  expect(t.screen()).not.toContain("\x07");
  await t.exit();
});

test("nod -r opens the session picker on start and esc leaves a fresh session", async () => {
  const { llm } = scripted([]);
  const t = shell(llm, { resume: { kind: "picker" } });
  await t.see("Sessions 0");
  await t.send("\x1b");
  await new Promise((r) => setTimeout(r, 60));
  expect(t.core().store.get().surface).toBeNull();
  await t.exit();
});

test("ask_user_question shows the panel; a number picks, enter confirms, the answer reaches the model", async () => {
  const ask = {
    id: "q1",
    name: "ask_user_question",
    arguments: JSON.stringify({
      questions: [{ question: "Which runtime?", options: [{ label: "Bun", description: "fast" }, { label: "Node" }] }],
    }),
  };
  const { llm, seen } = scripted([reply("", [ask]), reply("Bun it is")]);
  const t = shell(llm);
  await t.see("nod");
  await t.send("choose\r");
  await t.see("Which runtime?");
  expect(t.screen()).toContain("1. Bun  fast");
  expect(t.screen()).toContain("3. Other");
  expect(t.screen()).toContain("question 1/1");
  await t.send("2\r");
  await t.see("Bun it is");
  const toolResult = seen[1]?.find((m) => m.role === "tool");
  expect(toolResult?.content).toContain('"answer":"Node"');
  await t.exit();
});

test("ctrl+c during a turn cancels it and the interrupted turn is saved on exit", async () => {
  const { llm } = scripted([blocked]);
  const t = shell(llm);
  await t.see("nod");
  await t.send("work\r");
  await t.see("Thinking");
  const id = t.core().session().id;
  expect(await t.exit()).toBe(130);
  const events = readFileSync(join(home, "sessions", id, "events.jsonl"), "utf8");
  expect(events).toContain('"type":"interrupted"');
  expect(events.match(/"type":"user"/g)).toHaveLength(1);
});
