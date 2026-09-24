---
title: "nod ask"
description: "Run noninteractive requests, return JSON, and continue saved sessions."
---

# nod ask

`nod ask` runs one noninteractive request and exits. Use it in scripts, continuous integration, or whenever you do not need the interactive shell.

```bash
nod ask "explain what this repository does"
```

## Pass a prompt to `nod ask`

Pass the prompt as command arguments. In a shell script, `printf` can send generated prompt text to `nod ask` through standard input (`stdin`):

```bash
printf "summarize src/core\n" | nod ask
```

Use `--image <path>` to attach an image. Repeat the flag to attach multiple images.

```bash
nod ask --image ./ui.png "describe this interface"
```

See [Vision](https://nod.anturno.cloud/docs/capabilities/vision.md) for supported formats and image routing.

`--system <text>` replaces the built-in base prompt for this request only; tool, skill, project, and runtime context still apply.

## Use `nod ask` in scripts

For shell scripts and CI, redirect standard output (`stdout`) to receive raw assistant Markdown. Progress and diagnostics remain on standard error (`stderr`).

Use `--json` when a program needs structured fields instead of Markdown:

```bash
nod ask --json "summarize the current changes"
```

The command returns one JSON object:

```json
{
  "output": "Assistant Markdown",
  "final_output": "Final assistant response",
  "exit_code": 0,
  "model": "provider/model-id",
  "session_id": "session-id",
  "steps": 1,
  "usage": {
    "input_tokens": 1200,
    "output_tokens": 450
  },
  "tool_calls": [
    {
      "name": "read_file",
      "status": "success"
    }
  ]
}
```

Failures use a nonzero `exit_code` and can include an `error` field. Tool calls always include `name` and `status`; some tools include additional result fields.

`output` includes the assistant text produced during the request. `final_output` contains the completed final response, or an empty string when no final response completed.

`usage.input_tokens` and `usage.output_tokens` sum the counts reported by main-agent completions, including usage recorded before an error. A count is `null` when no completion reported it; reported zero remains `0`. These totals exclude subagent, helper-model, and provider-tool usage. Use [`nod usage`](https://nod.anturno.cloud/docs/using-nod/usage.md) for recorded local usage.

Parse stdout while keeping progress and diagnostics visible on stderr:

```bash
nod ask --json "inspect this repository" | jq -r .output
```

Add `--no-save` for a run that should not create a session. In JSON output, `session_id` is an empty string. `--no-save` cannot be combined with `--resume`.

## Continue a session with `nod ask`

Use `--resume last` to continue the latest session for the current workspace:

```bash
nod ask --resume last "now add tests"
```

You can pass a session ID instead of `last`, or `--resume-id <id>` to force an exact ID. See [Sessions](https://nod.anturno.cloud/docs/using-nod/sessions.md) to inspect sessions or recover an interrupted response.

## Handle permissions in noninteractive runs

By default, `nod ask` does not prompt for approval. Saved rules still apply. In `auto` mode, an action that raises a concern is held and returned to the agent with guidance; automatic review does not open a human approval prompt.

Use `--prompt-permissions` when running from a terminal if you want configured approval prompts. They appear on stderr, leaving JSON stdout parseable. Piped or redirected input remains noninteractive, and an action that needs human approval fails instead of waiting.

`--full-access` disables nod permission checks for the run. Use it only in an environment you trust. `--yolo` remains a backward-compatible alias.

An interrupted run exits with code `130`. See [Troubleshooting](https://nod.anturno.cloud/docs/using-nod/troubleshooting.md#nod-stops-before-running-a-tool) when a run ends before the tool executes.

Run `nod ask --help` for the complete flag reference.

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
