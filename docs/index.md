---
title: "Quick start"
description: "Install nod, run a first request, and learn the commands worth knowing."
---

# Quick start

## Install and sign in

```bash
curl -fsSL https://nod.anturno.cloud/setup.sh | bash
```

The installer places `nod` in `~/.local/bin`. Read [Installation](https://nod.anturno.cloud/docs/getting-started/installation.md) before piping the script to a shell, or if `nod` is not on your `PATH` afterward. If you already have Bun 1.4 or newer, `bun install -g github:anturno/nod` works too.

Sign in with the subscription you already pay for:

```bash
nod login codex
```

`nod login codex` opens the ChatGPT authorization flow and saves the session for later runs. Use `nod login grok` for a SuperGrok or X Premium subscription instead; see [Authentication](https://nod.anturno.cloud/docs/getting-started/authentication.md).

## Run your first request

Start nod from the project you want to work on. The launch directory becomes the primary workspace:

```bash
cd path/to/project
```

```bash
nod
```

Type a request that names real files or commands, then press enter:

```text
Read src/ and tell me how requests are routed. Then add a test for the
error path in the router and run the test suite.
```

nod streams its reply and shows the tools it runs. To redirect work already in progress, type a follow-up and press enter. Press escape to cancel, or ctrl+o to inspect the full transcript. Ctrl+c clears a nonempty draft; with an empty draft, it cancels the active turn.

## What nod checks before it acts

nod starts in `auto` permission mode. It applies your saved rules, runs routine actions, and reviews actions that need a closer look. If the review raises a concern or cannot complete, nod holds the action and returns guidance to the agent.

Use `ask` mode if you want approval prompts for unresolved sensitive actions. Reading files within the workspace does not normally need approval; changing files, running commands, and accessing external paths are subject to the permission policy.

Switch modes with `/permissions` at any time, and see [Permissions](https://nod.anturno.cloud/docs/configure/permissions.md) for rules, modes, and how automatic review works.

> **Approve deliberately**
>
> Read the scope shown in an approval prompt before accepting it. Full access mode disables nod permission checks; use it only in an environment you trust.

## Things to know

In an interactive session, type `/` to open the available commands. See [Slash commands](https://nod.anturno.cloud/docs/using-nod/slash-commands.md) for the full reference.

| Need | Use |
| --- | --- |
| Open available commands | Type `/` |
| Find a file | Type `@` |
| Find a skill | Type `$` |
| Inspect the current model, workspace, permissions, and session | `/status` |
| Choose a model | `/models` |
| Change the permission mode | `/permissions` |
| Start a new session | `/new` |
| Attach an image | `/image ./path.png` |
| View local usage | `/usage` |
| Turn completion sounds on or off | `/sound on` or `/sound off` |
| Share feedback | `/feedback` |

Every interactive command is listed in [Slash commands](https://nod.anturno.cloud/docs/using-nod/slash-commands.md).

## Shortcuts

| Action | Shortcut |
| --- | --- |
| Insert a newline | shift+enter, alt+enter, or backslash then enter |
| Move through prompt history | up or down at the edge of the draft |
| Steer the active turn with a follow-up | enter |
| Interrupt the current turn | escape, or ctrl+c with an empty draft |
| Open Review and Full transcript | ctrl+o, then left or right |

## Continue your work

Open the session picker to choose a saved session:

```bash
nod -r
```

Resume the latest session for the current workspace directly:

```bash
nod resume last
```

See [Sessions](https://nod.anturno.cloud/docs/using-nod/sessions.md) for recovery and compaction. For a single noninteractive request, use [`nod ask`](https://nod.anturno.cloud/docs/using-nod/nod-ask.md). If something does not work as described here, start with [Troubleshooting](https://nod.anturno.cloud/docs/using-nod/troubleshooting.md).

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
