---
title: "MCP protocol reference"
description: "Transports, protocol coverage, schema handling, and isolation for the nod MCP client."
---

# MCP protocol reference

This page describes what the nod MCP client implements. To add and operate servers, see [MCP](https://nod.anturno.cloud/docs/capabilities/mcp.md).

nod supports local stdio, Streamable HTTP, and legacy HTTP+SSE servers. Stdio and Streamable HTTP connections start with `2025-11-25` initialization and negotiate a supported version. The client is available to the interactive shell, `nod ask`, ACP sessions, and authorized subagents.

> **Core MCP client scope**
>
> nod supports the current core client protocol and the legacy compatibility paths listed below. It does not implement the MCP `2026-07-28` discovery lifecycle, resource subscriptions, MCP Tasks, MCP Apps, Skills over MCP, Client Credentials, or Enterprise-Managed Authorization extensions. nod does not install servers from a registry and does not expose itself as an MCP server.

## Protocol compatibility

| Transport | Default | Other supported versions |
| --- | --- | --- |
| stdio | `2025-11-25` initialization | Negotiated legacy versions |
| Streamable HTTP | `2025-11-25` initialization | `2025-06-18` and `2025-03-26` |
| HTTP+SSE | Deprecated `2024-11-05` | Legacy servers only |

Streamable HTTP responses may be fixed-length JSON or SSE streams; nod keeps the `Mcp-Session-Id` the server assigns, re-initializes after a `404`, and retries once after a `401` that an OAuth refresh can answer. Legacy connections use the initialization, sessions, notifications, and elicitation behavior of their negotiated version.

## Core protocol coverage

| Surface | nod behavior |
| --- | --- |
| Tools | Capability search, schema loading, namespaced identities, bounded requests and results, progress, cancellation, and permission checks before transport |
| Resources | Paginated resource and template catalogs, explicit URI reads, template completion, multiple text or blob contents, resource links, annotations, metadata, icons, and bounded caches |
| Prompts | Paginated discovery, exact server-qualified invocation, typed arguments, multiple messages and content types, annotations, metadata, icons, and argument completion |
| Completion | Bounded resource-template and prompt-argument candidates with cancellation and deadlines |
| Change delivery | List-change notifications and reconnect recovery |
| Elicitation | Form and URL requests with accept, decline, and cancel results |

## Elicitation by surface

Interactive and `nod ask` surfaces can collect supported form input and ask for consent before opening an HTTPS or loopback URL. nod does not fetch elicitation URLs or their metadata. Noninteractive `nod ask` returns a typed input-required result instead of waiting for input it cannot collect. ACP advertises only the form or URL modes supported by that client session.

## Tool schemas

nod checks that input schemas describe an object and accepts JSON Schema 2020-12 or Draft 7 declarations. It bounds schema size and structure before advertising a tool to the model.

Tool arguments must be a bounded JSON object. The server owns validation against its input and output schemas; nod does not enforce those semantic assertions locally. nod validates response envelopes and content, and preserves tool errors as failures.

## Discovery and isolation

`capability_search` finds installed skills and configured MCP tools and loads matching schemas within the schema budget. `mcp_select_tool` remains available for explicit selection. Tool names are namespaced as `mcp_<server>_<tool>` to avoid collisions with built-ins. Server instructions, descriptions, search results, and selected schemas are bounded by [context limits](https://nod.anturno.cloud/docs/configure/context-limits.md).

Native interactive and `nod ask` sessions combine profile and approved project servers; a profile entry wins a same-name project entry. ACP sessions combine client-supplied `mcpServers` with approved project servers; the client entry wins a same-name project entry, and profile servers are not inherited. Pending and rejected project entries stay disconnected.

One-off and persistent [subagents](https://nod.anturno.cloud/docs/capabilities/subagents.md) receive an immutable, permission-filtered view of their active parent or ACP session's MCP servers, tools, resources, prompts, and completion capability. No admitted view means MCP is disabled; reload, removal, authentication changes, parent or session closure, and cancellation fail closed before transport.

## Trust and security

MCP server instructions, descriptions, prompts, resources, schemas, and tool results are external input. nod bounds them before ownership or model projection and marks returned content as `untrusted_external` with no authority. Resource content remains outside model context until an explicit read, and resource or prompt text cannot grant permissions or override the user's instructions.

Dynamic MCP tool calls use the same nod [permission](https://nod.anturno.cloud/docs/configure/permissions.md) policy as built-in tools. Authorization checks run again immediately before transport, so reload, logout, server removal, session replacement, parent closure, and permission changes cannot reuse stale authority. Health output omits credentials, configured secrets, raw responses, and server URLs.

Each JSON-RPC frame, in either direction, is limited to 8 MiB. A stdio server that ignores shutdown receives `SIGTERM`, then `SIGKILL`.

## Conformance

The repository's [test suites](https://github.com/anturno/nod/tree/main/test) cover MCP configuration, JSON-RPC framing, stdio, Streamable HTTP, HTTP+SSE, OAuth, ACP, and subagent integration with in-process servers.

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
