---
title: "Slash commands"
description: "Reference for commands inside the interactive shell."
---

# Slash commands

Type `/` in the interactive shell to search commands. Anything else is sent to the model as a prompt. Commands that run outside the shell are listed in [CLI commands](https://nod.anturno.cloud/docs/using-nod/cli.md).

## Sessions and shell

| Command | Purpose |
| --- | --- |
| `/help` | Show interactive help. |
| `/clear` | Start a fresh session and keep workspace background processes. `/new` does the same. |
| `/reset` | Start a fresh session, then stop and forget workspace background processes. |
| `/resume` | Open the saved-session picker. |
| `/continue` | Continue a paused model response. |
| `/rename` | Rename the current session. Provide a title. |
| `/compact` | Compact older conversation turns now. |
| `/quit` | Exit nod. `/exit` is an alias. |

`/clear` and `/new` preserve background work for the current workspace. `/reset` stops and forgets that work. See [Sessions](https://nod.anturno.cloud/docs/using-nod/sessions.md) for saving, recovery, and compaction.

## Account, model, and runtime

| Command | Purpose |
| --- | --- |
| `/provider` | Choose the provider: `codex` or `grok`. |
| `/login` | Open the provider picker, or sign in to a named provider. |
| `/logout` | Sign out of the active or named provider. |
| `/model` | Open the model catalog, or select a model by ID or query. |
| `/fast` | Toggle fast mode when supported. |
| `/permissions` | Inspect or change the permission mode. |
| `/allowlist` | Inspect or change persistent permission rules. |

Use `/permissions full-access` to disable nod permission checks. `/permissions full access` and the legacy `/permissions yolo` are also accepted. See [Permissions](https://nod.anturno.cloud/docs/configure/permissions.md) for permission rules and modes.

## Inspection and settings

| Command | Purpose |
| --- | --- |
| `/status` | Show model, workspace, permissions, and session state. |
| `/stats` | Show current-session statistics. |
| `/usage` | Open local usage. `/cost` is an alias. |
| `/settings` | Open settings or change startup scrollback. |
| `/statusline` | Toggle footer fields. |
| `/sound` | Set completion sounds. |
| `/version` | Show the installed version. |

## Tools and local data

| Command | Purpose |
| --- | --- |
| `/image` | Attach an image. `/img` is an alias. |
| `/images` | Inspect or clear pending images. |
| `/paste` | Attach a clipboard image when supported. |
| `/mcp` | Browse [MCP](https://nod.anturno.cloud/docs/capabilities/mcp.md) servers, tools, resources, and prompts. Direct subcommands manage configuration, authentication, and project trust. |
| `/skills` | Browse and manage [skills](https://nod.anturno.cloud/docs/capabilities/skills.md). |
| `/workspace` | Manage saved additional directories. |
| `/undo` | Undo the most recent tracked file operation. |
| `/copy` | Copy the latest assistant response. |
| `/feedback` | Open the nod bug report form on GitHub. |

Additional workspace roots are active after they are saved or passed with leading `--add-dir` flags. See [Additional workspaces](https://nod.anturno.cloud/docs/configure/additional-workspaces.md). `/feedback` is covered in [Share feedback](https://nod.anturno.cloud/docs/using-nod/feedback.md).

### Undo tracked file changes

`/undo` reverses the most recent tracked file change. Run it again to undo older file changes.

It does not undo shell commands, Git history, or changes made outside nod's file tools.

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
