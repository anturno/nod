/** Finds skills under the workspace ancestry and the user roots. A skill is a directory with SKILL.md. */
import { lstatSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { parseSkillFile } from "./frontmatter.ts";
import type { Skill, SkillSource } from "./types.ts";

export const WORKSPACE_ROOTS = [
  "skills",
  ".opencode/skills",
  ".codex/skills",
  ".claude/skills",
  ".agents/skills",
  ".claw/skills",
];
export const USER_ROOTS = [
  ".nod/skills",
  ".config/opencode/skills",
  ".codex/skills",
  ".claude/skills",
  ".agents/skills",
  ".claw/skills",
];

const inside = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

export function managedSkillsDir(home: string): string {
  return join(home, ".nod", "skills");
}

function scanRoot(root: string, source: SkillSource, diagnostics: string[]): Skill[] {
  let entries: string[];
  try {
    if (!lstatSync(root).isDirectory()) return [];
    entries = readdirSync(root).sort();
  } catch {
    return [];
  }
  const out: Skill[] = [];
  for (const entry of entries) {
    const dir = join(root, entry);
    const file = join(dir, "SKILL.md");
    let bytes: Buffer;
    try {
      if (!lstatSync(dir).isDirectory() || !lstatSync(file).isFile()) continue;
      bytes = readFileSync(file);
    } catch {
      continue;
    }
    const parsed = parseSkillFile(bytes);
    if (parsed.status === "invalid") {
      diagnostics.push(`[skills] skipped ${file}: ${parsed.cause}`);
      continue;
    }
    const name = parsed.status === "valid" ? parsed.name : basename(dir);
    const description = parsed.status === "valid" ? parsed.description : "";
    out.push({ name, description, dir, location: dir, source });
  }
  return out;
}

export function discoverSkills(d: { home?: string; workspaceRoot: string }): {
  skills: Skill[];
  diagnostics: string[];
} {
  const diagnostics: string[] = [];
  const skills: Skill[] = [];
  const workspace = resolve(d.workspaceRoot);
  const home = d.home ? resolve(d.home) : undefined;
  const dirs: string[] = [];
  for (let dir = workspace; ; dir = dirname(dir)) {
    if (home !== undefined && (dir === home || !inside(home, dir))) break;
    dirs.push(dir);
    if (home === undefined || dirname(dir) === dir) break;
  }
  for (const dir of dirs)
    for (const root of WORKSPACE_ROOTS) skills.push(...scanRoot(join(dir, root), "workspace", diagnostics));
  if (home)
    for (const root of USER_ROOTS)
      skills.push(...scanRoot(join(home, root), root === ".nod/skills" ? "managed" : "user", diagnostics));
  // The same directory reachable twice (workspace under HOME sharing a root) counts once.
  const seen = new Set<string>();
  return { skills: skills.filter((s) => !seen.has(s.dir) && seen.add(s.dir)), diagnostics };
}
