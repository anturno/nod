/** `nod mcp ...`: MCP management without the interactive shell. */
import { loadConfig } from "../core/config/resolve.ts";
import { runMcpCommand } from "../core/mcp/commands.ts";
import { openBrowser } from "../providers/auth/oauth.ts";
import { VERSION } from "./info.ts";
import type { Io } from "./output.ts";

export async function runMcp(args: string[], io: Io): Promise<number> {
  const config = loadConfig({ workspaceRoot: io.cwd, env: io.env });
  const result = await runMcpCommand(args, {
    home: config.home,
    workspaceRoot: config.workspaceRoot,
    env: io.env,
    openUrl: (url) => {
      io.stdout(`Open this URL to authenticate:\n${url}\n`);
      openBrowser(url);
    },
    interactive: io.isTTY,
    version: VERSION,
  });
  (result.ok ? io.stdout : io.stderr)(`${result.text}\n`);
  return result.ok ? 0 : 1;
}
