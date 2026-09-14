/**
 * Shell command classification for the permission engine.
 *
 * ponytail: conservative allowlists over statically-shaped commands replace a
 * large word-level parser. Anything the allowlist does not recognise goes to the
 * reviewer or the prompt, so the ceiling is false negatives (extra reviews),
 * never false positives. Upgrade path: port the argv planner when the review
 * volume in auto mode hurts.
 */

export type CommandClass =
  | { kind: "direct_read_only" }
  | { kind: "reversible" }
  | { kind: "approval_required"; reason: ApprovalReason };

export type ApprovalReason =
  | "dynamic_shell"
  | "unknown_command"
  | "filesystem_write"
  | "network_access"
  | "process_or_system"
  | "unsupported_shell"
  | "unsupported_argument";

const MAX_COMMAND_BYTES = 8 * 1024;
const STATIC_BYTE = /^[A-Za-z0-9_./,:+=%@-]$/;

/**
 * True when the command is a plain word list: bare words of `[A-Za-z0-9_./,:+=%@-]`
 * or single-quoted literals separated by blanks, no leading `VAR=`, no shell
 * metacharacters.
 */
export function isStaticCommand(command: string, allowWildcards = false): boolean {
  if (command.length === 0) return false;
  if (firstWordIsAssignment(command)) return false;
  let index = 0;
  let inWord = false;
  while (index < command.length) {
    const char = command[index]!;
    if (char === " " || char === "\t") {
      if (!inWord) return false;
      while (index < command.length && (command[index] === " " || command[index] === "\t")) index++;
      if (index === command.length) return false;
      inWord = false;
      continue;
    }
    if (char === "'") {
      const end = command.indexOf("'", index + 1);
      if (end < 0) return false;
      if (/[\0\r\n]/.test(command.slice(index + 1, end))) return false;
      inWord = true;
      index = end + 1;
      continue;
    }
    if (!STATIC_BYTE.test(char) && !(allowWildcards && (char === "*" || char === "?"))) return false;
    inWord = true;
    index++;
  }
  return inWord;
}

function firstWordIsAssignment(command: string): boolean {
  const firstWord = command.split(/[ \t]/, 1)[0] ?? "";
  const equals = firstWord.indexOf("=");
  if (equals < 0) return false;
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(firstWord.slice(0, equals));
}

type Segment = { operator: "" | "|" | "||" | "&&" | ";"; text: string };

/** Splits on `| || && ;` outside single quotes. A stray `&` stays inside its segment (and makes it non-static). */
function splitSegments(command: string): Segment[] {
  const segments: Segment[] = [];
  let operator: Segment["operator"] = "";
  let start = 0;
  let quoted = false;
  for (let i = 0; i < command.length; i++) {
    const char = command[i];
    if (char === "'") quoted = !quoted;
    if (quoted) continue;
    let next: Segment["operator"] | null = null;
    if (command.startsWith("&&", i)) next = "&&";
    else if (command.startsWith("||", i)) next = "||";
    else if (char === "|") next = "|";
    else if (char === ";") next = ";";
    if (!next) continue;
    segments.push({ operator, text: command.slice(start, i).trim() });
    operator = next;
    i += next.length - 1;
    start = i + 1;
  }
  segments.push({ operator, text: command.slice(start).trim() });
  return segments;
}

function words(segment: string): string[] {
  const out: string[] = [];
  for (const raw of segment.split(/[ \t]+/)) {
    if (raw.length === 0) continue;
    out.push(raw.startsWith("'") && raw.endsWith("'") && raw.length >= 2 ? raw.slice(1, -1) : raw);
  }
  return out;
}

const READ_ONLY = new Set([
  "ls",
  "cat",
  "head",
  "tail",
  "wc",
  "pwd",
  "echo",
  "printf",
  "grep",
  "rg",
  "find",
  "fd",
  "which",
  "type",
  "env",
  "uname",
  "date",
  "whoami",
  "id",
  "stat",
  "file",
  "du",
  "df",
  "tree",
  "jq",
  "sort",
  "uniq",
  "cut",
  "tr",
  "awk",
  "sed",
  "git",
  "bun",
  "node",
  "npm",
]);
const GIT_READ_ONLY = new Set(["status", "log", "diff", "show", "branch", "rev-parse", "ls-files", "blame"]);
const GIT_BRANCH_MUTATING = new Set([
  "-d",
  "-D",
  "-m",
  "-M",
  "-c",
  "-C",
  "-u",
  "-f",
  "--delete",
  "--move",
  "--copy",
  "--force",
]);
const FIND_MUTATING = new Set(["-delete", "-exec", "-execdir", "-ok", "-okdir"]);

function readOnlySegment(argv: string[]): boolean {
  const [head, ...args] = argv;
  if (!head || !READ_ONLY.has(head)) return false;
  switch (head) {
    case "git": {
      const sub = args[0];
      if (!sub || !GIT_READ_ONLY.has(sub)) return false;
      if (sub === "branch") return args.slice(1).every((a) => a.startsWith("-") && !GIT_BRANCH_MUTATING.has(a));
      return !args.some((a) => a.startsWith("--output"));
    }
    case "bun":
    case "node":
      return args.length === 1 && (args[0] === "--version" || args[0] === "-v");
    case "npm":
      return args[0] === "ls";
    case "sed":
      // ponytail: only `sed -n 'N,Mp'` style prints; sed scripts can write (w) or execute (e).
      return args.includes("-n") && !args.some((a) => a.startsWith("-i")) && args.some((a) => /^[0-9,$ ]*p$/.test(a));
    case "env":
      return args.length === 0;
    case "find":
      return !args.some((a) => FIND_MUTATING.has(a) || a.startsWith("-fprint"));
    case "fd":
      return !args.some((a) => a === "-x" || a === "-X" || a.startsWith("--exec"));
    case "sort":
      return !args.some((a) => a === "-o" || a.startsWith("--output"));
    case "tree":
      return !args.includes("-o");
    case "date":
      return !args.some((a) => a === "-s" || a.startsWith("--set"));
    case "rg":
      return !args.some((a) => a.startsWith("--pre"));
    case "awk":
      return !args.some((a) => a.includes(">") || a.includes("system("));
    default:
      return true;
  }
}

const NPM_LIKE = new Set(["test", "run", "ci", "install", "build"]);
const REVERSIBLE_SUBCOMMANDS: Record<string, Set<string> | null> = {
  bun: new Set(["test", "run", "build", "install"]),
  npm: NPM_LIKE,
  pnpm: NPM_LIKE,
  yarn: NPM_LIKE,
  cargo: new Set(["build", "test", "check"]),
  go: new Set(["build", "test", "vet"]),
  zig: new Set(["build", "test"]),
  make: null,
  pytest: null,
  tsc: null,
  biome: null,
  eslint: null,
};
const DANGER_TOKENS = new Set(["publish", "deploy", "release", "push"]);
const GIT_REVERSIBLE = new Set(["add", "commit", "stash", "fetch", "pull"]);

function reversibleSegment(argv: string[]): boolean {
  const [head, ...args] = argv;
  if (!head || args.some((a) => DANGER_TOKENS.has(a))) return false;
  if (head === "git") {
    const sub = args[0];
    if (sub === "checkout") return args[1] === "-b";
    if (sub === "switch") return args[1] === "-c";
    if (sub === "stash") return args[1] !== "drop" && args[1] !== "clear";
    return sub !== undefined && GIT_REVERSIBLE.has(sub);
  }
  if (head === "prettier") return args.includes("--check") && !args.includes("--write") && !args.includes("-w");
  if (head === "yarn" || head === "pnpm") return args.length === 0 || NPM_LIKE.has(args[0]!);
  if (!Object.hasOwn(REVERSIBLE_SUBCOMMANDS, head)) return false;
  const subs = REVERSIBLE_SUBCOMMANDS[head] ?? null;
  return subs === null || (args[0] !== undefined && subs.has(args[0]));
}

const DANGER_HEADS: Record<string, ApprovalReason> = {
  rm: "filesystem_write",
  chmod: "filesystem_write",
  chown: "filesystem_write",
  dd: "filesystem_write",
  mkfs: "filesystem_write",
  sudo: "process_or_system",
  kill: "process_or_system",
  killall: "process_or_system",
  pkill: "process_or_system",
  reboot: "process_or_system",
  shutdown: "process_or_system",
  curl: "network_access",
  wget: "network_access",
  ssh: "network_access",
  scp: "network_access",
};

/**
 * direct_read_only: every segment is static and on the read-only allowlist (pipes allowed).
 * reversible: every segment is static, joined only by `&&`, and each is read-only or a known
 * build/test/VCS-local command. Anything else requires approval (or review in auto mode).
 */
export function classifyCommand(command: string): CommandClass {
  const trimmed = command.trim();
  if (trimmed.length === 0) return { kind: "approval_required", reason: "unknown_command" };
  if (Buffer.byteLength(trimmed) > MAX_COMMAND_BYTES)
    return { kind: "approval_required", reason: "unsupported_argument" };
  if (/[\r\n]/.test(trimmed)) return { kind: "approval_required", reason: "unsupported_shell" };
  const segments = splitSegments(trimmed);
  if (!segments.every((s) => isStaticCommand(s.text))) return { kind: "approval_required", reason: "dynamic_shell" };
  let reversible = false;
  for (const segment of segments) {
    const argv = words(segment.text);
    if (readOnlySegment(argv)) continue;
    if (!reversibleSegment(argv)) {
      const head = argv[0] ?? "";
      return { kind: "approval_required", reason: DANGER_HEADS[head] ?? "unknown_command" };
    }
    reversible = true;
  }
  if (reversible && segments.some((s) => s.operator !== "" && s.operator !== "&&")) {
    return { kind: "approval_required", reason: "unsupported_shell" };
  }
  return { kind: reversible ? "reversible" : "direct_read_only" };
}

/** Auto mode runs these without review: ordinary development commands inside the workspace. */
export function knownReversibleAutoCommand(command: string, cwdInsideWorkspace: boolean): boolean {
  if (!cwdInsideWorkspace) return false;
  const kind = classifyCommand(command).kind;
  return kind === "direct_read_only" || kind === "reversible";
}
