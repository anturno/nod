---
title: "Share feedback"
description: "Report a nod problem and collect the diagnostics that help fix it."
---

# Share feedback

nod is under active development. Report issues and share diagnostic data to help improve nod.

## Report a problem

Inside the interactive shell:

```bash
/feedback
```

`/feedback` opens the [nod bug report form](https://github.com/anturno/nod/issues/new?template=bug_report.yml) on GitHub. It does not generate diagnostics and does not change the clipboard.

The form asks for the issue, the expected behavior, and steps to reproduce it, and it requires you to confirm that you removed secrets and other sensitive data first. Feature requests use the [feature request form](https://github.com/anturno/nod/issues/new?template=feature_request.yml).

## Collect diagnostics

The most useful attachments, in order:

```bash
nod --version
```

```bash
nod status --json
```

```bash
nod doctor
```

For a problem inside one conversation, `nod session last --json` exports the saved session, and ctrl+o in the shell shows the full transcript including collapsed tool output. Review and redact anything you attach before sharing it. It remains local unless you share it yourself.

## Check your setup first

`nod doctor` checks the workspace, configuration, authentication, startup settings, local session state, and Git integrations without starting an agent turn:

```bash
nod doctor
```

When nod can recover a session problem, the output includes the command to run. [Troubleshooting](https://nod.anturno.cloud/docs/using-nod/troubleshooting.md) covers the problems it reports most often.

> **Review before sharing**
>
> Status output and session exports remain local unless you share them yourself. They may contain prompts, code, paths, commands, model output, or secrets.

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
