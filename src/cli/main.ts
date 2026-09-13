#!/usr/bin/env bun
/** `nod`: parses the leading global flags, then dispatches one top-level command. */
import { runAsk } from "./ask.ts";
import { findTopLevel, renderCommandHelp, renderTopLevelHelp } from "./commands.ts";
import { CliUsageError, parseGlobalArgs, parseResumeArgs } from "./global-args.ts";
import { runDoctor, runLogin, runLogout, runModels, runPermissions, runProvider, runStatus, VERSION } from "./info.ts";
import { type Io, processIo } from "./output.ts";
import { runSession, runSessions, runUsage, runWorkspace } from "./sessions.ts";

const NOT_YET = (name: string, io: Io) => {
  io.stderr(`nod ${name} is not available in this build yet.\n`);
  return 1;
};

export async function main(argv: string[], io: Io = processIo()): Promise<number> {
  try {
    const global = parseGlobalArgs(argv);
    const [command, ...args] = global.rest;
    if (global.resume || command === undefined || command === "resume" || command === "-r")
      return NOT_YET("interactive shell", io);
    if (command === "help" || command === "-h" || command === "--help") {
      const spec = args[0] ? findTopLevel(args[0]) : undefined;
      io.stdout(spec ? renderCommandHelp(spec) : renderTopLevelHelp(VERSION));
      return 0;
    }
    if (command === "-v" || command === "--version" || command === "version") {
      io.stdout(`nod ${VERSION}\n`);
      return 0;
    }
    if (args[0] === "--help" || args[0] === "-h") {
      const spec = findTopLevel(command);
      if (spec) {
        io.stdout(renderCommandHelp(spec));
        return 0;
      }
    }
    switch (command) {
      case "ask":
        return await runAsk(args, global, io);
      case "status":
        return runStatus(args, io);
      case "doctor":
        return runDoctor(args, io);
      case "models":
        return await runModels(args, io);
      case "permissions":
        return runPermissions(args, io);
      case "login":
        return await runLogin(args, io);
      case "logout":
        return await runLogout(args, io);
      case "provider":
        return runProvider(args, io);
      case "sessions":
        return runSessions(args, io);
      case "session":
        return runSession(args, io);
      case "usage":
        return runUsage(args, io);
      case "workspace":
        return runWorkspace(args, io, global);
      case "mcp":
      case "pr":
      case "issue":
      case "acp":
      case "upgrade":
        return NOT_YET(command, io);
      default:
        throw new CliUsageError("UnknownCommand", `unknown command: ${command}\n\n${renderTopLevelHelp(VERSION)}`);
    }
  } catch (e) {
    if (e instanceof CliUsageError) {
      io.stderr(`${e.message}\n`);
      return 1;
    }
    io.stderr(`error: ${(e as Error).message}\n`);
    return 1;
  }
}

export { parseResumeArgs };

if (import.meta.main) {
  process.on("SIGTERM", () => process.exit(143));
  process.exit(await main(process.argv.slice(2)));
}
