---
title: "Additional workspaces"
description: "Give nod access to additional directories while keeping one primary workspace."
---

# Additional workspaces

Additional directories extend where file and command tools may operate. They do not replace the primary workspace or merge multiple projects into one configuration scope.

## Save directories for a workspace

Run these commands from the primary workspace:

```bash
nod workspace list
```

```bash
nod workspace add ../shared
```

```bash
nod workspace remove ../shared
```

```bash
nod workspace clear
```

Saved paths are normalized to absolute paths and stored under the matching primary workspace in `~/.nod/settings.json`. At most 16 unique additional directories can be active.

Inside the interactive shell, `/workspace list`, `/workspace add`, `/workspace remove`, and `/workspace clear` provide the same saved configuration.

## Process-only directories

Use a leading flag to add a directory without saving it:

```bash
nod --add-dir ../shared
```

Repeat `--add-dir` for more roots. To ignore every saved additional directory for one run:

```bash
nod --no-additional-dirs
```

These flags also work before commands such as `ask` and `acp`.

## What an additional directory contributes

It contributes tool access to that path, subject to the current permission rules.

It does not contribute:

- `.nod.json` configuration
- `AGENTS.md` project instructions
- skills or hooks
- Git identity or repository identity
- sessions, prompt history, or usage scope

The launch directory remains the primary workspace and the sole source for those concerns.

> **Access is not permission**
>
> Adding a directory makes it eligible for tools. It does not create an allow rule.

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
