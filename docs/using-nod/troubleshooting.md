---
title: "Troubleshooting"
description: "Diagnose install, authentication, model, permission, session, and terminal problems."
---

# Troubleshooting

Start here when nod does not behave the way the rest of these docs describe. Most answers come from one command:

```bash
nod doctor
```

`nod doctor` checks the workspace, configuration, authentication, resolved startup settings, local session state, and Git integrations without starting an agent turn. When nod can recover a session problem, the output includes the exact command to run.

## Diagnostic commands

| Question | Command |
| --- | --- |
| Is my environment healthy? | `nod doctor` |
| What is nod actually using right now? | `nod status` or `nod status --json` |
| Which permission rules are in effect? | `nod permissions --json` |
| Which directories can tools reach? | `nod workspace --json` |
| Which models can I select? | `nod models --json` |
| What happened in the current session? | ctrl+o inside the shell, or `nod session last --json` |

## `nod: command not found`

The installer places the binary in `~/.local/bin`, or in `NOD_INSTALL_DIR` when you set it. If that directory is not on your `PATH`, the installer appends a `PATH` line to your shell profile, which takes effect in new shells.

Add it to the current shell:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

A `bun install -g` install lives in Bun's global bin directory instead; `bun pm bin -g` prints it. See [Installation](https://nod.anturno.cloud/docs/getting-started/installation.md) for the full list of what the installer changes.

## nod is not signed in

`nod needs a ChatGPT or Grok subscription.` means the active provider has no usable saved session. Sign in, or switch to the provider you are signed in to:

```bash
nod login codex
```

```bash
nod provider grok
```

```bash
nod status
```

nod does not fall back from one provider to the other. A provider selected in `/provider` or with `NOD_PROVIDER` stays selected even if its session becomes unavailable; sign in again or select the other provider explicitly. See [Provider selection](https://nod.anturno.cloud/docs/getting-started/authentication.md#provider-selection).

A few specific cases:

- **The browser never opens.** On a headless machine or over SSH, set `NOD_NO_OPEN_BROWSER=1` before `nod login` to print the authorization URL instead.
- **The session expired.** `nod doctor` reports the auth check as a warning. `nod login codex` or `nod login grok` refreshes it.
- **The plan is not eligible.** Codex needs a ChatGPT Plus, Pro, Business, Enterprise, or Edu plan; Grok needs SuperGrok or X Premium. A sign-in that succeeds but lists no models usually means the plan does not include agent access.

## The model is not the one I chose

`nod status` and `/status` print the effective model. nod resolves it in this order: `NOD_MODEL` for the process, your user default for the active provider in `~/.nod/settings.json`, then the provider's default. Project `.nod.json` cannot set `model`, so a repository never changes your selection. See [Models](https://nod.anturno.cloud/docs/configure/models.md).

## A model is missing from the catalog

The catalog belongs to the active provider and depends on the plan behind the subscription, so availability differs between ChatGPT and Grok accounts.

```bash
nod models
```

A model saved in settings that the subscription no longer lists is reported and replaced by the provider's default for that run.

## nod stops before running a tool

In `auto` mode, nod applies saved rules and reviews actions that need a closer look. A concern or unavailable review holds the action and returns guidance to the agent; it does not open an approval prompt.

If an action needs your approval, use `ask` mode in the interactive shell. `nod ask` is noninteractive by default; `--prompt-permissions` allows configured approval prompts only when stdin is a terminal. For repeated work:

1. Add an allow rule for the exact action with `/allowlist`.
2. Use `auto` mode when you want automatic review of unresolved actions.
3. Use `--full-access` only in a trusted environment; it disables nod permission checks for that run. The legacy `--yolo` flag remains an alias.

An interrupted headless run exits with code `130`. See [Permissions](https://nod.anturno.cloud/docs/configure/permissions.md) and [`nod ask`](https://nod.anturno.cloud/docs/using-nod/nod-ask.md).

## nod ignores my AGENTS.md

- Only the primary workspace contributes project instructions. Additional directories do not.
- `context: false` in `.nod.json` or user settings disables project context entirely.
- Instruction files are bounded by `project_instruction_file_bytes` and `project_instructions_total_bytes`. Truncated or omitted context is reported to the runtime instead of being treated as complete, so raise the limit when a file is larger. See [Context limits](https://nod.anturno.cloud/docs/configure/context-limits.md).
- The narrowest applicable `AGENTS.md` wins, so a nested file can override the repository root for calls inside its directory.

## A session will not open or resume

`nod doctor` inspects saved sessions and names the remediation for each problem it finds. To make a separate resumable copy without touching the original:

```bash
nod session recover <session-id>
```

To inspect one session without starting a turn:

```bash
nod session --id <session-id> --json
```

A paused response can be continued with `/continue` in the shell, or with `nod ask --resume last --continue-recovery` in a headless run. See [Sessions](https://nod.anturno.cloud/docs/using-nod/sessions.md).

## An MCP server is missing

```bash
nod mcp list
```

The default command reads configuration and stored authentication without opening a transport. Add `--connect` when you need live startup, discovery, and health. Inside the interactive shell, `/mcp list` shows the active runtime.

- Native sessions combine the private `~/.nod/mcp.json` profile with the workspace `.mcp.json`. A profile entry wins a same-name project entry.
- Project servers stay disconnected until you approve them with `/mcp trust approve <name>` or `nod mcp trust approve <name>`. Approval also unlocks project environment expansion.
- A missing required `${VAR}` in an approved project entry skips that server without exposing the value. `nod status`, `nod doctor`, and MCP listings report the configuration issue.
- Optional servers can fail without blocking the rest of nod. Set `"required": true` when the first request must wait for a ready server.
- `/mcp reload` validates a replacement before publishing it. Invalid configuration or a failed required server keeps the previous runtime.
- Slow servers receive 30 seconds to start by default. Raise `startup_timeout_ms` for a known longer cold start.
- ACP sessions combine client-supplied servers with approved project servers, but inherit nothing from your profile.

See [MCP](https://nod.anturno.cloud/docs/capabilities/mcp.md) for configuration and [MCP protocol reference](https://nod.anturno.cloud/docs/capabilities/mcp/protocol.md) for transport behavior.

## The terminal renders incorrectly

nod picks light or dark colors from the terminal. Force one theme to test a contrast problem:

```bash
NOD_THEME=light nod
```

If the shell keeps the alternate screen after an abnormal exit, run `reset`. If the problem persists, note the terminal emulator, its version, and the output of `nod status --json`, and [share feedback](https://nod.anturno.cloud/docs/using-nod/feedback.md).

## Usage is higher than expected

`nod usage` reports only what nod recorded on this machine. Automatic permission review and the `vision` tool add model requests; on Codex the review runs on `gpt-5.4-mini`, on Grok on the session model. Subagents run their own conversations. See [Usage](https://nod.anturno.cloud/docs/using-nod/usage.md).

> **Redact before you share**
>
> `nod status --json` and session JSON stay local until you share them, and they can contain prompts, code, paths, commands, model output, or secrets. Review them first.

Still stuck? [Share feedback](https://nod.anturno.cloud/docs/using-nod/feedback.md) with the reviewed output attached.

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
