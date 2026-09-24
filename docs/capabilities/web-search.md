---
title: "Web search"
description: "Research current public information with source links."
---

# Web search

nod can search current public information and cite its sources. The selected model decides when to use `web_search`.

Ask explicitly when you need current information or citations:

```bash
nod ask "Search the web for the latest stable Bun release. Use official sources and cite them."
```

In the interactive shell, write the same request as a normal prompt.

## How it works

On Codex, nod uses the ChatGPT backend's native web search, and the search runs inside the model request. On Grok, `web_search` is a regular tool backed by DuckDuckGo: nod fetches the results page, extracts titles, links, and snippets, and returns them to the model. In both cases the model answers with source links; search results cannot override your instructions or permissions.

## Choose sources

Include the relevant country, language, date range, or preferred sources in your prompt:

> Search the web for the latest stable Bun release. Prefer bun.sh and cite the relevant pages.

Search requests support allowed and blocked domains. Name the domains in your prompt when you want to narrow the search. For an exact public URL, provide it and ask nod to use `web_fetch`.

## `web_search` and `web_fetch`

| Tool | Use it to |
| --- | --- |
| `web_search` | Find current information across the public web. |
| `web_fetch` | Read one known public URL. |

Neither tool signs in, clicks controls, or accesses private pages.

## Permissions

`web_search` is read-only. An `allow` rule enables it, while `ask` or `deny` hides it from the model. See [Permissions](https://nod.anturno.cloud/docs/configure/permissions.md) to configure rules.

## Data and privacy

Web search sends the query to OpenAI on Codex or to DuckDuckGo on Grok, and saves the activity in the local session. See [Data and privacy](https://nod.anturno.cloud/docs/using-nod/data-and-privacy.md) and [`nod usage`](https://nod.anturno.cloud/docs/using-nod/usage.md) for privacy and usage details.

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
