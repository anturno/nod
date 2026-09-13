# nod

[![CI](https://github.com/anturno/nod/actions/workflows/ci.yml/badge.svg)](https://github.com/anturno/nod/actions/workflows/ci.yml) [![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

**A coding agent for your terminal that runs on the ChatGPT or Grok subscription you already pay for.**

Website: [nod.anturno.cloud](https://nod.anturno.cloud)

nod is a TypeScript port of [vercel-labs/fx](https://github.com/vercel-labs/fx): a coding agent CLI whose interface stays closer to a Unix shell than an IDE in the terminal. It reads and edits files, runs commands in the background, searches the web, follows skills, talks to MCP servers, delegates to subagents, and asks before it acts. Sessions are saved locally and can be resumed. There is no API key and nothing is billed per token.

```bash
nod ask "add() in src/math.ts returns the wrong result. Fix it and run the tests."
```

## Install

```bash
curl -fsSL https://nod.anturno.cloud/setup.sh | bash
```

The installer downloads a prebuilt binary for macOS or Linux (x86_64 and aarch64) from [GitHub Releases](https://github.com/anturno/nod/releases), verifies its checksum, installs it to `~/.local/bin` (or `NOD_INSTALL_DIR`), and adds that directory to your `PATH` if needed. Pass a version to pin it: `curl -fsSL https://nod.anturno.cloud/setup.sh | bash -s -- v0.1.0`.

If you have [Bun](https://bun.sh) 1.4 or later, you can run it from source instead:

```bash
bun install -g github:anturno/nod
```

Then sign in with one of your subscriptions. Login opens your browser; for Grok you can also paste the code xAI shows you.

```bash
nod login codex     # ChatGPT: Plus, Pro, Business, Enterprise or Edu
nod login grok      # Grok: SuperGrok or X Premium
```

## Use it

Run `nod` inside a project to open the interactive shell:

```bash
cd your_project
nod
```

Or make a one-shot request. `--json` prints a machine-readable result, which suits scripts and CI:

```bash
nod ask "explain the changes in this repository"
nod ask --json "list the files in src"
```

Inside the shell, run `/help` to browse the interactive commands.

## What nod can do

- **Tools.** `read_file`, `write_file`, `edit_file`, `glob_files`, `grep_files`, `shell` (background processes with handles, interactive input, stop), `web_fetch`, `web_search`, `vision`, `ask_user_question`, `read_tool_result`, `skill`, `install_skill`, `subagent`, and MCP tools discovered at runtime (`capability_search`, `mcp_select_tool`, `mcp_features`).
- **Permissions.** Three modes: `ask` prompts before every mutating action, `auto` (default) lets a helper model approve routine, reversible commands and asks for the rest, and `full-access` disables the checks. Per-tool `allow` / `ask` / `deny` rules with wildcards live in `~/.nod/settings.json`, globally and per workspace, and "don't ask again" grants last for the session.
- **Sessions.** Every conversation is saved under `~/.nod/sessions/`. Resume the last one with `nod -c`, pick one with `nod -r`, or continue a specific id with `nod resume <id>`. Interrupted turns are checkpointed and can be recovered; long conversations are compacted automatically.
- **Context.** `AGENTS.md` files (global, workspace, and nested) are added to the prompt, with per-file limits you can tune with `--context-limit`.
- **Skills.** `SKILL.md` folders in your workspace or `~/.nod/skills` are advertised to the model; install more from GitHub, a local path, or skills.sh with `/skills install`.
- **MCP.** Add stdio, streamable HTTP, or SSE servers with `nod mcp add`, or drop a `.mcp.json` in the workspace (Claude-compatible). Workspace servers stay pending until you trust them.
- **Editors and hosts.** `nod acp` runs an [Agent Client Protocol](https://agentclientprotocol.com) server over stdio for editors. The `nod/sdk` export gives JavaScript hosts `createAgent()` and `createTerminal()` with their own transport, storage, and permission handling.
- **Git.** `nod pr` and `nod issue` draft (and with `--create`, publish through `gh`) a pull request or issue from the current changes.

## Commands

| Command | What it does |
|---------|--------------|
| `nod` | Open the interactive shell |
| `nod ask [flags] <prompt>` | Run one noninteractive request (`--json`, `--quiet`, `--image`, `--system`, `--no-save`, `--resume last\|<id>`, `--auto`, `--full-access`) |
| `nod resume [last\|<id>]`, `nod -c`, `nod -r` | Continue a saved interactive session |
| `nod sessions`, `nod session <last\|id>` | List and inspect saved sessions (`--json`) |
| `nod login [codex\|grok]`, `nod logout`, `nod provider <codex\|grok>`, `nod models` | Manage subscriptions and the active model |
| `nod permissions`, `nod workspace list\|add\|remove\|clear` | Show permission rules; manage additional directories |
| `nod mcp add\|list\|auth\|logout\|path\|remove\|trust` | Manage MCP servers |
| `nod pr`, `nod issue` | Draft or publish a pull request or issue |
| `nod status`, `nod doctor`, `nod usage [--period 24h\|7d\|30d]` | Configuration, health checks, and local token usage |
| `nod acp` | Start an ACP server over stdio |
| `nod upgrade [--channel stable\|dev]` | Upgrade the binary from GitHub Releases and remember the channel |

Global flags go before the command: `--full-access` (or `--yolo`), `--add-dir <path>`, `--no-additional-dirs`, `--context-limit <key>=<bytes|off>`.

### In the shell

Type `/` to see the commands: `/help /new /resume /rename /compact /model /models /provider /login /permissions /settings /status /usage /skills /mcp /workspace /image /paste /copy /undo /quit`. `tab` completes and `enter` runs.

| Key | What it does |
|-----|--------------|
| `enter` during a turn | Queue the draft as a follow-up for the next model request |
| `esc` | Cancel the running turn (double `esc` clears the draft when idle) |
| `ctrl+c` | Clear the draft, then press again within 3 s to save and exit |
| `shift+tab` | Cycle the permission mode: `ask` → `auto` → `full access` |
| `ctrl+o` | Open the full transcript |
| `ctrl+g` | Relaunch into an update the shell installed in the background |
| `$` / `@` / `/` | Pick a skill, a file, or a command |

### Configuration

Settings live in `~/.nod/settings.json` (per-workspace overrides under `workspaces`) and in a `.nod.json` at the project root. Useful keys: `provider`, `models`, `permission_mode`, `permission` rules, `max_agent_steps`, `effort`, `context_limits`, `auto_upgrade`, `update_channel`, `notifications`, `prompt_history`.

| Variable | What it does |
|----------|--------------|
| `NOD_HOME` | Where settings, sessions, skills, and sign-in tokens are stored (default `~/.nod`) |
| `NOD_PROVIDER`, `NOD_MODEL` | Default subscription and model |
| `NOD_PERMISSION_MODE` | `ask`, `auto`, or `full-access` |
| `NOD_MAX_AGENT_STEPS` | Stop a turn after this many tool steps (`0` = unlimited) |
| `NOD_AUTO_UPGRADE=0` | Skip automatic upgrade checks in the interactive shell |
| `NOD_THEME`, `NOD_SOUND` | Force `light`/`dark`; enable or silence notification sounds |
| `NOD_NO_OPEN_BROWSER=1` | Print the login URL instead of opening a browser |

## Upgrade

```bash
nod upgrade                    # latest release on the remembered channel
nod upgrade --channel dev      # switch to development builds (prereleases tagged dev-<sha>)
```

The interactive shell checks for a new release every 30 minutes, installs it in place, and offers `ctrl+g` to relaunch into it. Set `auto_upgrade: false` or `NOD_AUTO_UPGRADE=0` to turn that off. When nod runs from source, `nod upgrade` tells you to reinstall with `bun install -g github:anturno/nod`.

## A note on subscriptions

Sign-in uses the OAuth clients of OpenAI's Codex CLI and xAI's Grok CLI against their subscription backends. The flows are ported from [vercel-labs/fx](https://github.com/vercel-labs/fx). These backends aren't public APIs and can change without notice. You're responsible for following each provider's terms.

## Contributing

Issues and pull requests are welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for setup, project layout, verification, releases, and how evals work. Please follow the [Code of Conduct](CODE_OF_CONDUCT.md), and report security issues privately as described in [SECURITY.md](SECURITY.md).

## License

[MIT](LICENSE)
