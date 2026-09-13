---
title: "MCP"
description: "Configure profile and project MCP servers, authentication, and trust."
---

# MCP

nod is an MCP client. Servers you configure are available to the interactive shell, `nod ask`, ACP sessions, and authorized subagents.

For transports, protocol revisions, schema handling, and isolation guarantees, see the [MCP protocol reference](https://nod.anturno.cloud/docs/capabilities/mcp/protocol.md).

## Add a remote server

`/mcp add --transport http` adds or replaces a remote Streamable HTTP server, saves it to `~/.nod/mcp.json`, and reloads MCP:

```bash
/mcp add --transport http prisma https://mcp.prisma.io/mcp
```

To configure headers, authentication, required startup, or other options, edit the saved entry in `mcp.json`. Use `"type": "http"` for Streamable HTTP. Use `"type": "sse"` only for a deprecated `2024-11-05` HTTP+SSE server. Both require a `url`.

```json
{
  "mcp": {
    "remote": {
      "type": "http",
      "url": "https://mcp.example.com/mcp"
    }
  }
}
```

After editing an entry by hand, apply the change without restarting nod:

```bash
/mcp reload
```

## Add a local stdio server

`/mcp add` adds or replaces a local stdio server:

```bash
/mcp add local-tools npx -y @modelcontextprotocol/server-everything
```

To configure one by hand, use `"type": "local"` or `"type": "stdio"`. The canonical command form is an array whose first item is the executable:

```json
{
  "mcp": {
    "filesystem": {
      "type": "stdio",
      "command": ["node", "/absolute/path/to/server.js", "--read-only"],
      "environment": {
        "LOG_LEVEL": "warn"
      }
    }
  }
}
```

This compatibility form is also accepted:

```json
{
  "mcp": {
    "filesystem": {
      "command": "node",
      "args": ["/absolute/path/to/server.js", "--read-only"],
      "env": {
        "LOG_LEVEL": "warn"
      }
    }
  }
}
```

`environment` is canonical; `env` is an alias. Every value must be a string. Local servers inherit the nod process environment, then configured values override matching inherited variables. They communicate with nod using newline-delimited JSON-RPC over stdin and stdout.

For an exact `docker run` stdio command without `--cidfile`, nod injects a private container ID file and removes the owned container after shutdown or startup failure. If you supply `--cidfile`, cleanup remains your responsibility.

## Authenticate a remote server

Choose the narrowest mechanism the server accepts:

| Need | Field | Notes |
| --- | --- | --- |
| Non-secret static header | `headers` | Plain values stored in the profile. |
| Secret header value | `header_env` | Maps a header name to an environment variable. |
| Bearer token | `bearer_token_env` | Reads the token from an environment variable. |
| Delegated user authorization | `oauth` | Authorization-code flow with PKCE, run from an interactive session. |

A literal `Authorization` header is rejected so credentials do not become ordinary profile data.

```json
{
  "mcp": {
    "protected": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "header_env": {
        "X-Workspace": "MCP_WORKSPACE"
      },
      "oauth": {
        "client_metadata_url": "https://example.com/nod-client.json",
        "scopes": ["tools.read", "tools.call"]
      }
    }
  }
}
```

Start or clear an OAuth session from the shell:

```bash
/mcp auth <name> --open
```

```bash
/mcp logout <name>
```

In an interactive session, nod discovers protected-resource and authorization-server metadata, validates the issuer, refreshes tokens, and answers scope challenges. It uses a Client ID Metadata Document when one is configured and advertised, and falls back to Dynamic Client Registration. Every `oauth` field is optional: `resource`, `issuer`, `client_id`, `client_secret_env`, `client_metadata_url`, and `scopes`.

Malformed credential entries are isolated so valid servers still work, then removed on the next successful authentication or logout. Callback issuer mismatches fail authentication instead of suggesting an unsafe override.

OAuth credentials are stored in a private `0600` file under `~/.nod/`. ACP is noninteractive, so an ACP host must supply headers for a protected MCP server.

## Manage servers

Run `/mcp` to browse server health, tools, resources, templates, and prompts. You can inspect schemas and preview resource or prompt content. Content enters the composer only after you choose **Insert**. The browser also supports add, remove, reload, authentication, logout, and project trust.

Direct slash commands remain available:

```text
/mcp list
/mcp resource list <server>
/mcp resource templates <server>
/mcp resource read <server> <uri>
/mcp resource complete <server> <uri-template> <variable> [value]
/mcp prompt list <server>
/mcp prompt get <server> <name> [arguments-json]
/mcp prompt complete <server> <name> <argument> [value]
/mcp add <name> <command> [args...]
/mcp add --transport http <name> <url>
/mcp remove <name>
/mcp reload
/mcp auth <name> --open
/mcp logout <name>
/mcp trust approve <name>
/mcp trust reject <name>
/mcp trust approve-all
/mcp trust reset
/mcp path
```

```bash
/mcp list
```

While discovery is running, the status view reports it as in progress. Afterward it shows a health snapshot for each server, never including commands, environment values, headers, credentials, raw responses, or server URLs.

`/mcp reload` builds and connects the new configuration before it replaces the running one. If the file is invalid or a required server fails, nod keeps the servers you already had. If an optional server fails, the reload still goes through without it. A valid but empty profile removes every server.

Every operation is also available outside the shell as a top-level `nod mcp` command; see [MCP management](https://nod.anturno.cloud/docs/using-nod/cli.md#mcp-management) in the CLI reference. `nod status` and `nod doctor` report profile warnings and project configuration issues without starting MCP transports or opening credential storage; their JSON output marks the connection check as `not_checked`.

## Servers with setup guides

Any server that documents a generic MCP client works with nod: use its stdio command with `/mcp add`, or its Streamable HTTP URL with `/mcp add --transport http`, and follow its authentication instructions with the `headers`, `header_env`, `bearer_token_env`, or `oauth` fields above. Guides written for other MCP clients apply unchanged; only the config file location differs.

## Profile configuration

Your private MCP profile lives at `~/.nod/mcp.json`. `/mcp path` prints the exact profile path:

```bash
/mcp path
```

The canonical root object contains one `mcp` map. `mcpServers` is accepted as a compatibility alias, but `mcp` wins when both exist and nod always writes `mcp`. Similar unsupported keys such as `MCP-Servers` produce a warning and block profile mutations so nod cannot overwrite an ambiguous file.

Names passed to MCP commands must contain only letters, numbers, `_`, or `-`. Use the same form for names you add by hand, so generated tool names stay predictable.

```json
{
  "mcp": {
    "local-tools": {
      "type": "local",
      "command": ["npx", "-y", "@modelcontextprotocol/server-everything"],
      "enabled": true,
      "required": false,
      "environment": {
        "TOKEN": "value"
      }
    },
    "remote-tools": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "enabled": true
    }
  }
}
```

Common server fields apply to both local and remote profile entries:

| Field | Default | Behavior |
| --- | --- | --- |
| `enabled` | `true` | Set to `false` to keep an entry without loading it. |
| `required` | `false` | Wait for the server before the first model request. In `nod ask`, optional servers may start only when a turn needs MCP. |
| `startup_timeout_ms` | `30000` | Maximum cold-start and discovery time. |
| `operation_timeout_ms` | `60000` | Maximum time for an MCP operation. |
| `restart_limit` | `1` | Maximum automatic restarts for a local stdio server. |

All timeout values are positive integers. `restart_limit` applies only to stdio servers.

## Project configuration and trust

A workspace can provide Claude-compatible MCP configuration at `<workspace>/.mcp.json`. nod opens it as a bounded no-follow regular file and reads only the top-level `mcpServers` object:

```json
{
  "mcpServers": {
    "project-local": {
      "command": "npx",
      "args": ["-y", "@example/project-server", "${PROJECT_ROOT:-.}"],
      "env": {
        "PROJECT_TOKEN": "${PROJECT_TOKEN}"
      }
    },
    "project-remote": {
      "type": "http",
      "url": "https://mcp.example.com/mcp",
      "headers": {
        "X-Workspace": "${WORKSPACE_ID}"
      }
    }
  }
}
```

Project servers begin as pending and stay disconnected on every surface. Interactive nod presents a trust prompt after startup. Approve or reject individual entries, approve the complete file, or clear the workspace choices:

```text
/mcp trust approve <name>
/mcp trust reject <name>
/mcp trust approve-all
/mcp trust reset
```

The same actions are available as `nod mcp trust ...` commands. Trust is saved in your private `~/.nod/settings.json` under the canonical workspace path, never in `.mcp.json`. Before approval, nod does not start a project process, contact a project endpoint, read an environment value, or load stored MCP credentials. `nod ask` reports skipped pending servers on stderr, and ACP leaves them unavailable.

After approval, `${VAR}` and `${VAR:-default}` expand in project commands, arguments, environment values, and HTTP headers. Missing required variables skip only the affected server and appear as configuration issues without exposing values. The file is limited to 1 MiB, and expanded values use a separate 1 MiB aggregate budget. Project servers are always optional even if they contain `"required": true`.

Template expansion is project-only. Profile strings remain literal; use `environment`, `header_env`, or `bearer_token_env` when a profile entry needs process environment values.

In native interactive and `nod ask` sessions, a profile entry wins a same-name project entry. ACP request entries win same-name project entries and do not inherit profile servers.

## How tools reach the model

Tools are discovered when needed. `capability_search` searches installed skills and configured MCP tools using a `query`, optionally restricted to one exact `server` alias. Matching tool schemas load automatically within the schema budget. The agent can also use `mcp_select_tool` to select a tool explicitly.

Selected tools are namespaced as `mcp_<server>_<tool>` and sanitized to avoid collisions with built-ins. Server instructions, descriptions, search results, and selected schemas are bounded by [context limits](https://nod.anturno.cloud/docs/configure/context-limits.md).

Dynamic MCP tool calls use the same [permission](https://nod.anturno.cloud/docs/configure/permissions.md) policy as built-in tools, re-checked immediately before transport.

> **Treat server config as sensitive**
>
> MCP environment values can contain credentials, and server tools execute with the authority their process or endpoint provides. Keep `~/.nod/mcp.json` private, review project `.mcp.json` before approving it, never commit literal secrets, and use narrowly scoped tokens.

Server output is untrusted input, not instructions. See [Trust and security](https://nod.anturno.cloud/docs/capabilities/mcp/protocol.md#trust-and-security) for what nod enforces, and [Troubleshooting](https://nod.anturno.cloud/docs/using-nod/troubleshooting.md#an-mcp-server-is-missing) when a configured server does not appear.

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
