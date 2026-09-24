---
title: "Context limits"
description: "Configure byte limits for project instructions, skills, MCP metadata, and adapters."
---

# Context limits

Context limits bound external instructions and metadata before nod adds them to a model request. Values are byte counts, not token counts.

## Available limits

| Name | Default | Bounds |
| --- | ---: | --- |
| `skill_description_bytes` | 1 KiB | One discovered skill description |
| `skill_catalog_bytes` | Model-sized | Combined skill catalog |
| `skill_chunk_bytes` | Complete file; 20 KiB for legacy chunk reads | Skill content returned by one read |
| `skill_file_bytes` | 1 MiB | One skill file |
| `mcp_description_bytes` | 1 KiB | One MCP tool description |
| `mcp_search_result_bytes` | 16 KiB | MCP tool search results |
| `mcp_server_instructions_bytes` | 2 KiB | Instructions from one MCP server |
| `mcp_selected_schema_bytes` | 64 KiB | Schema for a selected MCP tool |
| `project_instruction_file_bytes` | 64 KiB | One project instruction file |
| `project_instructions_total_bytes` | 128 KiB | All applicable project instructions |
| `image_adapter_output_bytes` | 20 KiB | Text produced by the `vision` tool |

Without an explicit `skill_catalog_bytes` override, the catalog targets roughly 2% of the model's context window, or 16 KiB when the context size is unknown. An explicit byte limit takes precedence. `NOD_CONTEXT_WINDOW` sets the context window size nod assumes for the active model.

Skill loads normally return the complete file. Setting `skill_chunk_bytes` explicitly can reject a file that exceeds the limit; nod does not silently load part of the instructions.

## Settings

`context_limits` is supported in global and per-workspace entries in `~/.nod/settings.json`. It is not accepted in project `.nod.json`.

```json
{
  "context_limits": {
    "skill_catalog_bytes": 32768,
    "mcp_selected_schema_bytes": "off"
  },
  "workspaces": {
    "/absolute/path/to/project": {
      "context_limits": {
        "project_instructions_total_bytes": 262144
      }
    }
  }
}
```

A value is a non-negative integer or the string `"off"`. `"off"` disables the normal limit, but nod still applies a 64 MiB emergency ceiling.

## Command-line overrides

Use a leading, repeatable `--context-limit` flag:

```bash
nod --context-limit skill_catalog_bytes=32768
```

```bash
nod --context-limit mcp_description_bytes=off acp
```

Command-line values override workspace and global settings for the current process. `nod status` reports each limit with the layer it came from.

> **Larger limits increase request size**
>
> Raising or disabling a limit can increase latency and model input usage. Prefer the smallest value that preserves the instructions or schema you need.

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
