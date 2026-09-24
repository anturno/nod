---
title: "Data and privacy"
description: "Understand model requests, provider policies, and local data."
---

# Data and privacy

## Model request data

Each model request includes your prompt and the context assembled for that turn. Context can include conversation history, applicable `AGENTS.md` and skill instructions, attached images, and file or tool content already loaded into the session.

nod does not automatically package or upload your workspace, Git history, or session files. That data can still leave the machine when it is loaded into model context or sent by a networked tool. Web search, web fetch, remote MCP servers, and other networked tools send inputs to the services they call when invoked.

## Inference APIs

nod sends ChatGPT requests to OpenAI's Codex backend and Grok requests to xAI, under the terms and retention policies of those subscriptions. There is no intermediary service: nothing passes through a nod-operated server.

Both providers may record request metadata and content according to their own policies. Review the data controls of your ChatGPT or Grok account if your work is sensitive.

## Local credentials and sessions

nod stores private runtime state under `~/.nod/`, including settings, saved provider sessions, sessions, prompt history, usage records, MCP configuration and credentials, and managed skills. Provider sessions live in `~/.nod/codex-auth.json` and `~/.nod/grok-auth.json` with `0600` permissions, and nowhere else. Set `NOD_HOME` to move the whole directory.

Session files remain local, but nod sends the relevant conversation context again when you continue a session. Use [`nod ask --no-save`](https://nod.anturno.cloud/docs/using-nod/nod-ask.md#use-nod-ask-in-scripts) when a one-off request should not create a session.

## Product telemetry

nod does not send product telemetry or usage analytics to a separate nod service. `nod usage` reads local usage records.

## Update checks

Automatic updates are on by default. nod reads the release list from GitHub after startup and every 30 minutes until an update is ready. The request contains no nod-generated machine or installation identifier. Set `NOD_AUTO_UPGRADE=0` to turn automatic updates off.

## Sharing diagnostics

[`/feedback`](https://nod.anturno.cloud/docs/using-nod/feedback.md#report-a-problem) opens the bug report form without uploading diagnostic data. Anything you attach, such as `nod status --json` or a session export, is something you copied yourself.

Review and redact prompts, code, paths, commands, model output, and secrets before sharing them. See [Share feedback](https://nod.anturno.cloud/docs/using-nod/feedback.md) for details.

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
