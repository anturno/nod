---
title: "Models"
description: "Choose the model used by nod."
---

# Models

The catalog belongs to the active [provider](https://nod.anturno.cloud/docs/getting-started/authentication.md#model-providers). Codex and Grok each read their own catalog from the subscription, so the list changes with the provider and with the plan behind it. On Codex the default is `gpt-5.6-luna` when the plan lists it; otherwise, and on Grok, the default is the first model the subscription lists.

Before you sign in, the catalog is empty. `nod models` lists every provider, marks the ones that are signed out or unreachable, and says why.

## Browse and select

List models outside the shell:

```bash
nod models
```

```bash
nod models --json
```

Inside nod, `/model` alone opens the catalog; give it an ID or a search query to select directly:

```bash
/model
```

```bash
/model gpt-5.4
```

The selected model and reasoning effort are saved as user defaults in `~/.nod/settings.json`. The model is stored per provider, so switching providers and switching back restores what you had.

## Selection order

The first available source wins:

1. `NOD_MODEL` for the current process
2. the user default for the active provider in `~/.nod/settings.json`
3. the provider default

Project `.nod.json` files cannot set `model`, `effort`, or fast mode. This prevents a repository from silently changing your model preferences.

```bash
nod status
```

Use `nod status` or `/status` to confirm the effective model.

## Temporary overrides

Override one process without changing your saved default:

```bash
NOD_MODEL=gpt-5.4 nod
```

`NOD_PROVIDER=grok` does the same for the provider. ACP has an equivalent flag:

```bash
nod acp --model gpt-5.4
```

## Reasoning effort and fast mode

Effort is saved as a user preference and accepts `auto`, `none`, `minimal`, `low`, `medium`, `high`, `xhigh`, and `max`; `auto` lets the provider decide. `/fast` toggles fast mode where the selected model supports it. The setting is saved as a user preference.

> **Controls depend on the model**
>
> Reasoning effort and fast mode appear only when the selected model supports them.

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
