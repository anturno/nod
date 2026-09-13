/** The top-level command table, its help, and the slash-command registry. Mirrors fx builtins/commands.zig. */

export type OptionDoc = { flag: string; description: string };
export type TopLevelSpec = {
  token: string;
  aliases?: string[];
  usage: string;
  summary: string;
  options?: OptionDoc[];
  details?: string[];
  hidden?: boolean;
};

const json: OptionDoc = { flag: "--json", description: "Emit machine-readable JSON instead of text" };

export const TOP_LEVEL: TopLevelSpec[] = [
  { token: "help", aliases: ["--help", "-h"], usage: "help", summary: "Show this help" },
  {
    token: "ask",
    usage:
      "ask [--auto|--full-access] [--image PATH] [--system TEXT] [--json] [--quiet] [--prompt-permissions] [--no-save] [--no-color] [--resume <last|id>|--resume-id <id>] [--continue-recovery] [--] <prompt>",
    summary: "Run one noninteractive request",
    options: [
      { flag: "--auto", description: "Automatically review unresolved permission requests" },
      { flag: "--full-access", description: "Disable nod permission checks" },
      { flag: "--yolo", description: "Alias for --full-access" },
      { flag: "--image PATH", description: "Attach an image file; repeat for multiple images" },
      { flag: "--system TEXT", description: "Replace the built-in system prompt for this request" },
      json,
      { flag: "--quiet", description: "Suppress assistant output" },
      { flag: "--prompt-permissions", description: "Prompt for Y/N permission approval when stdin is a TTY" },
      { flag: "--no-save", description: "Do not save the session; incompatible with --resume and --resume-id" },
      { flag: "--no-color", description: "Render TTY output without colors or hyperlinks" },
      { flag: "--resume <last|id>", description: "Continue the last session or a session by id" },
      { flag: "--resume-id <id>", description: "Continue a session by exact id" },
      { flag: "--continue-recovery", description: "Resume the paused model response in the selected session" },
      { flag: "--", description: "Treat every following argument as prompt text" },
    ],
    details: [
      "The prompt may be passed as arguments or piped on stdin when no prompt args are given.",
      "TTY stdout uses the Minimal transcript presentation; redirected stdout emits raw assistant Markdown.",
      "Operational progress and diagnostics are written to stderr. JSON `output` keeps accumulated assistant Markdown; `final_output` contains only the completed final response, or an empty string when absent.",
      "JSON usage sums reported main-agent input_tokens and output_tokens, including with --no-save; unreported counts are null. Nested usage and dollar spend are excluded.",
      "--system replaces only the built-in base prompt for this request; tool, skill, project, and runtime context still apply.",
      "With --prompt-permissions, JSON and quiet requests may prompt on stderr only when stdin is a TTY.",
    ],
  },
  {
    token: "acp",
    usage: "acp [--model <id>] [--log-file <path>]",
    summary: "Start an ACP server over stdio",
    options: [
      { flag: "--model <id>", description: "Override the default model" },
      { flag: "--log-file <path>", description: "Write ACP logs to a file" },
    ],
  },
  {
    token: "pr",
    usage: "pr [--auto] [--create] [context]",
    summary: "Draft or publish a pull request",
    options: [
      { flag: "--auto", description: "Automatically review unresolved permission requests" },
      { flag: "--create", description: "Publish the drafted pull request via the GitHub CLI" },
    ],
    details: ["Must run inside a git repository. Without --create, the drafted PR is printed only."],
  },
  {
    token: "issue",
    usage: "issue [--auto] [--create] [context]",
    summary: "Draft or publish a GitHub issue",
    options: [
      { flag: "--auto", description: "Automatically review unresolved permission requests" },
      { flag: "--create", description: "Publish the drafted issue via the GitHub CLI" },
    ],
  },
  { token: "login", usage: "login [codex|grok]", summary: "Sign in to a selected provider" },
  { token: "logout", usage: "logout [codex|grok]", summary: "Sign out of a selected provider session" },
  { token: "status", usage: "status [--json]", summary: "Show configuration and runtime information", options: [json] },
  {
    token: "permissions",
    usage: "permissions [--json]",
    summary: "Show the permission mode and rules",
    options: [json],
    details: [
      "Modes:",
      "  ask          Prompt before sensitive tool calls",
      "  auto         Apply rules, then review unresolved sensitive tool calls (default)",
      "  full-access  Disable nod permission checks",
      "",
      "Change the mode from the interactive shell with `/permissions [ask|auto|full-access|reset]`,",
      "and manage persistent allow rules with `/allowlist`.",
    ],
  },
  {
    token: "mcp",
    usage: "mcp <command> ...",
    summary: "Manage MCP servers without opening the interactive shell",
    details: [
      "Commands:",
      "  nod mcp add NAME COMMAND [ARGS...]",
      "  nod mcp add --transport http NAME URL",
      "  nod mcp auth NAME [--open]",
      "  nod mcp list [--connect]",
      "  nod mcp logout NAME",
      "  nod mcp path",
      "  nod mcp remove NAME",
      "  nod mcp trust approve|reject NAME",
      "  nod mcp trust approve-all|reset",
      "",
      "By default, list reads configuration without opening MCP transports.",
      "Use --connect to connect and discover servers before rendering health.",
    ],
  },
  { token: "models", usage: "models [--json]", summary: "List available models", options: [json] },
  { token: "provider", usage: "provider <codex|grok>", summary: "Choose the model provider used by nod" },
  { token: "doctor", usage: "doctor [--json]", summary: "Run local health and preflight checks", options: [json] },
  {
    token: "session",
    usage:
      "session <last|id>|--id <id> [--json] | session resume [last|<id>] | session resume --id <id> | session migrate <id>|--id <id> [--allow-large] [--json] | session recover <id>|--id <id> [--json]",
    summary: "Inspect, resume, migrate, or recover saved sessions",
    options: [
      { flag: "last", description: "Inspect the current workspace session" },
      { flag: "--id <id>", description: "Inspect a saved session by exact id" },
      { flag: "resume [last|<id>]", description: "Resume the latest workspace session or a session by id" },
      { flag: "migrate <id>", description: "Migrate a saved session to the current format" },
      { flag: "recover <id>", description: "Copy a recoverable corrupt session into a new session" },
      { flag: "--allow-large", description: "Permit migrating an oversized session" },
      json,
    ],
  },
  {
    token: "sessions",
    usage: "sessions [--all] [--limit <1-100>] [--cursor <cursor>] [--json]",
    summary: "List saved sessions for the current workspace",
    options: [
      { flag: "--all", description: "List saved sessions across every workspace in this profile" },
      { flag: "--limit <1-100>", description: "Set the maximum sessions returned per page" },
      { flag: "--cursor <cursor>", description: "Continue from a prior sessions result" },
      json,
    ],
  },
  {
    token: "resume",
    aliases: ["--resume", "--resume-last", "--continue", "-c", "-r"],
    hidden: true,
    usage:
      "session resume [last|<id>] | session resume --id <id> | --resume [last|<id>] | resume [last|<id>] | resume --id <id> | --resume-last | --continue | -c | -r | --resume-<id>",
    summary: "Continue a saved interactive session",
    options: [
      { flag: "-r", description: "Choose the session to resume from a picker" },
      { flag: "last", description: "Resume the most recent session" },
      { flag: "<id>", description: "Resume a session by id" },
      { flag: "--id <id>", description: "Resume a session by exact id" },
    ],
  },
  {
    token: "usage",
    usage: "usage [--period <24h|7d|30d>] [--json]",
    summary: "Show local nod token usage and spend",
    options: [{ flag: "--period <24h|7d|30d>", description: "Select a rolling window (default: 30d)" }, json],
    details: ["Reports only usage recorded by nod on this machine."],
  },
  {
    token: "upgrade",
    usage: "upgrade [--channel <stable|dev>] [--json]",
    summary: "Upgrade nod on the selected release channel",
    options: [{ flag: "--channel <stable|dev>", description: "Select and remember the release channel" }, json],
  },
  {
    token: "workspace",
    usage: "workspace [list|add PATH|remove PATH|clear] [--json]",
    summary: "Manage additional workspace directories",
    options: [
      { flag: "list", description: "List the primary and additional directories (default)" },
      { flag: "add PATH", description: "Persist an existing additional directory" },
      { flag: "remove PATH", description: "Remove an additional directory" },
      { flag: "clear", description: "Remove all additional directories" },
      json,
    ],
    details: ["Additional directories are stored for the current primary workspace."],
  },
];

type HelpEntry = { usage: string; summary?: string; token?: string };
const HELP_GROUPS: HelpEntry[][] = [
  [{ token: "ask", usage: "ask <prompt>" }],
  [
    { token: "pr", usage: "pr [context]" },
    { token: "issue", usage: "issue [context]" },
  ],
  [
    { token: "sessions", usage: "sessions" },
    { token: "session", usage: "session <last|id>" },
    { usage: "session resume [last|id]", summary: "Resume the latest workspace session or a session by id" },
    { usage: "session migrate <id>", summary: "Migrate a saved session to the current format" },
    { usage: "session recover <id>", summary: "Copy a recoverable corrupt session" },
  ],
  [
    { token: "login", usage: "login [codex|grok]", summary: "Sign in to a model provider" },
    { token: "logout", usage: "logout [codex|grok]", summary: "Sign out of a model provider" },
    { token: "provider", usage: "provider <codex|grok>", summary: "Choose the active model provider" },
    { token: "models", usage: "models" },
  ],
  [{ token: "usage", usage: "usage [--period <24h|7d|30d>]", summary: "Show locally recorded token usage and spend" }],
  [
    { token: "status", usage: "status" },
    { token: "doctor", usage: "doctor" },
    { token: "mcp", usage: "mcp <command> ..." },
    { token: "permissions", usage: "permissions" },
    { token: "workspace", usage: "workspace" },
    { token: "upgrade", usage: "upgrade", summary: "Upgrade nod on the selected release channel" },
    { token: "acp", usage: "acp" },
    { token: "help", usage: "help" },
  ],
];

const FLAGS: OptionDoc[] = [
  { flag: "--context-limit <spec>", description: "Set name=bytes|off; repeatable" },
  { flag: "--add-dir <path>", description: "Add a workspace directory; repeatable" },
  { flag: "--no-additional-dirs", description: "Ignore saved additional directories" },
  { flag: "--full-access", description: "Disable nod permission checks for this process" },
  { flag: "-c, --continue", description: "Resume the remembered workspace session" },
  { flag: "-r", description: "Open the saved-session picker" },
  { flag: "--resume [last|<id>]", description: "Resume the latest workspace session or an exact ID" },
  { flag: "--resume-last", description: "Resume the latest workspace session" },
  { flag: "--resume-<id>", description: "Resume a session by exact ID" },
  { flag: "-h, --help", description: "Display this help and exit" },
  { flag: "-v, --version", description: "Print the nod version and exit" },
];

const EXAMPLES = [
  ["nod", "Start a fresh interactive session"],
  ['nod ask "Explain the changes in this repository"', "Run one request and exit"],
  ["nod session resume last", "Continue the latest session for this workspace"],
  ["nod status --json", "Inspect the current configuration as JSON"],
];

export const DOCS_URL = "https://nod.anturno.cloud/docs";

export function findTopLevel(token: string): TopLevelSpec | undefined {
  return TOP_LEVEL.find((s) => s.token === token || s.aliases?.includes(token));
}

const pad = (s: string, width: number) => s + " ".repeat(Math.max(0, width - s.length));

export function renderTopLevelHelp(version: string): string {
  const entries = HELP_GROUPS.flat();
  const usageWidth = Math.max(...entries.map((e) => e.usage.length));
  const flagWidth = Math.max(...FLAGS.map((f) => f.flag.length));
  const lines: string[] = [
    `nod v${version}`,
    "Fast coding agent for the terminal.",
    "",
    "nod starts an interactive session by default. Use `nod ask` to run one noninteractive request.",
    "",
    "Usage:",
    "  nod [flags]",
    "  nod <command> [...flags] [...args]",
    "",
    "Commands:",
  ];
  HELP_GROUPS.forEach((group, i) => {
    if (i > 0) lines.push("");
    for (const e of group) {
      const summary = e.summary ?? (e.token ? findTopLevel(e.token)?.summary : "") ?? "";
      lines.push(`  ${pad(e.usage, usageWidth)}  ${summary}`);
    }
  });
  lines.push("", "Flags:");
  for (const f of FLAGS) lines.push(`  ${pad(f.flag, flagWidth)}  ${f.description}`);
  lines.push("", "Examples:");
  for (const [command, description] of EXAMPLES) lines.push(`  ${command}`, `      ${description}`);
  lines.push(
    "",
    "Run `nod <command> --help` for command-specific usage and options.",
    "Run `/help` inside an interactive session for slash commands.",
    "",
    `Learn more about nod:  ${DOCS_URL}`,
    "Report a problem:      run `/feedback` inside nod",
  );
  return `${lines.join("\n")}\n`;
}

export function renderCommandHelp(spec: TopLevelSpec): string {
  const lines = [`nod ${spec.token}`, "", spec.summary, "", "Usage:", `  nod ${spec.usage}`];
  if (spec.options?.length) {
    const width = Math.max(...spec.options.map((o) => o.flag.length));
    lines.push("", "Options:");
    for (const o of spec.options) lines.push(`  ${pad(o.flag, width)}  ${o.description}`);
  }
  if (spec.details?.length) lines.push("", ...spec.details);
  return `${lines.join("\n")}\n`;
}

export type SlashCategory =
  | "General"
  | "Session"
  | "Account"
  | "Model"
  | "Appearance"
  | "Security"
  | "Media"
  | "Extensions"
  | "Workspace"
  | "Product";
export const SLASH_CATEGORIES: SlashCategory[] = [
  "General",
  "Session",
  "Account",
  "Model",
  "Appearance",
  "Security",
  "Media",
  "Extensions",
  "Workspace",
  "Product",
];

export type SlashSpec = {
  command: string;
  aliases: string[];
  help: string;
  description: string;
  category: SlashCategory;
  hasArgs: boolean;
  welcome: boolean;
};

const slash = (
  command: string,
  category: SlashCategory,
  description: string,
  o: { aliases?: string[]; help?: string; hasArgs?: boolean; welcome?: boolean } = {},
): SlashSpec => ({
  command,
  aliases: o.aliases ?? [],
  help: o.help ?? command,
  description,
  category,
  hasArgs: o.hasArgs ?? false,
  welcome: o.welcome ?? false,
});

/** Exact fx order (builtins/commands.zig slash_specs) minus the Gateway-only entries. */
export const SLASH: SlashSpec[] = [
  slash("/help", "General", "Show interactive help", { welcome: true }),
  slash("/clear", "General", "Start a fresh session and keep workspace background processes", { welcome: true }),
  slash("/new", "Session", "Start a fresh session", { welcome: true }),
  slash("/reset", "Session", "Start a fresh session, then stop and forget workspace background processes"),
  slash("/resume", "Session", "Open the saved-session picker"),
  slash("/continue", "Session", "Continue a paused model response"),
  slash("/rename", "Session", "Rename the current session", { help: "/rename <title>", hasArgs: true }),
  slash("/login", "Account", "Open the provider picker, or sign in to a named provider", { hasArgs: true }),
  slash("/logout", "Account", "Sign out of the active or named provider", {
    help: "/logout [codex|grok]",
    hasArgs: true,
  }),
  slash("/provider", "Account", "Choose a provider", { hasArgs: true }),
  slash("/stats", "Account", "Show current-session statistics"),
  slash("/usage", "Account", "Open local usage and spend", { aliases: ["/cost"], help: "/usage (/cost)" }),
  slash("/status", "General", "Show model, workspace, permissions, and session state", { welcome: true }),
  slash("/image", "Media", "Attach an image", { aliases: ["/img"], help: "/image <path> (/img)", hasArgs: true }),
  slash("/images", "Media", "Inspect or clear pending images", { help: "/images [clear]", hasArgs: true }),
  slash("/model", "Model", "Select a model by ID or query", { help: "/model <id-or-query>", hasArgs: true }),
  slash("/permissions", "Security", "Inspect or change the permission mode", {
    help: "/permissions [ask|auto|full-access|reset]",
    hasArgs: true,
    welcome: true,
  }),
  slash("/allowlist", "Security", "Inspect or change persistent permission rules", {
    help: "/allowlist [view [effective|local|user]|[local|user] add|remove|reset ...]",
    hasArgs: true,
    welcome: true,
  }),
  slash("/undo", "Session", "Undo the most recent tracked file operation"),
  slash("/mcp", "Extensions", "Browse MCP servers, tools, resources, and prompts", {
    help: "/mcp [list|resource|prompt|add|remove|path|reload|auth|logout|trust]",
    hasArgs: true,
  }),
  slash("/skills", "Extensions", "Browse and manage skills", {
    help: "/skills [list|add|install|show|create|remove|path] [name|url|path] ($ opens skill search)",
    hasArgs: true,
  }),
  slash("/copy", "Session", "Copy the latest assistant response"),
  slash("/feedback", "Product", "Open the nod bug report form", { welcome: true }),
  slash("/compact", "Session", "Compact older conversation turns now"),
  slash("/settings", "Appearance", "Open settings or change startup scrollback", {
    help: "/settings [startup-scrollback [on|off]]",
    hasArgs: true,
  }),
  slash("/paste", "Media", "Attach a clipboard image when supported"),
  slash("/fast", "Model", "Toggle fast mode when supported"),
  slash("/statusline", "Appearance", "Toggle footer fields", {
    help: "/statusline [context|session|workspace]",
    hasArgs: true,
  }),
  slash("/sound", "Appearance", "Set completion sounds", { help: "/sound [on|off|max]", hasArgs: true }),
  slash("/workspace", "Workspace", "Manage saved additional directories", {
    help: "/workspace [list|add PATH|remove PATH|clear]",
    hasArgs: true,
    welcome: true,
  }),
  slash("/version", "General", "Show the installed version"),
  slash("/quit", "General", "Exit nod", { aliases: ["/exit"], welcome: true }),
];

/** Exact token match on the first whitespace-delimited word; the rest is the argument text. */
export function matchSlash(input: string): { spec: SlashSpec; token: string; rest: string } | null {
  const trimmed = input.trimStart();
  if (!trimmed.startsWith("/")) return null;
  const match = /^(\S+)(?:[ \t]+([\s\S]*))?$/.exec(trimmed);
  if (!match) return null;
  const token = match[1] as string;
  const spec = SLASH.find((s) => s.command === token || s.aliases.includes(token));
  return spec ? { spec, token, rest: (match[2] ?? "").trim() } : null;
}

/** A path like /src/app.ts is a prompt, a single word is a command. */
export function looksLikeSlashCommand(input: string): boolean {
  return /^\/[\w-]+(\s|$)/.test(input.trimStart());
}

export function searchSlash(query: string, category: SlashCategory | null = null): SlashSpec[] {
  const q = query.replace(/^\//, "").toLowerCase();
  const tokens = q.split(/\s+/).filter(Boolean);
  return SLASH.filter((s) => {
    if (category && s.category !== category) return false;
    if (tokens.length === 0) return true;
    const hay = [s.command, ...s.aliases, s.description, s.category].join(" ").toLowerCase();
    return tokens.every((t) => hay.includes(t));
  });
}
