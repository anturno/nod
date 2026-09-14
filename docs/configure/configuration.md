---
title: "Configuration"
description: "Reference for nod settings, scopes, defaults, and environment variables."
---

# Configuration

nod separates repository-safe defaults from private user and workspace preferences. Use `/settings`, `/permissions`, and `/workspace` when possible; direct JSON editing is useful for settings that do not have an interactive control.

## Files and precedence

| Layer | Location | Scope |
| --- | --- | --- |
| User profile | `~/.nod/settings.json` | Private global preferences and per-workspace overrides |
| Project | `<workspace>/.nod.json` | Repository-safe defaults that may be committed |
| MCP profile | `~/.nod/mcp.json` | Private MCP server definitions |
| Project MCP | `<workspace>/.mcp.json` | Repository-scoped MCP definitions whose effects require profile-owned trust |

MCP files have their own merge and trust rules rather than the settings precedence below. See [MCP](https://nod.anturno.cloud/docs/capabilities/mcp.md) for their exact shapes and behavior.

For each setting, the highest available source wins:

1. command-line or process override, where supported
2. environment variable
3. matching workspace entry in `~/.nod/settings.json`
4. global entry in `~/.nod/settings.json`
5. `<workspace>/.nod.json`
6. built-in default

The settings file is limited to 64 KiB. Unknown JSON keys are ignored, but invalid values in known keys can make a layer unusable and produce a startup diagnostic.

## Project configuration

`.nod.json` accepts exactly three public fields:

```json
{
  "max_agent_steps": 40,
  "max_tool_result_bytes": 131072,
  "context": true
}
```

| Field | Type and values | Default | Meaning |
| --- | --- | --- | --- |
| `max_agent_steps` | Non-negative integer | `0` | Maximum model tool-loop steps; `0` means unlimited. |
| `max_tool_result_bytes` | Integer of at least `1024` | `65536` | Maximum bytes retained from one tool result. |
| `context` | Boolean | `true` | Load project instructions and related workspace context. |

Profile-only fields such as model, provider, permission mode and rules, effort, notifications, update channel, and additional directories are ignored in project config and reported as a diagnostic. `context_limits` is also profile-only.

## User profile

A complete representative `~/.nod/settings.json` looks like this. Omit values you want nod to resolve from a lower layer or its defaults.

```json
{
  "provider": "codex",
  "models": {
    "codex": "gpt-5.4",
    "grok": "grok-4"
  },
  "permission_mode": "auto",
  "max_agent_steps": 0,
  "max_tool_result_bytes": 65536,
  "first_call_tool_choice": "auto",
  "context": true,
  "context_limits": {
    "skill_catalog_bytes": 16384,
    "project_instructions_total_bytes": 131072
  },
  "fast_mode": false,
  "effort": "auto",
  "slash_menu_categories": true,
  "auto_upgrade": true,
  "update_channel": "stable",
  "startup_scrollback": true,
  "collapse_tool_calls": false,
  "session_titles": true,
  "prompt_history": {
    "enabled": true
  },
  "statusLine": {
    "context": false,
    "session": false,
    "workspace": false
  },
  "notifications": {
    "turn_end": true,
    "attention_required": true,
    "max": false
  },
  "permission": {
    "*": "ask"
  },
  "workspaces": {
    "/absolute/path/to/project": {
      "additional_directories": [
        "/absolute/path/to/shared"
      ],
      "permission": {
        "edit": {
          "*": "deny",
          "docs/*": "allow"
        }
      }
    }
  }
}
```

### Agent and model settings

| Field | Type and values | Default |
| --- | --- | --- |
| `provider` | `"codex"` or `"grok"` | `"codex"` |
| `models` | Object keyed by provider, each a non-empty model ID for that provider | The provider default |
| `permission_mode` | `"ask"`, `"auto"`, or `"full-access"`; legacy `"yolo"` is also accepted | `"auto"` |
| `max_agent_steps` | Non-negative integer; `0` is unlimited | `0` |
| `max_tool_result_bytes` | Integer of at least `1024` | `65536` |
| `first_call_tool_choice` | `"auto"` or `"none"` | `"auto"` |
| `context` | Boolean | `true` |
| `fast_mode` | Boolean | `false` |
| `effort` | `"auto"`, `"none"`, `"minimal"`, `"low"`, `"medium"`, `"high"`, `"xhigh"`, or `"max"`; `null` resets to auto | `"auto"` |

nod keeps one model per provider, so switching providers and switching back restores the model you were using. `model`, `codex_model`, and `grok_model` are older spellings of the same values. nod still reads them, and rewrites them: saving a model writes it under `models` and removes the older key, so a hand-written `"model"` disappears from the file the first time nod saves that preference.

`context_limits` accepts the keys and byte values listed in [Context limits](https://nod.anturno.cloud/docs/configure/context-limits.md). Permission rules accept `"allow"`, `"ask"`, and `"deny"`; see [Permissions](https://nod.anturno.cloud/docs/configure/permissions.md) for matching and scope.

Use `"permission_mode": "full-access"` for full access. Legacy `"yolo"` input remains accepted. For backward compatibility, nod still serializes this mode as `"yolo"` in saved settings and wire JSON; the interface displays "full access".

`permission_mode: "auto"` enables automatic review for eligible unresolved actions. Reviews use the active provider. See [Automatic review configuration](https://nod.anturno.cloud/docs/configure/permissions.md#automatic-review-configuration) for the reviewer used by each provider.

### Interface and update settings

| Field | Type and values | Default |
| --- | --- | --- |
| `slash_menu_categories` | Boolean | `true` |
| `auto_upgrade` | Boolean | `true` |
| `update_channel` | `"stable"` or `"dev"` | `"stable"` |
| `startup_scrollback` | Boolean | `true` |
| `collapse_tool_calls` | Boolean | `false` |
| `session_titles` | Boolean | `true` |
| `prompt_history.enabled` | Boolean | `true` |
| `statusLine.context` | Boolean | `false` |
| `statusLine.session` | Boolean | `false` |
| `statusLine.workspace` | Boolean | `false` |
| `notifications.turn_end` | Boolean | On by default on macOS, off elsewhere |
| `notifications.attention_required` | Boolean | On by default on macOS, off elsewhere |
| `notifications.max` | Boolean | `false` |

Set `collapse_tool_calls` to `true` to show a summary for each tool-call group. Individual calls remain available in the full transcript with ctrl+o. `startup_scrollback` prints the transcript to the main screen when nod exits, so it stays in your terminal's scrollback. `session_titles` lets nod name a new session from its first prompt.

### nod-managed fields

`credential_source` and `yolo_acknowledged` are valid profile fields, but nod manages them through authentication and permission flows. The `yolo_acknowledged` key retains its name for backward compatibility with full access acknowledgement. Avoid editing them by hand.

Credential source values are `chatgpt_subscription` and `grok_subscription`; see [Authentication](https://nod.anturno.cloud/docs/getting-started/authentication.md#model-providers).

## Workspace entries

Keys under `workspaces` are absolute primary workspace paths. nod saves workspace-local permission rules, `additional_directories`, and project MCP trust there. An additional-directory list contains at most 16 unique absolute directory paths.

A workspace object is parsed with the same setting schema as the top-level profile and may therefore carry deliberate local overrides, including `context_limits` and the three project-safe fields. The current interactive controls save model, effort, fast mode, permission mode, prompt history, status line, notification, and update preferences globally; older workspace copies of model and interface preferences are treated as legacy and may be migrated.

Additional directories extend tool access only. They do not contribute config, `AGENTS.md`, skills, hooks, Git identity, sessions, or history. See [Additional workspaces](https://nod.anturno.cloud/docs/configure/additional-workspaces.md).

## Environment variables

These are the supported process overrides:

| Variable | Purpose |
| --- | --- |
| `NOD_HOME` | Use another directory instead of `~/.nod` for all local state. |
| `NOD_PROVIDER` | Override the provider for this process: `codex` or `grok`. |
| `NOD_MODEL` | Override the model for this process. |
| `NOD_PERMISSION_MODE` | Override with `ask`, `auto`, or `full-access`; legacy `yolo` is also accepted. |
| `NOD_MAX_AGENT_STEPS` | Override the agent step limit. |
| `NOD_REVIEWER_MODEL` | Run automatic permission review on another model of the active provider. |
| `NOD_CONTEXT_WINDOW` | Override the context window size, in tokens, used for compaction and the skill catalog budget. |
| `NOD_THEME` | Force `light` or `dark` terminal theming. |
| `NOD_SOUND` | Override sounds with `on`, `off`, or `max`. |
| `NOD_AUTO_UPGRADE=0` | Disable automatic upgrade checks for the process. |
| `NOD_NO_OPEN_BROWSER=1` | Print authentication URLs instead of opening a browser. |
| `NOD_INSTALL_DIR` | Where `setup.sh` and `nod upgrade` install the binary; defaults to `~/.local/bin`. |

Environment and command-line overrides affect only the current process and are not written back to settings.

## Inspect effective configuration

Inspect the resolved startup configuration as text or JSON:

```bash
nod status
```

```bash
nod status --json
```

Use `nod permissions --json` for the resolved permission rules and `nod workspace --json` for active additional directories.

## Local state

nod stores private runtime state under `~/.nod/`, including settings, saved provider sessions, sessions, prompt history, usage, MCP config and credentials, and managed skills.

> **Keep local state private**
>
> Do not copy `~/.nod` into a repository. It can contain credentials, prompts, transcripts, paths, permission rules, and MCP environment values.

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
