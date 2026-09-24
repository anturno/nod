/** The bounded skill list the model sees, and lexical search over it. */
import type { Skill } from "./types.ts";

/** Explicit limit wins; else 2% of the context window (×4 bytes); else 8000 characters. */
export function catalogBudgetBytes(explicit: number | undefined, contextWindow: number | undefined): number {
  if (explicit !== undefined) return explicit;
  if (contextWindow !== undefined)
    return Math.min(Math.max(1, Math.floor((contextWindow * 2) / 100)) * 4, 64 * 1024 * 1024);
  return 8000;
}

const cap = (text: string, bytes: number) => {
  const buf = Buffer.from(text);
  if (buf.length <= bytes) return text;
  let end = bytes;
  while (end > 0 && ((buf[end] as number) & 0xc0) === 0x80) end--;
  return `${buf.subarray(0, end).toString()}…`;
};

export function renderCatalog(skills: Skill[], o: { budgetBytes: number; descriptionBytes: number }): string {
  if (skills.length === 0) return "";
  const header = "Skills available through the skill tool (load with the exact location):\n";
  let out = header;
  let listed = 0;
  for (const s of skills) {
    const line = `- ${s.name} (${s.location}): ${cap(s.description.replace(/\s+/g, " ").trim(), o.descriptionBytes)}\n`;
    if (Buffer.byteLength(out) + Buffer.byteLength(line) > o.budgetBytes) break;
    out += line;
    listed++;
  }
  if (listed < skills.length)
    out += `- … ${skills.length - listed} more skill(s) not listed; use capability_search to find them.\n`;
  return out.trimEnd();
}

const tokens = (s: string) =>
  s
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);

export function searchSkills(skills: Skill[], query: string): { skill: Skill; score: number }[] {
  const q = tokens(query);
  if (q.length === 0) return [];
  return skills
    .map((skill) => {
      const name = tokens(skill.name);
      const desc = tokens(skill.description);
      let score = 0;
      for (const t of q) {
        if (name.includes(t)) score += 3;
        else if (name.some((n) => n.includes(t))) score += 2;
        if (desc.includes(t)) score += 1;
      }
      return { skill, score };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name));
}
