---
title: "ACP server"
description: "Run nod from editors and clients that support Agent Client Protocol."
---

# ACP server

Run nod as an Agent Client Protocol (ACP) server to use the nod agent from compatible editors and clients.

## Configure an ACP client

Start the server from the project that should be the primary workspace:

```bash
cd /absolute/path/to/project && nod acp
```

Configure the client to launch the absolute binary path when possible:

```json
{
  "command": "/absolute/path/to/nod",
  "args": ["acp"]
}
```

The client process working directory becomes the primary workspace. Launch a separate server process for each primary workspace.

`nod acp` accepts two options:

| Option | Behavior |
| --- | --- |
| `--model <id>` | Override the model for the server process, including loaded sessions. |
| `--log-file <path>` | Write ACP diagnostics to an absolute file path. |

Global workspace flags such as `--add-dir`, `--no-additional-dirs`, and `--context-limit` must appear before `acp`.

## Authentication and nod settings

ACP uses the selected nod provider and saved credentials. Complete [Authentication](https://nod.anturno.cloud/docs/getting-started/authentication.md) before the client starts the server.

The server uses the same settings, project instructions, skills, sessions, permissions, and tools as interactive nod.

## Supported ACP methods

The client must call `initialize` first. nod responds with ACP protocol version `1` and supports these methods:

| Method | Behavior |
| --- | --- |
| `initialize` | Negotiate protocol capabilities and initialize the connection. |
| `session/new` | Create and activate a saved session. |
| `session/load` | Load an exact session ID and replay its history. |
| `session/resume` | Reconnect to a saved session without replaying its history. |
| `session/close` | Close the active session. |
| `session/list` | List sessions for the primary workspace. |
| `session/prompt` | Run one turn in the active session. |
| `session/cancel` | Cancel the active prompt. |
| `session/set_config_option` | Change the active model or mode. |
| `session/set_mode` | Change the active mode. |

Each connection has one active session and one active prompt. A second `session/prompt` while one is running is rejected.

## Sessions, models, and permissions

New and loaded sessions expose model and mode selectors. Model changes are saved to the active session, while a process-level `--model` override takes precedence over the model stored in a loaded session.

| Mode | Permission behavior |
| --- | --- |
| `ask` | Request approval for unresolved sensitive tool calls. |
| `code` | Automatically review unresolved sensitive tool calls. |

Both modes expose the available runtime tools. Before the client selects a mode, nod uses the permission mode from the active configuration.

An **Allow for this session** approval remains active only for the current session. It is not written to settings or restored when the session is loaded again.

## Prompt and MCP support

`session/prompt` accepts text, embedded resources, and inline image blocks. Images are sent to the session model; see [Vision](https://nod.anturno.cloud/docs/capabilities/vision.md). Audio blocks are not supported.

Clients receive streamed user and agent messages, tool status updates, and permission requests. Tool calls arrive as a `tool_call` followed by `tool_call_update` messages, and shell commands include a `command_result`.

ACP sessions combine client-supplied `mcpServers` with approved servers from the workspace `.mcp.json`. A client entry wins a same-name project entry. Pending or rejected project servers remain unavailable, and ACP never inherits servers from `~/.nod/mcp.json`. Clients can provide stdio, HTTP, or SSE servers.

## Protocol limits

ACP uses newline-delimited JSON-RPC 2.0 over stdin and stdout. Each input message is limited to 8 MiB.

> **Protect the protocol stream**
>
> Stdout is reserved for ACP messages. Write diagnostics to `--log-file` instead.

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
