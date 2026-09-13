---
title: "Terminal embedding"
description: "Embed the nod terminal and connect storage, login, and workspace adapters."
---

# Terminal embedding

Use [`createTerminal()`](https://nod.anturno.cloud/docs/lib/api.md#createterminal) to put the nod terminal inside your application. It runs the interactive shell in-process on Bun and renders through any terminal surface you supply: a pseudo-terminal, a WebSocket, or an xterm.js component in a browser page.

If you are building your own agent interface, start with the [examples](https://nod.anturno.cloud/docs/lib/examples.md) or the [Bun SDK](https://nod.anturno.cloud/docs/lib/node.md) instead.

```sh
bun add github:anturno/nod
```

## Embed the terminal

The smallest adapter forwards the current process's stdin and stdout:

```ts
import { createTerminal } from "@anturno/nod/sdk";

const runtime = await createTerminal({
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

runtime.exited.then((exitCode) => {
  console.log(`nod exited with code ${exitCode}`);
});
```

Await `runtime.interactive` before sending input. Use `write()`, `resize()`, and `abort()` to control the terminal; `abort()` stops it and releases subscriptions. The `exited` promise resolves when nod stops.

## Render in a browser with xterm.js

The runtime runs in Bun, so a browser page talks to it over a socket. `xtermAdapter()` from `@anturno/nod/sdk/xterm` builds the browser half:

```bash
bun add @xterm/xterm
```

```html
<div id="terminal" style="height: 600px"></div>
```

```ts
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import { xtermAdapter } from "@anturno/nod/sdk/xterm";

const term = new Terminal();
term.open(document.querySelector("#terminal")!);
const adapter = xtermAdapter(term);

const socket = new WebSocket("wss://example.com/nod");
socket.binaryType = "arraybuffer";
socket.onmessage = (e) => adapter.write(new Uint8Array(e.data));
adapter.onData((data) => socket.send(JSON.stringify({ data })));
adapter.onResize(() => socket.send(JSON.stringify({ cols: adapter.cols, rows: adapter.rows })));
```

On the server, `Bun.serve` with `websocket` handlers owns one `createTerminal()` per connection: forward `data` messages to `runtime.write()`, keep the last `cols`/`rows` in the server-side adapter and call `runtime.resize()`, and send the bytes the adapter's `write()` receives back down the socket. `xtermAdapter` also installs a key handler that encodes Shift+Enter and Meta+Backspace or Meta+arrow keys the way nod expects; see [`encodeXtermKeyEvent`](https://nod.anturno.cloud/docs/lib/api.md#encodextermkeyevent).

## Connect host adapters

The adapters below belong to the terminal. Agents use named options and [checkpoints](https://nod.anturno.cloud/docs/lib/api.md#agentcheckpoint); only the `fetch` option is shared. Add the adapters your application needs. When you omit them, the terminal uses the same files as the CLI under `~/.nod`.

## Choose an adapter

| Option | Used by | Purpose |
| --- | --- | --- |
| `configStore` | Terminal | Restore accepted model and mode settings. |
| `promptHistoryStore` | Terminal | Preserve terminal input history. |
| `sessionStore` | Terminal | Persist conversations. |
| `openUrl` and `oauthSessionStore` | Terminal | Complete browser login. |
| `workspace` | Terminal | Replace the shell environment. |
| `fetch` | Both | Control network requests. |

## Config store

Use `configStore` to restore settings such as the active model and mode:

```ts
const configStore = {
  get(id: string) {
    return localStorage.getItem(`nod.core.config.${id}`);
  },
  set(id: string, value: string) {
    localStorage.setItem(`nod.core.config.${id}`, value);
  },
};
```

`get(id)` returns a string or `null`. nod calls `set(id, value)` only after it accepts the new value.

## Prompt history store

Use `promptHistoryStore` to preserve terminal input history across page loads:

```ts
type PromptHistoryStore = {
  load(workspaceRoot: string, limit: number): string[] | Promise<string[]>;
  append(
    workspaceRoot: string,
    value: string,
    timestampMs: number,
  ): void | "duplicate" | "record_too_large" | Promise<void | "duplicate" | "record_too_large">;
  clear(workspaceRoot: string): void | Promise<void>;
};
```

`load()` returns prompts from oldest to newest. Return `duplicate` when the latest stored prompt already matches, or `record_too_large` when the app declines to store it.

## Session store

Use `sessionStore` to persist conversations. Pass `args: ["--resume", "last"]` to `createTerminal()` to resume the conversation with the latest `updatedAtMs` value.

```ts
type SessionStore = {
  load(id: string): { bytes: Uint8Array; revision: string } | null | Promise<{ bytes: Uint8Array; revision: string } | null>;
  commit(
    id: string,
    bytes: Uint8Array,
    expectedRevision: string | undefined,
  ): { revision: string } | Promise<{ revision: string }>;
  list(): Array<{ id: string; updatedAtMs: number }> | Promise<Array<{ id: string; updatedAtMs: number }>>;
  remove(id: string): void | Promise<void>;
};
```

Treat `bytes` as opaque data. `commit()` receives `undefined` for the first revision and must return a new revision after every write.

If `expectedRevision` is stale, throw an error whose `code` is `NOD_SESSION_REVISION_CONFLICT`. The conflict prevents the stale snapshot from overwriting the current record. For agent persistence, use [checkpoints](https://nod.anturno.cloud/docs/lib/node.md#save-and-restore-a-conversation), not this terminal store.

## Device login

`createTerminal()` supports browser login through `openUrl` and `oauthSessionStore`:

```ts
const terminal = await createTerminal({
  terminal: terminalAdapter,
  openUrl(url) {
    return window.open(url, "_blank", "noopener,noreferrer") !== null;
  },
  oauthSessionStore,
});
```

Return `false` from `openUrl()` when the app cannot open the verification page. nod still prints the URL in the terminal, as it does with `NOD_NO_OPEN_BROWSER=1`.

The OAuth store uses the following contract:

```ts
type OAuthSessionStore = {
  load(): { bytes: Uint8Array; revision: string } | null | Promise<{ bytes: Uint8Array; revision: string } | null>;
  commit(bytes: Uint8Array, expectedRevision: string | undefined): { revision: string } | Promise<{ revision: string }>;
  remove(expectedRevision: string | undefined): void | boolean | "missing" | Promise<void | boolean | "missing">;
};
```

Store the OAuth bytes without inspecting or logging them. Return `false` or `missing` when there is no record to remove. Reject a stale commit or removal with `NOD_OAUTH_SESSION_REVISION_CONFLICT`. Without this store, sessions are saved to `~/.nod/<provider>-auth.json` as the CLI does.

## Workspace adapter

The optional `workspace` adapter replaces the shell environment the `shell` tool runs in, implemented by your app. The model-facing schema stays `{ action: "run", command }`; background handles and TTYs are unavailable through an adapter:

```ts
type WorkspaceAdapter = {
  info: {
    version: 1;
    root: string;
    cwd: string;
    home: string;
    gitAvailable: boolean;
    ephemeral: boolean;
  };
  permission: "allow-sandboxed" | "prompt";
  exec(input: {
    command: string;
    cwd: string;
    signal: AbortSignal;
    timeoutMs: number;
    outputLimitBytes: number;
  }): { stdout: string; stderr: string; exitCode: number } | Promise<{ stdout: string; stderr: string; exitCode: number }>;
};
```

`root`, `cwd`, and `home` must be normalized absolute paths without NUL bytes.

`permission` declares how far your app vouches for its own execution boundary. With `allow-sandboxed`, nod runs every command the adapter accepts without asking, because your sandbox is the boundary. With `prompt`, command calls go through the normal nod permission flow of rules, session grants, and the active mode.

`exec()` returns `{ stdout, stderr, exitCode }`. Commands are limited to 64 KiB of UTF-8, combined output previews to 64 KiB, and execution to 30 seconds. The adapter must stop work when its `AbortSignal` is cancelled. Without a workspace adapter, the terminal runs commands on the host with `Bun.spawn`, exactly like the CLI.

## Network requests

The SDK uses `globalThis.fetch` by default. Pass a `fetch` function to `createTerminal()` or `createAgent()` when your app needs to proxy requests, add authentication, or apply its own network policy.

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
