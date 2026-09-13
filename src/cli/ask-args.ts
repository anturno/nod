/** `nod ask` argument parsing with fx's cross-flag rules. */
import { CliUsageError } from "./global-args.ts";

export type AskArgs = {
  permission: "auto" | "full-access" | null;
  images: string[];
  system?: string;
  json: boolean;
  quiet: boolean;
  promptPermissions: boolean;
  noSave: boolean;
  noColor: boolean;
  resume?: { kind: "last" } | { kind: "id"; id: string };
  continueRecovery: boolean;
  verbose: boolean;
  timeoutMs?: number;
  /** Prompt words; empty means read stdin. */
  promptArgs: string[];
};

export const ASK_USAGE =
  "ask [--auto|--full-access] [--image PATH] [--system TEXT] [--json] [--quiet] [--prompt-permissions] [--no-save] [--no-color] [--resume <last|id>|--resume-id <id>] [--continue-recovery] [--] <prompt>";

const fail = (message: string): never => {
  throw new CliUsageError("InvalidAskArgs", message);
};

export function parseAskArgs(args: string[]): AskArgs {
  const out: AskArgs = {
    permission: null,
    images: [],
    json: false,
    quiet: false,
    promptPermissions: false,
    noSave: false,
    noColor: false,
    continueRecovery: false,
    verbose: false,
    promptArgs: [],
  };
  let resumeSeen = false;
  const value = (i: number, flag: string): string => {
    const v = args[i + 1];
    if (v === undefined) fail(`${flag} requires a value`);
    return v as string;
  };
  let i = 0;
  for (; i < args.length; i++) {
    const arg = args[i] as string;
    if (arg === "--") {
      i++;
      break;
    }
    if (!arg.startsWith("-") || arg === "-") break;
    switch (arg) {
      case "--auto":
      case "--full-access":
      case "--yolo": {
        const mode = arg === "--auto" ? "auto" : "full-access";
        if (out.permission && out.permission !== mode) fail("--auto and --full-access are mutually exclusive");
        out.permission = mode;
        break;
      }
      case "--image":
        out.images.push(value(i++, arg));
        break;
      case "--system":
        out.system = value(i++, arg);
        break;
      case "--json":
        out.json = true;
        break;
      case "--quiet":
        out.quiet = true;
        break;
      case "--prompt-permissions":
        out.promptPermissions = true;
        break;
      case "--no-save":
        out.noSave = true;
        break;
      case "--no-color":
        out.noColor = true;
        break;
      case "--verbose":
        out.verbose = true;
        break;
      case "--continue-recovery":
        out.continueRecovery = true;
        break;
      case "--timeout": {
        const ms = Number(value(i++, arg));
        if (!Number.isInteger(ms) || ms <= 0) fail("--timeout requires a positive integer of milliseconds");
        out.timeoutMs = ms;
        break;
      }
      case "--resume": {
        if (resumeSeen) fail("--resume may be given once");
        resumeSeen = true;
        const target = value(i++, arg);
        out.resume = target === "last" ? { kind: "last" } : { kind: "id", id: target };
        break;
      }
      case "--resume-id": {
        if (resumeSeen) fail("--resume-id may be given once");
        resumeSeen = true;
        out.resume = { kind: "id", id: value(i++, arg) };
        break;
      }
      default:
        fail(`unknown option ${arg}\nusage: nod ${ASK_USAGE}`);
    }
  }
  out.promptArgs = args.slice(i);
  if (out.noSave && out.resume)
    throw new CliUsageError("NoSaveResumeConflict", "--no-save cannot be combined with --resume");
  if (out.continueRecovery) {
    if (!out.resume) fail("--continue-recovery requires --resume or --resume-id");
    if (out.noSave) fail("--continue-recovery cannot be combined with --no-save");
    if (out.promptArgs.length || out.images.length) fail("--continue-recovery does not accept a prompt or images");
  }
  return out;
}
