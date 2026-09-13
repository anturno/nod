---
title: "Examples"
description: "Build with the nod SDK in Bun: a readline chat, an HTTP route, and an embedded terminal."
---

# Examples

Three small applications built with the nod SDK. Each is complete: save the files at the paths shown, sign in once with `nod login codex` or `nod login grok`, and run the command.

The source lives in the [nod examples](https://github.com/anturno/nod/tree/main/examples). They use Bun 1.4 and the SDK from the same repository.

## Bun readline chat

A command-line chat built with Bun and the [SDK](https://nod.anturno.cloud/docs/lib/node.md). It keeps the conversation open for follow-up questions and prints replies as they arrive.

> Build a Bun readline chat with the nod SDK. Keep one agent for the conversation, stream text to stdout, and close it on exit. Use the files below as a starting point.

[Source](https://github.com/anturno/nod/tree/main/examples/node-chat)

```sh
cd examples/node-chat
bun install
bun run chat
```

### examples/node-chat/package.json

```json
{
  "name": "nod-example-node-chat",
  "private": true,
  "type": "module",
  "scripts": {
    "chat": "bun chat.ts"
  },
  "dependencies": {
    "@anturno/nod": "github:anturno/nod"
  }
}
```

### examples/node-chat/chat.ts

```ts
import { createInterface } from "node:readline";
import { stdin, stdout } from "node:process";
import { createAgent } from "@anturno/nod/sdk";

const agent = await createAgent({
  auth: { provider: process.env.NOD_PROVIDER === "grok" ? "grok" : "codex" },
});
const input = createInterface({ input: stdin, output: stdout, prompt: "You: " });

try {
  input.prompt();
  for await (const prompt of input) {
    if (prompt.trim() === "/exit") break;
    if (!prompt.trim()) {
      input.prompt();
      continue;
    }
    stdout.write("Agent: ");
    const turn = agent.prompt(prompt);
    for await (const event of turn) {
      if (event.type === "text_delta") stdout.write(event.delta);
    }
    await turn.result;
    stdout.write("\n\n");
    input.prompt();
  }
} finally {
  input.close();
  await agent.close();
}
```

## HTTP route

A `Bun.serve` route that streams the reply as plain text. One agent per request keeps the handler stateless; store a [checkpoint](https://nod.anturno.cloud/docs/lib/node.md#save-and-restore-a-conversation) per user when you want follow-ups.

> Build a Bun HTTP server with a plain prompt form and a nod agent in the handler. Stream the reply to the form and close the agent after each request. Use the file below as a starting point.

[Source](https://github.com/anturno/nod/tree/main/examples/http-agent)

```sh
cd examples/http-agent
bun run server.ts
```

### examples/http-agent/server.ts

```ts
import { createAgent } from "@anturno/nod/sdk";

const page = `<!doctype html><form><input name="prompt" autofocus><button>Send</button></form><pre id="out"></pre>
<script>
document.querySelector("form").onsubmit = async (e) => {
  e.preventDefault();
  const out = document.querySelector("#out"); out.textContent = "";
  const res = await fetch("/api/chat", { method: "POST", body: JSON.stringify({ prompt: e.target.prompt.value }) });
  const reader = res.body.getReader(); const decoder = new TextDecoder();
  for (;;) { const { value, done } = await reader.read(); if (done) break; out.textContent += decoder.decode(value, { stream: true }); }
};
</script>`;

Bun.serve({
  port: 3000,
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname !== "/api/chat") return new Response(page, { headers: { "content-type": "text/html" } });
    const { prompt } = (await request.json()) as { prompt: string };
    if (typeof prompt !== "string" || prompt.length > 4000) return new Response("bad prompt", { status: 400 });
    const agent = await createAgent({ auth: { provider: "codex" } });
    async function* reply() {
      try {
        const turn = agent.prompt(prompt, { signal: request.signal });
        for await (const event of turn) {
          if (event.type === "text_delta") yield event.delta;
        }
        await turn.result;
      } finally {
        await agent.close();
      }
    }
    return new Response(ReadableStream.from(reply()).pipeThrough(new TextEncoderStream()), {
      headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "no-store" },
    });
  },
});
console.log("http://localhost:3000");
```

For a public deployment, add authentication and per-user request limits. The agent runs on the server's saved subscription, so never expose the route to users who should not consume it.

## Embedded terminal

The full interactive shell, run in-process and rendered through the current TTY. Everything `nod` does, including approvals, `/models`, and session resume, works through the adapter.

> Build a Bun script that runs the nod terminal in-process through createTerminal() with a stdin/stdout adapter, resumes the last session, and exits with nod's exit code. Use the file below as a starting point.

[Source](https://github.com/anturno/nod/tree/main/examples/terminal)

```sh
cd examples/terminal
bun run term.ts
```

### examples/terminal/term.ts

```ts
import { createTerminal } from "@anturno/nod/sdk";

const runtime = await createTerminal({
  args: ["--resume", "last"],
  terminal: {
    get cols() {
      return process.stdout.columns ?? 80;
    },
    get rows() {
      return process.stdout.rows ?? 24;
    },
    write: (bytes) => process.stdout.write(bytes),
    onData(callback) {
      process.stdin.setRawMode?.(true);
      const listener = (chunk: Buffer) => callback(chunk.toString("utf8"));
      process.stdin.on("data", listener);
      return () => process.stdin.off("data", listener);
    },
    onResize(callback) {
      process.stdout.on("resize", callback);
      return () => process.stdout.off("resize", callback);
    },
  },
});

await runtime.interactive;
process.exit(await runtime.exited);
```

Replace the adapter with [`xtermAdapter`](https://nod.anturno.cloud/docs/lib/terminal.md#render-in-a-browser-with-xtermjs) bridged over a WebSocket to show the same shell in a browser page.

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
