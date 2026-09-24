/** `nod acp [--model <id>] [--log-file <path>]`: the ACP server over stdio. Stdout carries frames only. */
import { appendFileSync } from "node:fs";
import { resolve } from "node:path";
import { createAcpServer } from "../acp/server.ts";
import { parseOverride } from "../core/context/limits.ts";
import { CliUsageError, type GlobalArgs, parseFlags } from "./global-args.ts";
import { VERSION } from "./info.ts";
import type { Io } from "./output.ts";

const USAGE = "usage: nod acp [--model <id>] [--log-file <path>]";

export async function runAcp(args: string[], io: Io, global?: GlobalArgs): Promise<number> {
  const { flags, positionals } = parseFlags(args, { "--model": "string", "--log-file": "string" }, USAGE);
  if (positionals.length)
    throw new CliUsageError("UnexpectedArgument", `unexpected argument ${positionals[0]}\n${USAGE}`);
  const logFile = typeof flags["--log-file"] === "string" ? resolve(io.cwd, flags["--log-file"]) : undefined;
  const log = (line: string) => {
    const entry = `${new Date().toISOString()} ${line}\n`;
    if (logFile) appendFileSync(logFile, entry);
    else io.stderr(entry);
  };
  const server = createAcpServer({
    cwd: io.cwd,
    env: io.env,
    version: VERSION,
    model: typeof flags["--model"] === "string" ? flags["--model"] : undefined,
    addDirs: global?.addDirs,
    noAdditionalDirs: global?.noAdditionalDirs,
    contextLimits: global?.contextLimits.map(parseOverride),
    log,
  });
  log(`nod ${VERSION} acp serving ${io.cwd}`);
  await server.serve(Bun.stdin.stream(), { write: (chunk) => io.stdout(chunk) });
  return 0;
}
