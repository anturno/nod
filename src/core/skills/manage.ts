/** Managed skills under ~/.nod/skills: install from a repo or directory, create, remove. */
import {
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { managedSkillsDir } from "./discover.ts";
import { parseSkillFile, validSkillName } from "./frontmatter.ts";
import { cloneUrlFor, parseInstallSource } from "./source.ts";

export type InstallResult = { installed: string[]; skipped: string[]; error?: string };

function findSkillDirs(root: string): string[] {
  if (existsSync(join(root, "SKILL.md"))) return [root];
  const out: string[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > 6) return;
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith(".git") || entry.name === "node_modules") continue;
      if (!entry.isDirectory()) continue;
      const child = join(dir, entry.name);
      if (existsSync(join(child, "SKILL.md"))) out.push(child);
      else walk(child, depth + 1);
    }
  };
  walk(root, 0);
  return out.sort();
}

export type InstallDeps = {
  home: string;
  cwd: string;
  clone?: (url: string, dest: string) => Promise<{ ok: boolean; error?: string }>;
};

async function defaultClone(url: string, dest: string): Promise<{ ok: boolean; error?: string }> {
  const proc = Bun.spawn(["git", "clone", "--depth", "1", url, dest], { stdout: "ignore", stderr: "pipe" });
  const stderr = await new Response(proc.stderr).text();
  const code = await proc.exited;
  return code === 0 ? { ok: true } : { ok: false, error: stderr.trim().split("\n").at(-1) ?? `git exited ${code}` };
}

export async function installSkills(
  deps: InstallDeps,
  rawSource: string,
  explicitFilter?: string,
): Promise<InstallResult> {
  const { source, filter } = parseInstallSource(rawSource, explicitFilter);
  const local = resolve(deps.cwd, source);
  let root: string;
  let temp: string | undefined;
  if (existsSync(local) && lstatSync(local).isDirectory()) root = local;
  else {
    temp = mkdtempSync(join(tmpdir(), "nod-skill-"));
    root = join(temp, "repo");
    const clone = await (deps.clone ?? defaultClone)(cloneUrlFor(source), root);
    if (!clone.ok) {
      rmSync(temp, { recursive: true, force: true });
      return { installed: [], skipped: [], error: clone.error ?? "clone failed" };
    }
  }
  try {
    const installed: string[] = [];
    const skipped: string[] = [];
    const managed = managedSkillsDir(deps.home);
    mkdirSync(managed, { recursive: true });
    for (const dir of findSkillDirs(root)) {
      const parsed = parseSkillFile(readFileSync(join(dir, "SKILL.md")));
      if (parsed.status === "invalid") {
        skipped.push(dir);
        continue;
      }
      const name = parsed.status === "valid" ? parsed.name : basename(dir);
      if (filter && name !== filter) continue;
      if (!validSkillName(name)) {
        skipped.push(dir);
        continue;
      }
      const staging = join(managed, `.${name}.${process.pid}.tmp`);
      rmSync(staging, { recursive: true, force: true });
      cpSync(dir, staging, { recursive: true, filter: (src) => !basename(src).startsWith(".git") });
      const dest = join(managed, name);
      rmSync(dest, { recursive: true, force: true });
      renameSync(staging, dest);
      installed.push(name);
    }
    return { installed, skipped };
  } finally {
    if (temp) rmSync(temp, { recursive: true, force: true });
  }
}

export function createSkill(home: string, name: string): string {
  if (!validSkillName(name)) throw new Error(`invalid skill name: ${name}`);
  const dir = join(managedSkillsDir(home), name);
  if (existsSync(dir)) throw new Error(`skill already exists: ${dir}`);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "SKILL.md"),
    `---\nname: ${name}\ndescription: Use this when a request needs...\n---\n\n# ${name}\n\nInstructions for the agent.\n`,
  );
  return dir;
}

export function removeSkill(home: string, name: string): boolean {
  if (!validSkillName(name)) return false;
  const dir = join(managedSkillsDir(home), name);
  if (!resolve(dir).startsWith(resolve(managedSkillsDir(home)))) return false;
  if (!existsSync(dir)) return false;
  rmSync(dir, { recursive: true, force: true });
  return true;
}
