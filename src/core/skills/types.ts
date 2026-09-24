/** Skill discovery and loading as seen by the tools and the UIs. */

export type SkillSource = "workspace" | "user" | "managed";
export type Skill = { name: string; description: string; dir: string; location: string; source: SkillSource };

export type SkillService = {
  list(): Skill[];
  /** The complete SKILL.md, or a relative text resource inside the skill. */
  read(location: string, resource?: string): Promise<{ ok: true; text: string } | { ok: false; error: string }>;
  install(source: string, filter?: string): Promise<{ installed: string[]; error?: string }>;
  /** Lexical search over name and description. */
  search(query: string): { skill: Skill; score: number }[];
};
