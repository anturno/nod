/** The slash menu over the SLASH registry: category tabs, search, completion, and parsing of a typed command. */
import {
  looksLikeSlashCommand,
  matchSlash,
  SLASH,
  SLASH_CATEGORIES,
  type SlashCategory,
  type SlashSpec,
  searchSlash,
} from "../../cli/commands.ts";

export type SlashTab = SlashCategory | null;
/** null is the "All" tab. */
export const SLASH_TABS: SlashTab[] = [null, ...SLASH_CATEGORIES];
export const tabLabel = (tab: SlashTab) => tab ?? "All";

export function cycleTab(tab: SlashTab, by: 1 | -1): SlashTab {
  const i = SLASH_TABS.indexOf(tab);
  return SLASH_TABS[(i + by + SLASH_TABS.length) % SLASH_TABS.length] as SlashTab;
}

export const slashRows = (prefix: string, tab: SlashTab): SlashSpec[] => searchSlash(prefix, tab);
export const slashTitle = (count: number) => `Commands ${count}`;

/** The command (with a trailing space when it takes arguments) when exactly one command or alias starts with `prefix`. */
export function completeSlash(prefix: string): string | null {
  const hits = SLASH.filter((s) => [s.command, ...s.aliases].some((t) => t.startsWith(prefix)));
  const spec = hits[0];
  if (hits.length !== 1 || !spec) return null;
  const token = [spec.command, ...spec.aliases].find((t) => t.startsWith(prefix)) as string;
  return spec.hasArgs ? `${token} ` : token;
}

export type ParsedSlash =
  | { kind: "command"; spec: SlashSpec; token: string; rest: string }
  | { kind: "unknown"; token: string }
  | { kind: "prompt" };

/** `/word` is a command, `/src/x.ts` is a prompt. */
export function parseSlash(text: string): ParsedSlash {
  const match = matchSlash(text);
  if (match) return { kind: "command", ...match };
  if (looksLikeSlashCommand(text)) return { kind: "unknown", token: text.trim().split(/\s+/)[0] as string };
  return { kind: "prompt" };
}

export const unknownCommandNotice = (token: string) => `Unknown command ${token}. Type / to see all commands.`;

export function helpText(): string {
  const width = Math.max(...SLASH.map((s) => s.help.length));
  const lines: string[] = [];
  for (const category of SLASH_CATEGORIES) {
    const specs = SLASH.filter((s) => s.category === category);
    if (specs.length === 0) continue;
    lines.push(category);
    for (const s of specs) lines.push(`  ${s.help.padEnd(width)}  ${s.description}`);
  }
  lines.push(
    "",
    "shift+enter newline · enter steer the active turn · esc cancel · ctrl+o transcript · shift+tab permission mode · ctrl+c twice exit",
  );
  return lines.join("\n");
}
