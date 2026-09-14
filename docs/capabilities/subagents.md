---
title: "Subagents"
description: "Create and manage session-backed child agents."
---

# Subagents

A subagent handles a task in its own conversation and returns the result to the parent agent. Ask nod to delegate work in your prompt:

```text
Have a subagent review the parser tests and report missing cases. Do not edit files.
```

Subagents share the workspace, so give concurrent tasks separate files or areas to avoid conflicting edits.

## Run modes

- A **one-off** child runs one task and finishes.
- A **named** child keeps its conversation so you can send follow-up work.

The child inherits the parent's model and reasoning effort unless the call names a `model` or `effort` of the same provider. nod manages its execution, cancellation, and saved state.

## Agent tool

The model uses the `subagent` tool with two actions:

| Action | Purpose |
| --- | --- |
| `run` | Run one task in a temporary child. |
| `message` | Create or continue a named child conversation. |

Run a one-off task:

```json
{
  "request": {
    "action": "run",
    "task": "Review the parser tests and report missing cases. Do not edit files."
  }
}
```

Create a named child, or continue it with another message:

```json
{
  "request": {
    "action": "message",
    "agent": "reviewer",
    "message": "Check the new parser tests against your earlier findings."
  }
}
```

Names identify conversations within the parent session and must start with a lowercase letter, followed by up to 63 lowercase letters, digits, `_`, or `-`. The optional `instructions` field on `message` replaces that child's additional instructions; omitting it keeps the previous instructions.

> **Permissions carry over**
>
> Subagents inherit the parent's permission restrictions. Delegation cannot grant a child broader access.

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
