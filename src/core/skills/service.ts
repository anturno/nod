/** The SkillService the tools use, backed by discovery and the managed directory. */
import { readFileSync, statSync } from "node:fs";
import { join, normalize, resolve, sep } from "node:path";
import { searchSkills } from "./catalog.ts";
import { discoverSkills } from "./discover.ts";
import { installSkills } from "./manage.ts";
import type { Skill, SkillService } from "./types.ts";

export const MAX_SKILL_FILE_BYTES = 1024 * 1024;

export function createSkillService(d: { home: string; workspaceRoot: string; cwd?: string }): SkillService & {
  refresh(): void;
  diagnostics(): string[];
} {
  let found = discoverSkills(d);
  return {
    refresh() {
      found = discoverSkills(d);
    },
    diagnostics: () => found.diagnostics,
    list: () => found.skills,
    search: (query) => searchSkills(found.skills, query),
    async read(location, resource) {
      const skill: Skill | undefined =
        found.skills.find((s) => s.location === location) ??
        (found.skills.filter((s) => s.name === location).length === 1
          ? found.skills.find((s) => s.name === location)
          : undefined);
      if (!skill) return { ok: false, error: `skill not found: ${location}. Use the exact advertised location.` };
      const rel = resource && resource.length > 0 ? resource : "SKILL.md";
      const target = resolve(skill.dir, normalize(rel));
      if (!target.startsWith(skill.dir + sep) || rel.split(/[\\/]/).includes(".."))
        return { ok: false, error: `resource must be a relative path inside the skill: ${rel}` };
      try {
        const st = statSync(target);
        if (!st.isFile()) return { ok: false, error: `not a file: ${rel}` };
        if (st.size > MAX_SKILL_FILE_BYTES)
          return { ok: false, error: `skill file exceeds ${MAX_SKILL_FILE_BYTES} bytes: ${rel}` };
        const bytes = readFileSync(target);
        return { ok: true, text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
      } catch (e) {
        return { ok: false, error: `could not read ${join(skill.dir, rel)}: ${(e as Error).message}` };
      }
    },
    async install(source, filter) {
      const result = await installSkills({ home: d.home, cwd: d.cwd ?? d.workspaceRoot }, source, filter);
      found = discoverSkills(d);
      return { installed: result.installed, error: result.error };
    },
  };
}
