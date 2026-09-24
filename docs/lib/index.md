---
title: "Embed nod"
description: "Build an application with the nod agent runtime."
---

# Embed nod

`@anturno/nod/sdk` runs an agent inside your application. It is the same TypeScript runtime the CLI uses, imported as a library and running in-process on Bun. You provide the interface, credentials, instructions, and tools.

Start with the [examples](https://nod.anturno.cloud/docs/lib/examples.md) for a readline chat, an HTTP route, or an embedded terminal.

## Install

```sh
bun add github:anturno/nod
```

## Run an agent

Create an [`Agent`](https://nod.anturno.cloud/docs/lib/api.md#agent), send a prompt, and read the [`Turn`](https://nod.anturno.cloud/docs/lib/api.md#turn) as it produces text:

```ts
import { createAgent } from "@anturno/nod/sdk";

const agent = await createAgent({
  auth: { provider: "codex" },
});

try {
  const turn = agent.prompt("Explain closures in two sentences.");
  for await (const event of turn) {
    if (event.type === "text_delta") process.stdout.write(event.delta);
  }
  await turn.result;
} finally {
  await agent.close();
}
```

`{ provider: "codex" }` reuses the session saved by `nod login codex` in `~/.nod`. Pass `{ provider, token }` to supply a subscription token your application obtained itself.

One agent owns one conversation. Keep it open for follow-up prompts, or save a [checkpoint](https://nod.anturno.cloud/docs/lib/api.md#agentcheckpoint) before closing it.

## Choose a guide

- [Bun SDK](https://nod.anturno.cloud/docs/lib/node.md): prompting, tools, checkpoints, permissions, and the workspace option.
- [Examples](https://nod.anturno.cloud/docs/lib/examples.md): complete applications with source.
- [API reference](https://nod.anturno.cloud/docs/lib/api.md): interfaces, options, methods, and events.

## Embed the terminal

Embedding the nod terminal is a separate use case. The [Terminal embedding guide](https://nod.anturno.cloud/docs/lib/terminal.md) covers `createTerminal()`, xterm.js, storage, login, and workspace adapters.

To launch the CLI or connect an editor instead, see the [CLI reference](https://nod.anturno.cloud/docs/using-nod/cli.md) or [ACP guide](https://nod.anturno.cloud/docs/using-nod/acp.md).

## Version compatibility

The SDK ships inside the `@anturno/nod` package and follows its version. `sdkApiVersion`, currently `1`, identifies the API revision described on these pages; check it when your application must refuse an incompatible runtime. There is no separate npm package and no WebAssembly build: the SDK runs wherever Bun runs.

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
