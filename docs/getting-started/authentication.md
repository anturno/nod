---
title: "Authentication"
description: "Choose which subscription nod uses to access AI models."
---

# Authentication

nod uses one provider at a time, and both providers are subscriptions you already have: a ChatGPT plan through the Codex backend, or a Grok plan. There are no API keys and nothing is billed per token.

> **Keep credentials out of project config**
>
> Use [`nod login`](#sign-in) for local credentials. nod has no API-key mode, so there is nothing to put in CI secrets or in `.nod.json`; a headless machine signs in once with `NOD_NO_OPEN_BROWSER=1` and reuses the saved session.

## Model providers

| Provider | Requires | Sign in |
| --- | --- | --- |
| Codex | A ChatGPT Plus, Pro, Business, Enterprise, or Edu subscription | `nod login codex` |
| Grok | A SuperGrok or X Premium subscription | `nod login grok` |

Switch providers with `nod provider`, or open `/provider` inside nod. `/login` opens the same provider picker:

```bash
nod provider codex
```

> **Switching to a provider signs you in**
>
> Selecting Codex or Grok starts browser sign-in if no saved session is available for that provider.

A credential authorizes only its own provider. A Codex session cannot serve Grok and a Grok session cannot serve Codex, so the provider you select decides which saved session nod looks for.

Each provider carries its own model catalog, and `/models` and `nod models` list the models of the active provider. The catalog depends on the plan behind the subscription.

## Sign in

Sign in with ChatGPT:

```bash
nod login codex
```

Sign in with Grok:

```bash
nod login grok
```

`nod login` opens the provider's authorization flow in your browser. The OAuth session is saved in `~/.nod/codex-auth.json` or `~/.nod/grok-auth.json`, readable only by your user, and refreshed when needed. Signing in also makes that provider active, so signing in and switching are the same step. Without a provider argument, `nod login` opens the provider picker.

In a headless environment, set `NOD_NO_OPEN_BROWSER=1` before `nod login` to print the authorization URL instead of trying to open it.

Sign-in uses the OAuth clients of OpenAI's Codex CLI and xAI's Grok CLI against their subscription backends. These are not public APIs and can change without notice. You are responsible for following each provider's terms.

## Provider selection

The active provider is resolved in this order:

1. `NOD_PROVIDER`, set for the current process
2. `provider` in `~/.nod/settings.json`, written by `nod login` and `nod provider`
3. `codex`

If the selected provider has no usable saved session, nod does not fall back to the other one. Sign in, or choose the other provider explicitly. Run `/status` to inspect the active provider and `model_source`.

## Inspect or remove credentials

Run `nod status` to inspect the active provider and model, permission mode, workspace, and update channel. It also reports `model_source` and `connected_providers`:

```bash
nod status
```

Sign out of a provider:

```bash
nod logout grok
```

`nod logout grok` removes the saved session and revokes its token with xAI. `nod logout codex` removes the session from this machine only. To withdraw nod's access to a ChatGPT account, remove it from the connected applications in that account. Without a provider argument, `nod logout` signs out of the active provider.

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
