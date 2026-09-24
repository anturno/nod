---
title: "Vision"
description: "Understand how nod sends images to the model and when the vision tool runs."
---

# Vision

Vision lets nod inspect screenshots, diagrams, and other visual context during a task.

## How vision works

Every image goes to the session model; nod has no separate image helper.

### Native vision

Images you attach with `/image`, `--image`, or an ACP image block are included in the same request for the model to read directly. Both Codex and Grok models accept images this way.

### The `vision` tool

The model can also call the built-in `vision` tool when it wants to look at an image on its own initiative: one of the attached images by ID, or a file path in the workspace. The tool sends those images with a `focus` question to the session model in a separate request and returns the description as text, bounded by `image_adapter_output_bytes`. This keeps large images out of the main conversation until they are needed.

It is a separate model request with its own token usage; see [Additional model requests](https://nod.anturno.cloud/docs/using-nod/usage.md#additional-model-requests).

## Add visual context

### Interactive shell

Attach a file:

```bash
/image ./diagram.png
```

`/img` is an alias. You can also type an image path directly in a prompt.

Use `/images` to inspect pending attachments or `/images clear` to remove them.

On macOS, attach an image from the clipboard:

```bash
/paste
```

### Headless requests

Attach an image to a one-off request:

```bash
nod ask --image ./ui.png "describe this interface"
```

Repeat `--image` to attach more than one file.

## Supported inputs

nod accepts PNG, JPEG, GIF, and WebP images up to 10 MiB each.

## Permissions and trust

The `vision` tool follows the active [permission mode](https://nod.anturno.cloud/docs/configure/permissions.md). It reads only images attached to the session or image paths within the workspace scope. Instructions found inside images are treated as untrusted content.

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
