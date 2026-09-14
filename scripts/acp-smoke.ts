#!/usr/bin/env bun
/**
 * Manual check of `nod acp`: initialize, session/new, one prompt over stdio; prints the updates and the stop reason.
 *
 *   bun run scripts/acp-smoke.ts [prompt text]
 */
import { createInterface } from "node:readline";
import { Readable } from "node:stream";

const prompt = process.argv.slice(2).join(" ") || "Reply with the single word: ok";
const main = new URL("../src/cli/main.ts", import.meta.url).pathname;
const proc = Bun.spawn(["bun", "run", main, "acp"], { stdin: "pipe", stdout: "pipe", stderr: "inherit" });
const lines = createInterface({ input: Readable.fromWeb(proc.stdout as never) });
const pending = new Map<number, (m: Record<string, unknown>) => void>();
let nextId = 1;
const send = (message: unknown) => proc.stdin.write(`${JSON.stringify(message)}\n`);
const request = (method: string, params: unknown) =>
  new Promise<Record<string, unknown>>((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    send({ jsonrpc: "2.0", id, method, params });
  });

lines.on("line", (line) => {
  const message = JSON.parse(line) as Record<string, unknown>;
  if (message.method === "session/update") {
    const update = (message.params as { update: Record<string, unknown> }).update;
    const content = (update.content as { text?: string } | undefined)?.text;
    console.log(`< ${update.sessionUpdate}${content ? `: ${content}` : ""}`);
  } else if (message.method === "session/request_permission") {
    console.log(`< permission: ${(message.params as { toolCall: { title: string } }).toolCall.title} -> allow_once`);
    send({ jsonrpc: "2.0", id: message.id, result: { outcome: { outcome: "selected", optionId: "allow_once" } } });
  } else if (typeof message.id === "number") pending.get(message.id)?.(message);
});

const init = await request("initialize", { protocolVersion: 1 });
console.log("initialize:", JSON.stringify(init.result ?? init.error));
const created = await request("session/new", { cwd: process.cwd(), mcpServers: [] });
if (created.error) {
  console.error("session/new failed:", created.error);
  proc.kill();
  process.exit(1);
}
const sessionId = (created.result as { sessionId: string }).sessionId;
console.log("session:", sessionId);
const done = await request("session/prompt", { sessionId, prompt: [{ type: "text", text: prompt }] });
console.log("stopReason:", JSON.stringify(done.result ?? done.error));
proc.stdin.end();
await proc.exited;
