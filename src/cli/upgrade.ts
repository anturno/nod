/** `nod upgrade [--channel stable|dev] [--json]`: remember the channel, then replace the binary from GitHub Releases. */
import { loadConfig } from "../core/config/resolve.ts";
import { writeUserPatch } from "../core/config/settings-store.ts";
import { type Channel, type Fetch, formatUpgrade, parseChannel, upgrade } from "../core/upgrade/index.ts";
import { CliUsageError, parseFlags } from "./global-args.ts";
import { VERSION } from "./info.ts";
import type { Io } from "./output.ts";
import { renderFailureJson } from "./output.ts";

const USAGE = "upgrade [--channel <stable|dev>] [--json]";

/** The release tag baked in by `bun build --define process.env.NOD_BUILD_TAG=...`; package.json's version from source. */
export const BUILD_VERSION: string = process.env.NOD_BUILD_TAG ?? VERSION;

export async function runUpgrade(
  args: string[],
  io: Io,
  deps: { fetch?: Fetch; execPath?: string; currentVersion?: string } = {},
): Promise<number> {
  const { flags, positionals } = parseFlags(args, { "--channel": "string", "--json": "boolean" }, USAGE);
  if (positionals.length > 0) throw new CliUsageError("InvalidUpgradeArgs", `usage: nod ${USAGE}`);
  const json = flags["--json"] === true;
  let selected: Channel | undefined;
  if (typeof flags["--channel"] === "string") {
    selected = parseChannel(flags["--channel"]);
    if (!selected)
      throw new CliUsageError("InvalidUpgradeArgs", `--channel must be stable or dev\nusage: nod ${USAGE}`);
  }
  const config = loadConfig({ workspaceRoot: io.cwd, env: io.env });
  const channel = selected ?? config.updateChannel;
  if (selected) {
    try {
      writeUserPatch(config.home, { update_channel: selected });
    } catch {
      const message = "failed to save update channel";
      if (json) io.stdout(`${renderFailureJson("upgrade", message)}\n`);
      else io.stderr(`nod upgrade: ${message}\n`);
      return 1;
    }
  }
  const result = await upgrade({
    fetch: deps.fetch ?? ((url, init) => fetch(url, init)),
    currentVersion: deps.currentVersion ?? BUILD_VERSION,
    channel,
    execPath: deps.execPath ?? process.execPath,
  });
  io.stdout(formatUpgrade(result, json ? "json" : "text"));
  return result.status === "failed" ? 1 : 0;
}
