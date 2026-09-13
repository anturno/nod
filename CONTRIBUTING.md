# Contributing to nod

Thanks for helping. Bug reports, new eval tasks, and fixes that keep nod small are all welcome.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on the approach. nod stays deliberately minimal: no agent framework, no model SDK, one tool to act.
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Setup

Development uses [Bun](https://bun.sh) 1.4 or newer. nod runs directly from TypeScript source on Bun, so there is no build step.

```bash
git clone https://github.com/anturno/nod.git
cd nod
bun install
bun run dev          # run nod from source
```

## Project layout

| Path | What lives there |
|------|------------------|
| `src/agent.ts` | Contracts (`Message`, `LLM`, `Environment`), system prompt, and the loop |
| `src/responses.ts` | `LLM` over a Responses API stream, used by the subscription backends |
| `src/codex.ts`, `src/grok.ts` | ChatGPT (Codex backend) and Grok (CLI proxy) models and headers |
| `src/auth/` | OAuth with PKCE and a localhost callback, token storage and refresh |
| `src/providers.ts` | Login, logout, models and `LLM` for each subscription |
| `src/environment.ts` | Runs bash locally, and the approval wrapper |
| `src/render.ts` | How commands and output read in a terminal |
| `src/tui/` | The interactive shell ([Ink](https://github.com/vadimdemedes/ink)) |
| `src/cli.ts` | Wiring |
| `evals/` | Eval tasks and runner |
| `test/` | `bun:test` suites |
| `site/` | The website, deployed to GitHub Pages |

## Making changes

1. Branch from `main`.
2. Keep changes focused. One concern per pull request.
3. Add or update tests for behavior changes.
4. Run the full check before pushing:

   ```bash
   bun run typecheck && bun run check && bun test
   ```

   `bun run fix` applies Biome's lint and format fixes.

## Evals

Each task in `evals/tasks.ts` is a throwaway repository with a prompt and a check. For each task, `bun run eval` reports how often the check passed, plus the median turns, commands, failed commands, seconds, and final context size. Evals use your own subscription, so they are not run in CI.

```bash
bun run eval                                  # every task once, on your default model
bun run eval -- --repeat 3 fix-bug feature    # some tasks, three runs each
bun run eval -- --provider grok --model <id> --concurrency 2
```

Every task needs a reference solution. `bun test` checks that each check fails on the untouched fixture and passes with the reference, so a task can't pass without real work.

If your change affects agent behavior (system prompt, loop, tool output), include eval results from before and after in the pull request.

## Pull requests

- Describe what changed, why, and how you tested it.
- Add an entry under `Unreleased` in [CHANGELOG.md](CHANGELOG.md) for user-facing changes.
- CI must pass.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE) and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
