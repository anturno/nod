---
title: "Skills"
description: "Discover, load, install, and create reusable agent instructions."
---

# Skills

A skill is a directory containing `SKILL.md`. nod discovers skill metadata at startup, but loads the instructions only when you or the agent invokes that skill.

## Browse and invoke

Open the interactive skill catalog:

```bash
/skills
```

Use the source tabs and search field to filter results. Press enter to insert the selected skill into the prompt. You can also type `$` in the composer to search skills directly.

Inspect one skill without invoking it:

```bash
/skills show <name>
```

Duplicate names are preserved. A name-only tool call works when one visible skill matches; otherwise the caller must use the advertised location.

## Discovery roots

nod checks `skills/` and these hidden directories from the workspace upward, stopping before your home directory:

```text
skills/
.opencode/skills/
.codex/skills/
.claude/skills/
.agents/skills/
.claw/skills/
```

It then checks user roots:

```text
~/.nod/skills/
~/.config/opencode/skills/
~/.codex/skills/
~/.claude/skills/
~/.agents/skills/
~/.claw/skills/
```

Additional workspace directories do not contribute skills. The primary workspace remains the only project source.

## Install

Install one skill from a repository:

```bash
/skills install vercel-labs/agent-skills --skill find-skills
```

Install from a local directory:

```bash
/skills add ./my-skills --skill my-tool
```

`add` is an alias for `install`. The source can be `owner/repo`, `owner/repo@skill`, a Git URL, a `skills.sh` URL, a pasted `npx skills add ...` command, or a local path. Without `--skill`, nod installs every valid skill in the source. Managed installs always go to `~/.nod/skills/`; nod never writes into another agent's directory.

Use `/skills path` to print the managed install root.

The agent can also install a skill with `install_skill`, then load it later with the `skill` tool.

## Create and remove

Create or remove a skill in the managed skill directory:

```bash
/skills create my-skill
```

```bash
/skills remove my-skill
```

These commands manage only `~/.nod/skills/`. Remove workspace or third-party skills at their source.

## File format

Each skill uses a `SKILL.md` file with YAML frontmatter followed by Markdown instructions:

```md
---
name: my-skill
description: Use this when a request needs...
---

# My skill

Instructions for the agent.
```

`name` is required and must fit on one line. `description` is optional and may be an unquoted or quoted scalar, or a block introduced by `>`, `>-`, or `|`. Extra frontmatter fields are ignored, so compatible skills can carry metadata for other agents. A file without frontmatter uses its directory name.

Malformed or unreadable candidates are skipped with a warning; other skills in the same root still load.

> **Loading is explicit**
>
> Discovering a skill does not add its instructions to every prompt. Instructions enter context only when the skill is invoked.

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
