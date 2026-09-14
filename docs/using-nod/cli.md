---
title: "CLI commands"
description: "Reference for top-level nod commands and global flags."
---

# CLI commands

Run `nod` with no command to start a fresh interactive session. Use the commands below to run requests, continue sessions, inspect local state, and configure nod.

`nod <command> --help` prints the exact option list for one command. Interactive `/` commands are documented separately in [Slash commands](https://nod.anturno.cloud/docs/using-nod/slash-commands.md).

These commands accept `--json` for machine-readable output: `ask`, `status`, `doctor`, `permissions`, `models`, `workspace`, `session`, `sessions`, `usage`, and `upgrade`. The others print text only.

## Run nod

| Command | Purpose |
| --- | --- |
| `nod` | Start a fresh interactive session. |
| `nod ask <prompt>` | Run one noninteractive request. See [`nod ask`](https://nod.anturno.cloud/docs/using-nod/nod-ask.md). |
| `nod resume [last\|<id>]` | Continue a saved interactive session; `--id <id>` forces an exact ID. |
| `nod pr [context]` | Draft a pull request; add `--create` to publish with `gh`. |
| `nod issue [context]` | Draft an issue; add `--create` to publish with `gh`. |
| `nod acp` | Start an ACP server over stdio. See [ACP server](https://nod.anturno.cloud/docs/using-nod/acp.md). |

`nod pr` and `nod issue` accept `--auto` to review unresolved permission requests automatically, and must run inside a Git repository.

## Sessions and local records

| Command | Purpose |
| --- | --- |
| `nod sessions` | List sessions for the current workspace. Accepts `--all`, `--limit <1-100>`, and `--cursor <cursor>`. |
| `nod session <last\|id>` | Inspect one session. `--id <id>` forces an exact ID. |
| `nod session resume [last\|<id>]` | Resume a session; the same as `nod resume`. |
| `nod session migrate <id>` | Migrate a saved session to the current format; `--allow-large` permits an oversized session. |
| `nod session recover <id>` | Copy a recoverable corrupt session without changing the source. |
| `nod usage [--period <24h\|7d\|30d>]` | Show token usage recorded by nod on this machine. |

See [Sessions](https://nod.anturno.cloud/docs/using-nod/sessions.md) for the full workflow.

## Account and configuration

| Command | Purpose |
| --- | --- |
| `nod login [codex\|grok]` | Sign in with a ChatGPT (Codex) or Grok subscription. |
| `nod logout [codex\|grok]` | Sign out of the saved session for that provider. |
| `nod provider <codex\|grok>` | Choose the provider nod uses for models. |
| `nod models` | List the models of the active provider. |
| `nod permissions` | Show the permission mode and rules. |
| `nod workspace [list\|add PATH\|remove PATH\|clear]` | Manage additional workspace directories. |

`nod login` and `nod logout` are interactive, and `nod provider` becomes interactive when the provider you name has no saved session. See [Authentication](https://nod.anturno.cloud/docs/getting-started/authentication.md).

## MCP management

Top-level MCP commands operate without opening the interactive shell or contacting a model provider:

| Command | Purpose |
| --- | --- |
| `nod mcp add <name> <command> [args...]` | Add or replace a local stdio server in the private profile. |
| `nod mcp add --transport http <name> <url>` | Add or replace a Streamable HTTP server in the private profile. |
| `nod mcp list` | Inspect profile and project configuration plus stored authentication without connecting servers. |
| `nod mcp list --connect` | Connect configured servers, run discovery, and show live health. |
| `nod mcp auth <name>` | Run the remote OAuth flow. |
| `nod mcp logout <name>` | Remove stored credentials and attempt remote revocation when supported. |
| `nod mcp path` | Print the private profile path. |
| `nod mcp remove <name>` | Remove a server from the private profile. |
| `nod mcp trust approve\|reject <name>` | Approve or reject one project server for the current workspace. |
| `nod mcp trust approve-all` | Approve every server in the current workspace `.mcp.json`. |
| `nod mcp trust reset` | Clear the current workspace's project MCP choices. |

These commands print text rather than structured JSON. See [MCP](https://nod.anturno.cloud/docs/capabilities/mcp.md) for configuration shapes, interactive commands, and project trust behavior.

## Diagnostics and maintenance

| Command | Purpose |
| --- | --- |
| `nod status` | Show configuration and runtime information. |
| `nod doctor` | Run local health and preflight checks. |
| `nod upgrade [--channel <stable\|dev>]` | Upgrade nod and optionally remember a release channel. |
| `nod help` | Show top-level help. `-h` and `--help` are aliases. |

## Global flags

Global flags are leading flags: place them before a command.

- `--full-access` disables nod permission checks for the run. `--yolo` remains a backward-compatible alias. See [Permissions](https://nod.anturno.cloud/docs/configure/permissions.md) before using it.
- `--context-limit <name=bytes|off>` overrides one context limit and can be repeated.
- `--add-dir <path>` adds a process-only workspace directory and can be repeated.
- `--no-additional-dirs` ignores saved additional directories for this process.
- `-r` opens the interactive session picker.
- `-c`, `--continue`, and `--resume-last` resume the latest workspace session.
- `--resume [last|<id>]` resumes the latest session when no target is provided, while `--resume-<id>` resumes an exact session ID.
- `-h`, `--help` prints help; `-v`, `--version` prints the version.

See [Additional workspaces](https://nod.anturno.cloud/docs/configure/additional-workspaces.md) and [Context limits](https://nod.anturno.cloud/docs/configure/context-limits.md) for the full behavior of those repeatable global flags.

## Environment overrides

`NOD_MODEL`, `NOD_PROVIDER`, `NOD_PERMISSION_MODE`, `NOD_MAX_AGENT_STEPS`, and the other supported variables are listed in [Configuration](https://nod.anturno.cloud/docs/configure/configuration.md#environment-variables). They affect only the current process and are never written back to settings.

If a command fails or does not report what you expect, see [Troubleshooting](https://nod.anturno.cloud/docs/using-nod/troubleshooting.md).

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
