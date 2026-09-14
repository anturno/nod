import { afterAll, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildStatic, loadDocs, parseFrontmatter, renderLlmsFullTxt } from "../site/build.ts";

const root = join(import.meta.dir, "..", "site");
const docsDir = join(import.meta.dir, "..", "docs");
const siteUrl = "https://nod.example";
const out = mkdtempSync(join(tmpdir(), "nod-site-"));
afterAll(() => rmSync(out, { recursive: true, force: true }));

const pages = buildStatic({ root, docsDir, out, siteUrl, date: "2026-01-02" });
const read = (rel: string) => readFileSync(join(out, rel), "utf8");

const EXPECTED_SLUGS = [
  "",
  "getting-started/installation",
  "getting-started/authentication",
  "using-nod/use-cases",
  "using-nod/sessions",
  "using-nod/nod-ask",
  "using-nod/cli",
  "using-nod/slash-commands",
  "using-nod/usage",
  "using-nod/acp",
  "using-nod/troubleshooting",
  "using-nod/data-and-privacy",
  "using-nod/feedback",
  "configure/models",
  "configure/permissions",
  "configure/project-instructions",
  "configure/configuration",
  "configure/additional-workspaces",
  "configure/context-limits",
  "capabilities/tools",
  "capabilities/skills",
  "capabilities/mcp",
  "capabilities/mcp/protocol",
  "capabilities/subagents",
  "capabilities/vision",
  "capabilities/web-search",
  "lib",
  "lib/node",
  "lib/api",
  "lib/terminal",
  "lib/examples",
];

test("parseFrontmatter reads title and description", () => {
  const p = parseFrontmatter('---\ntitle: "A"\ndescription: "B"\n---\n\n# A\n');
  expect(p).toEqual({ title: "A", description: "B", body: "\n# A\n" });
  expect(() => parseFrontmatter("# no frontmatter")).toThrow();
});

test("every documented page exists, in nav order, with a title, description, and footer", () => {
  expect(pages.map((p) => p.slug)).toEqual(EXPECTED_SLUGS);
  for (const p of pages) {
    expect(p.title.length).toBeGreaterThan(0);
    expect(p.description.length).toBeGreaterThan(0);
    expect(p.group).not.toBe("Other");
    expect(p.body.trimEnd().endsWith("[Browse all nod documentation](https://nod.anturno.cloud/llms.txt)")).toBe(true);
  }
});

test("docs never mention unsupported features", () => {
  const banned = [/Vercel/, /AI_GATEWAY/, /Exa\b/, /kimi/, /gemini/, /Herdr/, /keychain/i, /wasm/i];
  for (const p of loadDocs(docsDir)) for (const re of banned) expect(p.body).not.toMatch(re);
});

test("renders html pages, raw markdown, and rewrites .md links", () => {
  expect(existsSync(join(out, "docs", "index.html"))).toBe(true);
  expect(existsSync(join(out, "docs.md"))).toBe(true);
  const html = read("docs/using-nod/sessions/index.html");
  expect(html).toContain("<title>Sessions · nod docs</title>");
  expect(html).toContain(`<link rel="canonical" href="${siteUrl}/docs/using-nod/sessions">`);
  expect(html).toContain('aria-current="page"');
  expect(html).toContain(`<h1 id="sessions">Sessions</h1>`);
  expect(read("docs/using-nod/troubleshooting/index.html")).toContain(`id="a-session-will-not-open-or-resume"`);
  expect(html).toContain(`href="${siteUrl}/docs/using-nod/troubleshooting#a-session-will-not-open-or-resume"`);
  expect(html).not.toContain(".md#");
  expect(html).toContain(`href="${siteUrl}/docs/using-nod/sessions.md"`); // the "view as Markdown" link
  expect(read("docs/lib.md")).toContain('title: "Embed nod"');
  expect(read("docs/capabilities/mcp/protocol.md")).toStartWith("---\n");
  expect(read("docs/capabilities/mcp/protocol/index.html")).toContain("MCP protocol reference");
});

test("llms.txt lists every page grouped by section", () => {
  const txt = read("llms.txt");
  expect(txt).toStartWith("# nod\n");
  for (const group of ["## Getting started", "## Using nod", "## Configure", "## Capabilities", "## Embed nod"])
    expect(txt).toContain(group);
  expect(txt).toContain(`- [Quick start](${siteUrl}/docs.md): `);
  expect(txt).toContain(`- [MCP protocol reference](${siteUrl}/docs/capabilities/mcp/protocol.md): `);
  expect(txt.match(/^- \[/gm)?.length).toBe(pages.length);
});

test("llms-full.txt uses the frontmatter format with canonical and markdown urls", () => {
  const full = read("llms-full.txt");
  expect(full).toBe(renderLlmsFullTxt(pages, siteUrl));
  expect(full).toStartWith("# nod complete documentation\n");
  expect(full).toContain(
    `---\ntitle: "Quick start"\ndescription: "Install nod, run a first request, and learn the commands worth knowing."\ncanonical_url: ${siteUrl}/docs\nmarkdown_url: ${siteUrl}/docs.md\n---\n\n# Quick start`,
  );
  expect(full.match(/^canonical_url: /gm)?.length).toBe(pages.length);
  expect(full.match(/^\[Browse all nod documentation\]/gm)?.length).toBe(pages.length);
});

test("sitemap has the landing page plus one url per docs page", () => {
  const xml = read("sitemap.xml");
  expect(xml.match(/<loc>/g)?.length).toBe(pages.length + 1);
  expect(xml).toContain(`<loc>${siteUrl}/</loc>`);
  expect(xml).toContain(`<loc>${siteUrl}/docs/lib/api</loc>`);
  expect(xml).toContain("<lastmod>2026-01-02</lastmod>");
  expect(read("robots.txt")).toContain(`${siteUrl}/sitemap.xml`);
});

test("landing page is copied with the site url filled in", () => {
  const html = read("index.html");
  expect(html).not.toContain("%SITE_URL%");
  expect(html).toContain("curl -fsSL https://nod.anturno.cloud/setup.sh | bash");
  expect(html).toContain(`href="${siteUrl}/docs"`);
});
