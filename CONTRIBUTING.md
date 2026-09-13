# Contributing to nod

Thanks for helping. Bug reports, new eval tasks, and fixes that keep nod small are all welcome.

## Before you start

- For anything larger than a small fix, open an issue first so we can agree on the approach. nod mirrors the architecture of [fx](https://github.com/vercel-labs/fx) in TypeScript; it stays permission-first, CLI-first, and free of agent frameworks and model SDKs (runtime dependencies are `ink` and `react` only).
- Security problems go through [SECURITY.md](SECURITY.md), not public issues.

## Setup

Development uses [Bun](https://bun.sh) 1.4 or newer. nod runs directly from TypeScript source, so there is no build step during development.

```bash
git clone https://github.com/anturno/nod.git
cd nod
bun install
bun run dev          # run nod from source (bun run src/cli/main.ts)
```

Sign in with `bun run dev login codex` or `bun run dev login grok` for model-backed flows. Tests never touch the network: they use a temporary `NOD_HOME`, fake `fetch`, and in-process servers.

## Project layout

| Path | What lives there |
|------|------------------|
| `src/cli/` | Top-level commands (`main.ts` dispatch, `ask`, `info`, `sessions`, `upgrade`), flag parsing, `--json` output, and `runtime.ts`, which assembles the agent for a session |
| `src/core/agent/` | The agent loop: tool batches, admission, compaction, checkpoints, recovery, `system_prompt.md`, shared types |
| `src/core/config/` | `settings.json`, `.nod.json`, environment, and precedence into one `ResolvedConfig` |
| `src/core/session/` | Session store (`session.json` + `events.jsonl`), catalog, resume/recover, titles, prompt history |
| `src/core/workspace/` | Primary and additional directories, path resolution, `nod workspace` |
| `src/core/context/` | `AGENTS.md` discovery and context limits |
| `src/core/permissions/` | Modes, rules, session grants, command classification, and the auto reviewer |
| `src/core/tools/` | Tool registry and the built-in tools (`read_file`, `edit_file`, `shell`, `web_fetch`, …) |
| `src/core/shell/` | Background processes with handles and bounded output |
| `src/core/skills/` | `SKILL.md` discovery, parsing, catalog, and install sources |
| `src/core/mcp/` | MCP client contracts: stdio, streamable HTTP, SSE, OAuth, trust |
| `src/core/subagent/` | Subagent service contract |
| `src/core/github/` | `nod pr` and `nod issue` |
| `src/core/notify/` | Turn-end and attention-required cues |
| `src/core/usage/` | Local token usage records and `nod usage` |
| `src/core/upgrade/` | Release lookup on GitHub, checksum verification, in-place binary replacement, auto-check |
| `src/providers/` | Codex and Grok over the Responses API, OAuth with PKCE, token storage |
| `src/ui/` | The interactive shell ([Ink](https://github.com/vadimdemedes/ink)): composer, transcript, menus, approvals, footer |
| `src/acp/` | The `nod acp` server (JSON-RPC 2.0 over stdio) |
| `src/sdk/` | `createAgent()` and `createTerminal()` for JavaScript hosts (`nod/sdk`) |
| `docs/` | Markdown sources of the documentation |
| `site/` | The website: landing, generated docs, `llms.txt`, and the installer at `site/public/setup.sh` |
| `scripts/` | `setup.sh`, the installer served from the site |
| `evals/` | Eval tasks and runner |
| `test/` | `bun:test` suites, one directory per module |

## Making changes

1. Branch from `main`.
2. Keep changes focused. One concern per pull request.
3. Prefer small exported functions that take their dependencies (`home`, `cwd`, `now`, `fetch`, …) as an argument so tests can inject temp dirs and fakes. No new runtime dependencies.
4. Add or update tests under `test/<module>/` for behavior changes.
5. Run the full check before pushing:

   ```bash
   bun run typecheck && bun run check && bun test
   ```

   `bun run fix` applies Biome's lint and format fixes. To check that the compiled binary still works:

   ```bash
   bun build --compile src/cli/main.ts --outfile /tmp/nod && /tmp/nod --version
   ```

## Evals

Each task in `evals/tasks.ts` is a throwaway repository with a prompt and a check. For each task, `bun run eval` reports how often the check passed, plus the median steps, commands, failed commands, seconds, and final context size. Evals use your own subscription, so they are not run in CI.

```bash
bun run eval                                  # every task once, on your default model
bun run eval -- --repeat 3 fix-bug feature    # some tasks, three runs each
bun run eval -- --provider grok --model <id> --concurrency 2
```

Every task needs a reference solution. `bun test` checks that each check fails on the untouched fixture and passes with the reference, so a task can't pass without real work.

If your change affects agent behavior (system prompt, loop, tool output, permissions), include eval results from before and after in the pull request.

## Releases

Binaries are built by `.github/workflows/release.yml` with `bun build --compile` for macOS and Linux (x86_64 and aarch64), packaged as `nod-<platform>.tar.gz` with a `.sha256` next to it, and uploaded to GitHub Releases.

- Push a tag `vX.Y.Z` (matching `package.json`) to publish a stable release.
- Push a tag `dev-<sha>` to publish a prerelease on the `dev` channel.

`scripts/setup.sh` and `nod upgrade` read those assets; keep the asset names and the tag formats stable.

## Pull requests

- Describe what changed, why, and how you tested it.
- Add an entry under `Unreleased` in [CHANGELOG.md](CHANGELOG.md) for user-facing changes.
- CI must pass.

By contributing, you agree that your contributions are licensed under the [MIT License](LICENSE) and that you follow the [Code of Conduct](CODE_OF_CONDUCT.md).
