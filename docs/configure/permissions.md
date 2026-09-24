---
title: "Permissions"
description: "Control tool execution with modes, rules, and session grants."
---

# Permissions

nod checks tool calls against your saved rules, session grants, and permission mode before running them. Reading files within the workspace does not normally need approval. File changes, commands, and access to external paths are subject to the permission policy.

## Modes

| Mode | Behavior |
| --- | --- |
| `ask` | Prompt before unresolved sensitive tool calls. |
| `auto` | Apply rules, then automatically review unresolved calls. This is the default. |
| `full-access` | Disable nod permission checks. Shown as "full access" in the interface. |

In `auto`, routine actions run directly. Other unresolved actions receive a review of the exact pending action. If the review raises a concern or cannot complete, nod holds the action and returns guidance to the agent. Automatic review does not open a human approval prompt.

### Change the mode

Inside nod:

```bash
/permissions ask
```

```bash
/permissions auto
```

```bash
/permissions full-access
```

`/permissions full access` is also accepted. The legacy `/permissions yolo` command remains compatible.

`/permissions reset` switches back to `ask` and clears the grants collected in this session.

Outside nod, inspect the effective mode and rules:

```bash
nod permissions --json
```

Start a run with `nod --full-access` or `nod ask --full-access <prompt>` to disable nod permission checks for that process. `--yolo` remains a backward-compatible CLI alias.

The mode also comes from `permission_mode` in `~/.nod/settings.json` or the `NOD_PERMISSION_MODE` process override. Both accept `full-access` and legacy `yolo`. Saved settings and wire JSON continue to use `"yolo"` for compatibility; see [Configuration](https://nod.anturno.cloud/docs/configure/configuration.md).

### Automatic review configuration

Automatic review is active when the effective `permission_mode` is `"auto"`. Configure it through `~/.nod/settings.json`, `/permissions auto`, or the `NOD_PERMISSION_MODE=auto` process override. Permission rules and session grants are evaluated first, so only eligible unresolved calls reach the reviewer.

Automatic review sends a separate request through the active [provider](https://nod.anturno.cloud/docs/getting-started/authentication.md#model-providers), covered by that subscription. The reviewer belongs to the provider:

| Provider | Reviewer |
| --- | --- |
| Codex | `gpt-5.4-mini` when the plan lists it, otherwise the session model |
| Grok | The model selected for the session |

Set `NOD_REVIEWER_MODEL` to run the review on another model of the active provider for one process. Otherwise, on Codex, changing `model`, `NOD_MODEL`, or the model selected in the shell does not change the reviewer. On Grok it does, because the review runs on the session model.

Because review is an additional model request, an unresolved call in `auto` mode uses more of your subscription's rate limit than the same call in `ask` mode. A transient failure or invalid response can cause one bounded second review request. Add narrow allow or deny rules when you want known actions settled without an automatic review. See [Additional model requests](https://nod.anturno.cloud/docs/using-nod/usage.md#additional-model-requests).

## When nod asks

In `ask` mode, unresolved sensitive calls open an approval prompt with three choices:

| Choice | Effect |
| --- | --- |
| Yes | Run this request without creating a grant. |
| Yes, and don't ask again | Run it and create a session grant for the displayed scope. |
| No | Do not run the request. |

Press `1`, `2`, or `3` to choose. With **No**, you can type a note that is returned to the agent with the refusal.

## Persistent rules

Permission rules are stored in `~/.nod/settings.json`, either globally or under the current workspace profile. Project `.nod.json` files cannot define them.

```json
{
  "permission": {
    "*": "ask",
    "bash": {
      "git *": "allow",
      "git push *": "deny"
    },
    "edit": {
      "*": "deny",
      "docs/*": "allow"
    }
  }
}
```

Rules use wildcard matching. The last matching rule wins, and workspace rules take precedence over user-global rules.

Rule names follow the permission a tool asks for: `read` for `read_file`, `edit` for `write_file` and `edit_file`, `glob` and `grep` for the search tools, `bash` for `shell`, `skill` for the skill tools, `web_fetch`, `web_search`, and the tool name for everything else, including `mcp_<server>_<tool>`.

Put broad rules before specific exceptions. In the example above, edits are denied by default and then allowed under `docs/`.

Manage rules in the interactive shell:

```text
/allowlist view effective
/allowlist local add command "bun test"
/allowlist user add tool read_file
/allowlist local remove command "bun test"
/allowlist local reset all
```

Prefer `local` rules for repository-specific authority. A `user` allow rule can apply in every project that does not override it.

## Session grants

Choosing "Yes, and don't ask again" creates a live session grant. It is not written to settings and is not restored by `nod resume`.

> **Full access bypasses permission checks**
>
> Full access disables nod permission checks. Use it only in an environment you trust. The `--full-access` flag affects only that process and does not change the saved permission mode.

If a call is denied or reviewed when you did not expect it, see [Troubleshooting](https://nod.anturno.cloud/docs/using-nod/troubleshooting.md#nod-stops-before-running-a-tool).

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
