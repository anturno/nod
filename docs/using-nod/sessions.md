---
title: "Sessions"
description: "Save, resume, recover, compact, and inspect nod sessions."
---

# Sessions

nod saves interactive conversations under `~/.nod/sessions/`. Starting plain `nod` creates a fresh session. Use `nod sessions` to find the ID of a saved conversation.

## List and inspect

List sessions for the current workspace:

```bash
nod sessions
```

The default list is scoped to the current workspace. Use `--all` for every workspace, `--limit <1-100>` to change the page size, and `--cursor <cursor>` for the next page.

Inspect the latest workspace session as JSON. The response includes its session ID, timestamps, and saved conversation history:

```bash
nod session last --json
```

```bash
nod session --id <session-id> --json
```

`--id` forces the value to be read as an exact session ID instead of the `last` keyword or a subcommand such as `migrate` or `recover`. Every `nod session` form accepts it.

## Resume

Open the interactive session picker:

```bash
nod -r
```

Resume the latest workspace session directly:

```bash
nod resume last
```

Copy an ID from `nod sessions` to resume a specific session:

```bash
nod resume <session-id>
```

An explicit ID can be rebound to the current workspace. `last` remains workspace-scoped. `-c`, `--continue`, and `--resume-last` are equivalent leading flags for the latest workspace session, and `nod session resume [last|<id>]` is the same command spelled as a subcommand.

`nod ask` can continue the same conversation without opening the shell:

```bash
nod ask --resume last "continue with the tests"
```

## Recover interrupted work

nod persists partial model responses, tool progress, and recovery checkpoints. In an interactive session, `/continue` resumes a paused response.

For a headless run:

```bash
nod ask --resume last --continue-recovery
```

To create a separate recoverable copy while leaving the source session unchanged, copy the ID from `nod sessions`:

```bash
nod session recover <session-id>
```

`nod doctor` inspects saved sessions and prints the exact recovery command when it finds a problem it can fix. See [Troubleshooting](https://nod.anturno.cloud/docs/using-nod/troubleshooting.md#a-session-will-not-open-or-resume).

## Migrate an older session

```bash
nod session migrate <session-id>
```

Migration rewrites a saved session into the current format. Add `--allow-large` only after verifying an oversized legacy snapshot. A session already in the current format is reported as up to date and left unchanged.

## Compact long sessions

When a model request reaches 80% of its usable input capacity, nod summarizes older context and continues the same turn in a fresh context window. It keeps recent tool exchanges intact and preserves the full saved transcript.

Run `/compact` to summarize the context now and wait for your next prompt:

```bash
/compact
```

The summary remains available after you resume the session. If compaction is cancelled or fails, nod keeps the previous context.

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
