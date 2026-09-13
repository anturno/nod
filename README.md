# nod

[![CI](https://github.com/anturno/nod/actions/workflows/ci.yml/badge.svg)](https://github.com/anturno/nod/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A coding agent for your terminal that runs on the ChatGPT or Grok subscription you already pay for.**

Website: [nod.anturno.cloud](https://nod.anturno.cloud)

Describe a task in plain language. nod reads your code, runs your tests, edits the files, and tells you when it's done. It asks before every command it runs, and you can stop it at any time. You don't need an API key, and nothing is billed per token.

```bash
nod "add() in src/math.ts returns the wrong result. Fix it and run the tests."
```

## Why nod

- **Uses your subscription.** Sign in with ChatGPT (Plus, Pro, Business, Enterprise or Edu) or Grok (SuperGrok or X Premium) and start working.
- **You approve every command.** Each command is shown with a risk level before it runs. Approve it once, allow commands for the rest of the session, or deny it.
- **Small enough to trust.** nod acts only through bash, the same commands you would type yourself. There's no agent framework and no model SDK, and the whole codebase fits in an afternoon's reading.
- **Switch models mid-conversation.** Move between ChatGPT and Grok models without losing context.
- **Measured, not guessed.** An eval suite of real tasks tracks how often the agent succeeds, how many steps it takes, and how much context it uses.

## Install

Requires [Bun](https://bun.sh) 1.4 or later.

```bash
bun install -g github:anturno/nod
```

```bash
nod login codex     # ChatGPT
```

```bash
nod login grok      # Grok
```

Login opens your browser. For Grok, you can also paste the code xAI shows you.

## Use it

Run `nod` in a project to open the interactive shell:

```bash
nod
```

Or give it a single task. It prints plain output and exits, which suits scripts and CI:

```bash
nod "rename getUser to fetchUser across the codebase"
```

### In the shell

Type `/` to see the commands. `tab` completes a command and `enter` runs it.

| Command | Key | What it does |
|---------|-----|--------------|
| `/model` | | Switch to another model from any subscription you're signed in to, keeping the conversation |
| `/clear` | `ctrl+l` | Start a fresh conversation |
| `/verbose` | `ctrl+o` | Expand or collapse command output and reasoning |
| `/exit` | `ctrl+c` | Quit (`ctrl+c` interrupts a running turn first) |

| Key | What it does |
|-----|--------------|
| `y` / `a` / `n` | Approve a command once, allow commands for the session, or deny it |
| `esc` | Interrupt the agent |
| `↑` / `↓` | Recall past messages |
| Mouse wheel, `PageUp` / `PageDown`, `shift+↑` / `shift+↓` | Scroll the conversation |

### Options

| Option | What it does |
|--------|--------------|
| `--provider codex\|grok` | Choose the subscription. The default is the one you signed in to (or `NOD_PROVIDER`) |
| `--model <id>` | Choose the model. The default is `gpt-5.6-luna` on ChatGPT, or the first model your plan lists |
| `--yes` | Run commands without asking |

```bash
nod models codex    # models your plan can use
```

```bash
nod logout codex
```

### Environment variables

| Variable | What it does |
|----------|--------------|
| `NOD_HOME` | Where sign-in tokens are stored (default `~/.nod`, files are mode 0600 and refreshed automatically) |
| `NOD_PROVIDER` | Default subscription |
| `NOD_NO_OPEN_BROWSER=1` | Print the login URL instead of opening a browser |

## How it works

nod is a loop around a model with two tools: `bash` to act and `task_complete` to finish. Reading, searching, editing and testing are all bash commands.

- **Every command starts fresh.** Each one runs in a new shell in your working directory. A timeout or `ctrl+c` stops the command and everything it started.
- **The model sees what you see.** Every command's exit code and output go back to the model, so it can recover from its own mistakes.
- **Conversations continue.** The history stays valid even after an interruption, so your next message picks up where you left off.

```ts
while (true) {
  const { content, toolCalls } = yield* llm.stream(messages, tools); // then run each bash call

  if (calledTaskComplete)                           return done("task_complete");
  if (aborted)                                      return done("interrupted");
  if (!toolCalls.length && nextTurnShouldCallTools) return done("answered", content);
  if (turn >= maxTurns)                             return done("max_turns");

  nextTurnShouldCallTools = toolCalls.length === 0;
}
```

## A note on subscriptions

Sign-in uses the OAuth clients of OpenAI's Codex CLI and xAI's Grok CLI against their subscription backends. The flows are ported from [vercel-labs/fx](https://github.com/vercel-labs/fx). These backends aren't public APIs and can change without notice. You're responsible for following each provider's terms.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, project layout, and how evals work. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md), and report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
