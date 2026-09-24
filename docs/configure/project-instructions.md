---
title: "Project instructions"
description: "Control nod with global, workspace, and target-scoped AGENTS.md files."
---

# Project instructions

nod loads `AGENTS.md` files as project guidance. Instructions can describe repository layout, commands, conventions, safety requirements, and verification expectations.

## Instruction sources

nod can gather:

- global instructions from `~/.nod/AGENTS.md`
- launch-ancestor and primary-workspace `AGENTS.md` files
- more specific `AGENTS.md` files for files or directories targeted by a tool call

The narrowest applicable project scope wins when instructions conflict. A direct user request still has higher priority than project instructions.

## What reaches the model

nod assembles each request from bounded, relevant context:

```text
nod behavior and the current request
                 ↓
recent turns or compacted conversation history
                 ↓
applicable AGENTS.md, skill context, and MCP metadata
                 ↓
tools available for this request
                 ↓
selected model
```

The skill catalog is visible in bounded form, while full skill instructions are loaded only when a skill applies. MCP instructions, tool descriptions, project instructions, and image-adapter output have separate [context limits](https://nod.anturno.cloud/docs/configure/context-limits.md).

When a tool later targets a more specific path, nod can add the narrower `AGENTS.md` instructions for that operation. Tool results and fetched content are treated as evidence, not as higher-priority instructions. nod does not expose the exact internal system prompt as a user setting; `nod ask --system` replaces only the base prompt for one request.

## Target-scoped instructions

Applicable instructions are not fixed only at startup. When a tool targets a path, nod resolves the instruction chain for that target. This allows a nested package to define rules that apply only inside its directory.

For example:

```text
project/
├── AGENTS.md
├── apps/
│   └── web/
│       ├── AGENTS.md
│       └── src/
└── packages/
```

A tool call under `apps/web/src/` receives both project files, with `apps/web/AGENTS.md` providing the narrower scope. A call under `packages/` receives only the root project instructions.

Embedded ACP resources with safe absolute local `file://` targets also participate in target-scoped instruction selection.

## Boundaries

Additional workspace directories provide tool access but do not contribute `AGENTS.md` files. The primary workspace is the only project-instruction source.

Set `context` to `false` in `.nod.json` or user settings to disable project context. Use [context limits](https://nod.anturno.cloud/docs/configure/context-limits.md) to bound each instruction file and the combined instruction set. Truncated or omitted context is reported to the runtime rather than silently treated as complete.

> **Keep instructions repository-safe**
>
> Project `AGENTS.md` files may enter model context. Do not place credentials, private tokens, or unrelated sensitive data in them.

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
