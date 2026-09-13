---
title: "Usage"
description: "Inspect the token usage nod records on this machine."
---

# Usage

## Inspect local usage

Inspect usage recorded by nod on this machine:

```bash
nod usage
```

Choose a period or return structured output:

```bash
nod usage --period 24h --json
```

Valid periods are `24h`, `7d`, and `30d`. Reports include requests, tokens, and usage by model. They also indicate when tracking covers only part of the selected period or totals may be incomplete.

Inside the shell, `/usage` opens the dashboard. `/cost` is an alias.

> **Usage is local, and there is no spend**
>
> `nod usage` only includes requests recorded by nod on this machine. ChatGPT and Grok subscription requests go directly to their providers and are covered by those subscriptions, so nod records no per-token cost. Every cost field in the report and in `--json` output is always `0`.

## Additional model requests

Permission review and vision can make requests in addition to the main conversation:

| Feature | Helper model | When it runs |
| --- | --- | --- |
| [Automatic permission review](https://nod.anturno.cloud/docs/configure/permissions.md#automatic-review-configuration) | `gpt-5.4-mini` on Codex, the session model on Grok | An unresolved sensitive tool call in `auto` mode. |
| [Vision](https://nod.anturno.cloud/docs/capabilities/vision.md#the-vision-tool) | The session model | The `vision` tool inspects an image in a separate request. |

These requests count toward your subscription's rate limits through whichever [provider](https://nod.anturno.cloud/docs/getting-started/authentication.md#model-providers) is active, and appear in `nod usage` under the model that served them. Set `NOD_REVIEWER_MODEL` to run the review on a different model of the active provider; changing the selected model changes only the Grok reviewer, which runs on the session model.

[Web search](https://nod.anturno.cloud/docs/capabilities/web-search.md) uses the provider's native search on Codex and a DuckDuckGo fallback on Grok. Neither adds a model request of its own.

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
