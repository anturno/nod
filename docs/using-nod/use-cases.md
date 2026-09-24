---
title: "Use cases"
description: "Practical ways to use nod: interactive coding, scripts, pull requests, editors, and embedding."
---

# Use cases

nod runs the same agent in four places: the interactive shell, one-shot `nod ask` runs, editors over ACP, and your own application through the SDK. Pick the one that fits the job.

| Goal | Start with |
| --- | --- |
| Explore, change, and test code with the agent | `nod` |
| Run one request from a script or CI job | `nod ask` |
| Draft a pull request or issue | `nod pr`, `nod issue` |
| Use nod from an editor | `nod acp` |
| Build nod into a product | `@anturno/nod/sdk` |

## Understand an unfamiliar codebase

Start nod in the project root and ask about real paths:

```bash
cd path/to/project
nod
```

```text
Explain how a request flows from src/server.ts to the database.
List the files involved and anything that looks fragile.
```

Type `@` to reference a specific file. Add [project instructions](https://nod.anturno.cloud/docs/configure/project-instructions.md) so every session starts with your conventions. If the work spans more than one repository, add the others with `nod workspace add PATH`; see [Additional workspaces](https://nod.anturno.cloud/docs/configure/additional-workspaces.md).

## Fix a bug or build a feature

Describe the outcome and how to verify it:

```text
The /login route returns 500 when the email is missing. Find the cause,
fix it, add a regression test, and run the test suite.
```

nod reads code, edits files, and runs commands under your [permission mode](https://nod.anturno.cloud/docs/configure/permissions.md). Press enter with a follow-up to steer it mid-turn, escape to stop, and ctrl+o to review what changed. Pick up later with `nod resume last`.

## Draft pull requests and issues

Let nod summarize the current branch into a pull request:

```bash
nod pr "focus on the migration risk"
```

The draft is printed for review. Add `--create` to publish it with `gh`. `nod issue` works the same way for bug reports:

```bash
nod issue --create "flaky timeout in the upload test"
```

## Automate with scripts and CI

`nod ask` runs one request and exits. Markdown goes to stdout and progress to stderr, so it composes with other tools:

```bash
git diff main | nod ask "review this diff for bugs; reply with a short list"
```

Use `--json` when a program needs structured output, and `--no-save` for throwaway runs:

```bash
nod ask --json --no-save "summarize the current changes" | jq -r .final_output
```

Chain steps in one session with `--resume last`:

```bash
nod ask "add input validation to src/api/users.ts"
nod ask --resume last "now add tests and run them"
```

Noninteractive runs never wait for approval; actions that need a human fail instead. Configure [permission rules](https://nod.anturno.cloud/docs/configure/permissions.md) for what the job may do, and sign in on the runner before the job starts. See [`nod ask`](https://nod.anturno.cloud/docs/using-nod/nod-ask.md) for every flag.

## Work from screenshots

Attach a design or an error screenshot:

```bash
nod ask --image ./mockup.png "build this settings page in src/ui/Settings.tsx"
```

In the shell, use `/image ./path.png`. See [Vision](https://nod.anturno.cloud/docs/capabilities/vision.md).

## Connect your tools

Give nod access to issue trackers, databases, or internal APIs through MCP servers:

```bash
nod mcp add --transport http linear https://mcp.linear.app/mcp
nod mcp auth linear
```

See [MCP](https://nod.anturno.cloud/docs/capabilities/mcp.md). Package repeatable workflows as [skills](https://nod.anturno.cloud/docs/capabilities/skills.md) and invoke them with `$`. For research beyond the repository, nod can use [web search](https://nod.anturno.cloud/docs/capabilities/web-search.md); for large tasks it can delegate to [subagents](https://nod.anturno.cloud/docs/capabilities/subagents.md).

## Use nod from your editor

Editors that speak the Agent Client Protocol can launch nod as their agent:

```json
{
  "command": "/absolute/path/to/nod",
  "args": ["acp"]
}
```

The editor's working directory becomes the workspace. See [ACP server](https://nod.anturno.cloud/docs/using-nod/acp.md).

## Build nod into your application

The SDK runs the same agent in-process:

```ts
import { createAgent } from "@anturno/nod/sdk";

const agent = await createAgent({ auth: { provider: "codex" } });
try {
  const turn = agent.prompt("Summarize README.md in three bullets.");
  for await (const event of turn) {
    if (event.type === "text_delta") process.stdout.write(event.delta);
  }
  await turn.result;
} finally {
  await agent.close();
}
```

Start from the [examples](https://nod.anturno.cloud/docs/lib/examples.md): a readline chat, an HTTP route, and an embedded terminal. See the [SDK API reference](https://nod.anturno.cloud/docs/lib/api.md).

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
