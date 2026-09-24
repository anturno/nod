/** Leading global flags: parsed left to right until the first token that is not one of them. */

export class CliUsageError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

export type LimitOverrideSpec = string;
export type ResumeTarget = { kind: "picker" } | { kind: "last" } | { kind: "id"; id: string };
export type GlobalArgs = {
  contextLimits: LimitOverrideSpec[];
  addDirs: string[];
  noAdditionalDirs: boolean;
  fullAccess: boolean;
  /** A leading resume flag such as -r, -c, --resume [last|id], --resume-<id>. */
  resume?: ResumeTarget;
  rest: string[];
};

export function parseGlobalArgs(argv: string[]): GlobalArgs {
  const out: GlobalArgs = { contextLimits: [], addDirs: [], noAdditionalDirs: false, fullAccess: false, rest: [] };
  let i = 0;
  const value = (flag: string, code: string): string => {
    const next = argv[i + 1];
    if (next === undefined || next.length === 0) throw new CliUsageError(code, `${flag} requires a value`);
    i++;
    return next;
  };
  for (; i < argv.length; i++) {
    const arg = argv[i] as string;
    if (arg === "--context-limit") out.contextLimits.push(value(arg, "MissingContextLimitValue"));
    else if (arg.startsWith("--context-limit=")) {
      const spec = arg.slice("--context-limit=".length);
      if (!spec) throw new CliUsageError("MissingContextLimitValue", "--context-limit requires a value");
      out.contextLimits.push(spec);
    } else if (arg === "--add-dir") out.addDirs.push(value(arg, "MissingAdditionalDirectoryValue"));
    else if (arg.startsWith("--add-dir=")) {
      const dir = arg.slice("--add-dir=".length);
      if (!dir) throw new CliUsageError("MissingAdditionalDirectoryValue", "--add-dir requires a value");
      out.addDirs.push(dir);
    } else if (arg === "--no-additional-dirs") {
      if (out.noAdditionalDirs)
        throw new CliUsageError("DuplicateAdditionalDirectorySuppression", "--no-additional-dirs may be given once");
      out.noAdditionalDirs = true;
    } else if (arg === "--full-access" || arg === "--yolo") out.fullAccess = true;
    else if (arg === "-r") out.resume = { kind: "picker" };
    else if (arg === "-c" || arg === "--continue" || arg === "--resume-last") out.resume = { kind: "last" };
    else if (arg === "--resume") {
      const next = argv[i + 1];
      if (next === undefined || next.startsWith("-")) out.resume = { kind: "last" };
      else {
        i++;
        out.resume = next === "last" ? { kind: "last" } : { kind: "id", id: next };
      }
    } else if (arg.startsWith("--resume-")) {
      const id = arg.slice("--resume-".length);
      if (!id) throw new CliUsageError("InvalidResumeTarget", "--resume-<id> requires an id");
      out.resume = { kind: "id", id };
    } else break;
  }
  out.rest = argv.slice(i);
  return out;
}

/** `resume [last|<id>] | resume --id <id>` after the command token. */
export function parseResumeArgs(args: string[]): ResumeTarget {
  const [first, second, ...more] = args;
  if (more.length) throw new CliUsageError("InvalidResumeArgs", "usage: nod resume [last|<id>] | resume --id <id>");
  if (first === "--id") {
    if (!second) throw new CliUsageError("InvalidResumeArgs", "--id requires a session id");
    return { kind: "id", id: second };
  }
  if (second !== undefined)
    throw new CliUsageError("InvalidResumeArgs", "usage: nod resume [last|<id>] | resume --id <id>");
  if (first === undefined || first === "last") return { kind: "last" };
  if (first.startsWith("-")) throw new CliUsageError("InvalidResumeArgs", `unknown option ${first}`);
  return { kind: "id", id: first };
}

/** Rejects a flag given twice; returns the parsed table for the small commands. */
export function parseFlags(
  args: string[],
  spec: Record<string, "boolean" | "string">,
  usage: string,
): { flags: Record<string, string | boolean>; positionals: string[] } {
  const flags: Record<string, string | boolean> = {};
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i] as string;
    if (!arg.startsWith("-") || arg === "-") {
      positionals.push(arg);
      continue;
    }
    const [name, inline] = arg.includes("=")
      ? [arg.slice(0, arg.indexOf("=")), arg.slice(arg.indexOf("=") + 1)]
      : [arg];
    const kind = spec[name];
    if (!kind) throw new CliUsageError("UnknownOption", `unknown option ${name}\n${usage}`);
    if (name in flags) throw new CliUsageError("DuplicateOption", `${name} may be given once\n${usage}`);
    if (kind === "boolean") {
      if (inline !== undefined) throw new CliUsageError("InvalidOption", `${name} takes no value\n${usage}`);
      flags[name] = true;
    } else {
      const v = inline ?? args[++i];
      if (v === undefined) throw new CliUsageError("MissingOptionValue", `${name} requires a value\n${usage}`);
      flags[name] = v;
    }
  }
  return { flags, positionals };
}
