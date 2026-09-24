/** Install source forms: pasted `npx skills add`, skills.sh URLs, owner/repo@skill, git URLs, local dirs. */
import { isAbsolute } from "node:path";

export type ParsedSource = { source: string; filter?: string };

function looksLikeInstallCommand(input: string): boolean {
  return (input.startsWith("npx ") || input.startsWith("bunx ")) && input.includes("skills add");
}

function parseNpx(input: string): ParsedSource | null {
  if (!looksLikeInstallCommand(input)) return null;
  const parts = input.split(/\s+/).filter(Boolean);
  let source: string | undefined;
  let filter: string | undefined;
  for (let i = 0; i < parts.length; i++) {
    const t = parts[i] as string;
    if (["npx", "bunx", "skills", "add", "-g", "-y", "--yes"].includes(t)) continue;
    if (t === "--skill") {
      filter = parts[++i];
      if (filter === undefined) return null;
      continue;
    }
    if (t.startsWith("--skill=")) {
      filter = t.slice(8);
      continue;
    }
    if (t.startsWith("-")) continue;
    source ??= t;
  }
  return source ? { source, filter } : null;
}

function parseSkillsSh(input: string): ParsedSource | null {
  const marker = input.indexOf("skills.sh/");
  if (marker < 0) return null;
  const [owner, repo, skill] = input
    .slice(marker + "skills.sh/".length)
    .split("/")
    .filter(Boolean);
  if (!owner || !repo) return null;
  return { source: `${owner}/${repo}`, filter: skill };
}

function parseRepoAt(input: string): ParsedSource | null {
  if (/^(https?:\/\/|git@)/.test(input) || isAbsolute(input) || /^(\.\.?\/|~\/)/.test(input)) return null;
  const at = input.lastIndexOf("@");
  if (at <= 0 || at + 1 >= input.length) return null;
  const slash = input.lastIndexOf("/", at);
  if (slash <= 0) return null;
  return { source: input.slice(0, at), filter: input.slice(at + 1) };
}

export function parseInstallSource(input: string, explicitFilter?: string): ParsedSource {
  const trimmed = input.trim();
  const parsed = parseNpx(trimmed) ?? parseSkillsSh(trimmed) ?? parseRepoAt(trimmed) ?? { source: trimmed };
  const filters = [parsed.filter, explicitFilter].filter((f): f is string => !!f);
  if (filters.length === 2 && filters[0] !== filters[1]) throw new Error("ConflictingSkillInstallFilter");
  return { source: parsed.source, filter: filters[0] };
}

export function cloneUrlFor(source: string): string {
  return /^(https?:\/\/|git@)/.test(source) ? source : `https://github.com/${source}.git`;
}

export { looksLikeInstallCommand };
