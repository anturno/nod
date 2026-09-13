import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { catalogBudgetBytes, renderCatalog, searchSkills } from "../../src/core/skills/catalog.ts";
import { discoverSkills } from "../../src/core/skills/discover.ts";
import { parseSkillFile } from "../../src/core/skills/frontmatter.ts";
import { createSkill, installSkills, removeSkill } from "../../src/core/skills/manage.ts";
import { createSkillService } from "../../src/core/skills/service.ts";
import { cloneUrlFor, parseInstallSource } from "../../src/core/skills/source.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nod-skills-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const skill = (dir: string, text: string) => {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "SKILL.md"), text);
};

test("frontmatter matrix", () => {
  expect(parseSkillFile("---\nname: a\ndescription: 'quoted'\n---\nBody")).toEqual({
    status: "valid",
    name: "a",
    description: "quoted",
    body: "Body",
  });
  expect(parseSkillFile("no front")).toEqual({ status: "no_frontmatter", body: "no front" });
  expect(parseSkillFile("---\nname: crlf\r\ndescription: |\r\n  first\r\n  second\r\n---\r\nBody")).toMatchObject({
    description: "first\nsecond\n",
  });
  expect(parseSkillFile("---\ndescription: >-\n  first\n    extra indent\nname: after-block\n---\nBody")).toMatchObject(
    { name: "after-block", description: "first   extra indent" },
  );
  expect(parseSkillFile("---\nname: empty\ndescription: >\n\n---\nBody")).toMatchObject({ description: "" });
  expect(parseSkillFile("---\nname: a\nname: b\n---\n")).toEqual({
    status: "invalid",
    cause: "duplicate_recognized_key",
  });
  expect(parseSkillFile("---\nname: >\n  block\n---\n")).toEqual({ status: "invalid", cause: "unsupported_multiline" });
  expect(parseSkillFile("---\nname: x\ndescription: >\n\tvalue\n---\n")).toEqual({
    status: "invalid",
    cause: "unsupported_multiline",
  });
  expect(parseSkillFile("---\nname: a/b\n---\n")).toEqual({ status: "invalid", cause: "invalid_name" });
  expect(parseSkillFile("---\ndescription: x\n---\n")).toEqual({ status: "invalid", cause: "missing_name" });
  expect(parseSkillFile("---\nname: a\n")).toEqual({ status: "invalid", cause: "missing_closing_delimiter" });
  expect(parseSkillFile(Buffer.from([0x2d, 0x2d, 0x2d, 0x0a, 0xff, 0x0a, 0x2d, 0x2d, 0x2d, 0x0a]))).toEqual({
    status: "invalid",
    cause: "invalid_utf8",
  });
  expect(parseSkillFile("---\nname: a\ndescription: b\x01\n---\n")).toEqual({
    status: "invalid",
    cause: "control_byte",
  });
});

test("discovery walks workspace roots up to HOME and the user roots; duplicates kept", () => {
  const ws = join(home, "dev", "proj");
  skill(join(ws, "skills", "one"), "---\nname: one\ndescription: first\n---\n");
  skill(join(home, "dev", ".claude", "skills", "two"), "---\nname: two\n---\n");
  skill(join(home, ".nod", "skills", "one"), "---\nname: one\ndescription: managed copy\n---\n");
  skill(join(home, ".agents", "skills", "bad"), "---\nname: a\nname: b\n---\n");
  skill(join(home, "skills", "nothome"), "---\nname: nothome\n---\n");
  const { skills, diagnostics } = discoverSkills({ home, workspaceRoot: ws });
  expect(skills.map((s) => `${s.name}:${s.source}`)).toEqual(["one:workspace", "two:workspace", "one:managed"]);
  expect(diagnostics[0]).toMatch(/^\[skills\] skipped .*SKILL\.md: duplicate_recognized_key$/);
});

test("catalog budget and rendering", () => {
  expect(catalogBudgetBytes(123, 1000)).toBe(123);
  expect(catalogBudgetBytes(undefined, 200_000)).toBe(16000);
  expect(catalogBudgetBytes(undefined, undefined)).toBe(8000);
  const skills = [
    { name: "a", description: "x".repeat(50), dir: "/a", location: "/a", source: "user" as const },
    { name: "b", description: "y", dir: "/b", location: "/b", source: "user" as const },
  ];
  const text = renderCatalog(skills, { budgetBytes: 100, descriptionBytes: 10 });
  expect(text).toContain("- a (/a): xxxxxxxxxx…");
  expect(text).toContain("1 more skill(s) not listed");
  expect(searchSkills(skills, "a").map((r) => r.skill.name)).toEqual(["a"]);
});

test("install source forms", () => {
  expect(parseInstallSource("npx skills add vercel-labs/agent-skills --skill find-skills")).toEqual({
    source: "vercel-labs/agent-skills",
    filter: "find-skills",
  });
  expect(parseInstallSource("bunx -y skills add owner/repo --skill=x")).toEqual({ source: "owner/repo", filter: "x" });
  expect(parseInstallSource("https://skills.sh/owner/repo/my-skill")).toEqual({
    source: "owner/repo",
    filter: "my-skill",
  });
  expect(parseInstallSource("owner/repo@skill")).toEqual({ source: "owner/repo", filter: "skill" });
  expect(parseInstallSource("git@github.com:o/r.git")).toEqual({ source: "git@github.com:o/r.git", filter: undefined });
  expect(parseInstallSource("./local")).toEqual({ source: "./local", filter: undefined });
  expect(() => parseInstallSource("owner/repo@a", "b")).toThrow("ConflictingSkillInstallFilter");
  expect(cloneUrlFor("owner/repo")).toBe("https://github.com/owner/repo.git");
});

test("install from a local directory with a filter, create, remove, service read", async () => {
  const src = join(home, "src");
  skill(join(src, "alpha"), "---\nname: alpha\ndescription: A\n---\nalpha body");
  skill(join(src, "beta"), "---\nname: beta\n---\n");
  writeFileSync(join(src, "alpha", "notes.md"), "notes");
  const result = await installSkills({ home, cwd: home }, "src", "alpha");
  expect(result.installed).toEqual(["alpha"]);
  const svc = createSkillService({ home, workspaceRoot: join(home, "ws") });
  expect(svc.list().map((s) => s.name)).toEqual(["alpha"]);
  const location = svc.list()[0]?.location as string;
  expect(await svc.read(location)).toEqual({ ok: true, text: "---\nname: alpha\ndescription: A\n---\nalpha body" });
  expect(await svc.read("alpha", "notes.md")).toEqual({ ok: true, text: "notes" });
  expect((await svc.read(location, "../x")).ok).toBe(false);
  expect(createSkill(home, "gamma")).toContain("gamma");
  expect(removeSkill(home, "../etc")).toBe(false);
  expect(removeSkill(home, "gamma")).toBe(true);
  const failed = await installSkills(
    { home, cwd: home, clone: async () => ({ ok: false, error: "nope" }) },
    "owner/repo",
  );
  expect(failed.error).toBe("nope");
});
