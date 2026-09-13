# Changelog

All notable changes to this project are documented here. The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

## [0.1.0] - Unreleased

nod is rebuilt on the architecture of [vercel-labs/fx](https://github.com/vercel-labs/fx), ported to TypeScript on Bun. Only the ChatGPT (Codex) and Grok subscription backends are kept; the Vercel AI Gateway, `setup`, `teams`, and `credits` are not part of nod.

### Added

- Tools with fx's names and schemas: `read_file`, `write_file`, `edit_file`, `glob_files`, `grep_files`, `shell` (background handles, interactive input, stop), `web_fetch`, `web_search`, `vision`, `ask_user_question`, `read_tool_result`, `skill`, `install_skill`, `subagent`, and MCP tool discovery (`capability_search`, `mcp_select_tool`, `mcp_features`).
- Permission modes `ask`, `auto` (helper-model review of routine commands), and `full-access`, with `allow`/`ask`/`deny` rules per tool in `~/.nod/settings.json`, workspace overrides, and session grants.
- Sessions saved under `~/.nod/sessions/` with resume (`nod -c`, `nod -r`, `nod resume`), recovery of interrupted turns, automatic compaction, titles, and local usage records (`nod usage`).
- `AGENTS.md` context (global, workspace, nested) with `--context-limit`, and additional workspace directories (`--add-dir`, `nod workspace`).
- Skills (`SKILL.md`) discovered from the workspace and `~/.nod/skills`, installable from GitHub, local paths, or skills.sh.
- MCP servers over stdio, streamable HTTP, and SSE, with OAuth, `.mcp.json` workspace configs, and trust prompts (`nod mcp`).
- `nod pr` and `nod issue` drafts, published through `gh` with `--create`.
- Interactive shell rebuilt on Ink: queued follow-ups, cancel with `esc`, `shift+tab` permission cycling, `ctrl+o` transcript, approvals, settings, images, notifications, and sounds.
- `nod ask` for one-shot requests with `--json`, `--quiet`, `--image`, `--system`, `--no-save`, `--resume`, `--continue-recovery`.
- `nod acp`, an Agent Client Protocol server over stdio, and the `nod/sdk` export with `createAgent()` and `createTerminal()`.
- Distribution: prebuilt binaries for macOS and Linux (x86_64, aarch64) on GitHub Releases, `curl -fsSL https://nod.anturno.cloud/setup.sh | bash`, `nod upgrade [--channel stable|dev]`, and automatic upgrade checks in the shell with `ctrl+g` to relaunch.
- Documentation site with per-topic docs, `llms.txt`, and `llms-full.txt`.

### Changed

- The CLI surface now mirrors fx: `nod ask <prompt>` replaces `nod "<prompt>"`, `--provider`/`--yes` are replaced by `nod provider`, `NOD_PROVIDER`, and the permission modes.
- Settings moved to `~/.nod/settings.json` (`provider`, `models`, `permission_mode`, `permission` rules, `auto_upgrade`, `update_channel`, …) plus a project-level `.nod.json`.

### Removed

- The single `bash` tool and `task_complete`; the `y`/`a`/`n` command approval prompt is replaced by the permission system.

## [0.0.1]

### Added

- Agent loop with two tools, `bash` and `task_complete`, with approval before every command.
- Sign-in with a ChatGPT (Codex backend) or Grok subscription: `nod login`, `logout`, and `models`.
- Interactive shell with `/model`, `/clear`, `/verbose`, and `/exit`, plus one-shot mode for scripts and CI.
- Switching models across subscriptions mid-conversation.
- Eval suite with reference solutions (`bun run eval`).
