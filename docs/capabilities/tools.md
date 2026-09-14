---
title: "Tools"
description: "Built-in tools available to the nod agent."
---

# Tools

Tools let the model act on the current workspace and connected services. The active runtime, permission policy, selected model, and available integrations determine which tools can execute.

## Built-in tools

| Area | Tools |
| --- | --- |
| Find and read files | `glob_files`, `grep_files`, `read_file` |
| Write and edit files | `write_file`, `edit_file` |
| Commands | `shell` |
| Web | [`web_search`](https://nod.anturno.cloud/docs/capabilities/web-search.md), `web_fetch` |
| Images | `vision` |
| Skills | `skill`, `install_skill` |
| Subagents | `subagent` |
| MCP | `capability_search`, `mcp_select_tool`, `mcp_features`, plus selected server tools |
| Interaction and runtime | `ask_user_question`, `read_tool_result` |

Use `glob_files` to find paths and `grep_files` to find literal text. `capability_search` finds installed skills and configured MCP tools. Matching MCP schemas load automatically within the schema budget; `mcp_select_tool` can select one explicitly.

nod does not currently include interactive browser or CDP tools.

See [Web search](https://nod.anturno.cloud/docs/capabilities/web-search.md) for search selection, source scoping, citations, permissions, privacy, and the difference between `web_search` and `web_fetch`.

## Background commands

The `shell` tool runs commands, including development servers and file watchers. When a command is still running, nod keeps its execution handle so the agent can check output, send input, or stop it without starting it again.

The tool has three actions: `run` starts a command, `interact` checks output or sends input, and `stop` ends it. Ask nod to start a service, check its progress, or stop it in the conversation. `/clear` keeps running commands for the workspace; `/reset` stops and forgets them.

Background commands are operating system processes. [Subagents](https://nod.anturno.cloud/docs/capabilities/subagents.md) are separate nod sessions for delegated reasoning and tool work.

## Large tool results

Large results are kept out of the immediate model response so one command or search does not consume the entire context window.

| Stage | What nod provides |
| --- | --- |
| Initial result | A bounded preview, the retained byte count, and a session-scoped handle. |
| Follow-up inspection | `read_tool_result` can read a byte range or search the retained result for a literal query. |
| Saved session | The redacted result remains outside `session.json`; its handle stays attached to the tool step. |

The model calls `read_tool_result` when it needs evidence beyond the preview. Handles must be copied exactly and work only with their session's tool-result store. The `max_tool_result_bytes` [configuration field](https://nod.anturno.cloud/docs/configure/configuration.md#project-configuration) controls how many bytes nod retains from one tool result.

## Vision

The `vision` tool inspects images on behalf of the model in a separate request. See [Vision](https://nod.anturno.cloud/docs/capabilities/vision.md) for how images are routed.

## Scope and permissions

File and command tools start from the primary workspace. Active [additional directories](https://nod.anturno.cloud/docs/configure/additional-workspaces.md) extend that scope, but they do not bypass permission rules.

ACP `ask` and `code` modes can use the full runtime set. Tool availability can still vary by entrypoint, model capability, platform, and integration state.

> **Tool calls are policy checked**
>
> A model choosing a tool does not guarantee execution. nod evaluates effective permission rules, session grants, mode, and workspace access first.

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
