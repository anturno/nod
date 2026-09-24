---
title: "Installation"
description: "Install nod, review what the installer does, and verify the local binary."
---

# Installation

nod supports macOS and Linux on x86_64 and arm64. The installer needs `curl` or `wget`, plus `tar`.

## Install the latest release

Run the installer:

```bash
curl -fsSL https://nod.anturno.cloud/setup.sh | bash
```

`https://nod.anturno.cloud/setup.sh` is the canonical installer. Nothing else needs to be trusted to install nod.

## Review the installer before running it

Piping a script to a shell runs whatever the server returns. If you or your organization require a review first, download it, read it, and run the copy you read:

```bash
curl -fsSL https://nod.anturno.cloud/setup.sh -o setup.sh
```

```bash
less setup.sh
```

```bash
bash setup.sh
```

What the script does, in order: detect your platform, resolve the latest published version, download and unpack that release archive, install the binary, and offer to put it on your `PATH`. Specifically:

- It installs to `~/.local/bin`. Set `NOD_INSTALL_DIR` to install somewhere else.
- If the install directory is not already on your `PATH`, it appends a `PATH` line to your shell profile: `~/.zshrc`, `~/.bash_profile` or `~/.bashrc`, or `~/.config/fish/config.fish`. It skips that edit when the directory is already mentioned in the file.
- Release archives are downloaded over HTTPS from [GitHub Releases](https://github.com/anturno/nod/releases). Each archive is published next to its `.sha256` checksum. An audited install should read the script, fetch the archive it names, and verify that artifact against the published checksum with your own process.

For automation, pass a version so a run is reproducible instead of tracking the latest release:

```bash
curl -fsSL https://nod.anturno.cloud/setup.sh | bash -s -- <version>
```

## Install with Bun

If Bun 1.4 or newer is already installed, you can skip the binary and run nod from source:

```bash
bun install -g github:anturno/nod
```

This installs the `nod` command into Bun's global bin directory and runs the TypeScript sources directly on Bun. `nod upgrade` manages only binaries installed by `setup.sh`; upgrade a Bun install by running the same command again.

## Put nod on your PATH

If your shell cannot find `nod` after installing, add the install directory to the current shell:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Restarting the shell picks up the line the installer added to your profile.

## Verify the install

Print the installed version:

```bash
nod --version
```

Run local health checks:

```bash
nod doctor
```

`nod doctor` reports the workspace, configuration, authentication, resolved startup settings, local session state, and Git integrations without starting an agent turn.

## Upgrade

Upgrade to the latest release on the selected channel:

```bash
nod upgrade
```

Add `--channel stable` or `--channel dev` to select and remember a release channel. Stable releases are tagged `v*` on GitHub; the dev channel follows prereleases.

The interactive shell also reports available updates and can install them in place. Set `NOD_AUTO_UPGRADE=0` to skip automatic upgrade checks for one process.

When an automatic update is installed, the footer offers `ctrl+g` to reload. Press it with an empty composer and no active response or focused view. nod relaunches the installed binary and resumes the current session. If the session cannot be handed off safely, nod stays open and explains what must finish or close first.

## Build from source

Building from source requires Bun 1.4 or newer. Clone the repository, build a standalone binary, then verify it:

```bash
git clone https://github.com/anturno/nod.git
cd nod
bun install
bun build --compile src/cli/main.ts --outfile nod
./nod --version
```

`bun run dev` runs the CLI from the sources without compiling.

## Optional tools

- [`gh`](https://cli.github.com/) is required only to [publish drafts with `nod pr --create` or `nod issue --create`](https://nod.anturno.cloud/docs/using-nod/cli.md#run-nod).

> **Install only what you can verify**
>
> Fetch the installer from `nod.anturno.cloud` over HTTPS, read it when your policy requires review, and pin a version in automation. nod itself never needs elevated privileges to install or run.

Next, [authenticate](https://nod.anturno.cloud/docs/getting-started/authentication.md) and follow the [quick start](https://nod.anturno.cloud/docs.md). If the install did not work, see [Troubleshooting](https://nod.anturno.cloud/docs/using-nod/troubleshooting.md).

---

[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)
