// Builds the site into dist/: compiles Tailwind, copies public/, and renders ../docs/**/*.md
// into dist/docs/<slug>/index.html (+ the raw .md, llms.txt, llms-full.txt and a sitemap).
// SITE_URL comes from actions/configure-pages in CI; it already reflects the custom domain.
//
//   bun build.ts           one-off build
//   bun build.ts --watch   rebuild on changes and serve dist/ on :4173

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { marked } from "marked";

// GitHub-style heading ids so in-page links like #nod-stops-before-running-a-tool resolve; tables scroll in a wrapper.
marked.use({
  renderer: {
    heading({ tokens, depth, text }) {
      const id = text.toLowerCase().replace(/<[^>]*>/g, "").replace(/[^\w\s-]/g, "").trim().replace(/\s/g, "-");
      const inner = this.parser.parseInline(tokens);
      if (depth === 1) return `<h1 id="${id}">${inner}</h1>\n`;
      return `<h${depth} id="${id}"><a class="anchor" href="#${id}">${inner}</a></h${depth}>\n`;
    },
  },
  hooks: { postprocess: (html) => html.replaceAll("<table>", '<div class="table">\n<table>').replaceAll("</table>", "</table>\n</div>") },
});

export type Page = { slug: string; title: string; description: string; body: string; group: string; source: string };

/** Nav and llms.txt order; a docs page missing from here lands in "Other" at the end. */
const GROUPS: [string, string[]][] = [
  ["Getting started", ["", "getting-started/installation", "getting-started/authentication"]],
  [
    "Using nod",
    [
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
    ],
  ],
  [
    "Configure",
    [
      "configure/models",
      "configure/permissions",
      "configure/project-instructions",
      "configure/configuration",
      "configure/additional-workspaces",
      "configure/context-limits",
    ],
  ],
  [
    "Capabilities",
    [
      "capabilities/tools",
      "capabilities/skills",
      "capabilities/mcp",
      "capabilities/mcp/protocol",
      "capabilities/subagents",
      "capabilities/vision",
      "capabilities/web-search",
    ],
  ],
  ["Embed nod", ["lib", "lib/node", "lib/api", "lib/terminal", "lib/examples"]],
];

const escapeHtml = (s: string) =>
  s.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** `---\ntitle: "..."\ndescription: "..."\n---\nbody`. Quotes optional. */
export function parseFrontmatter(text: string): { title: string; description: string; body: string } {
  const match = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/.exec(text);
  if (!match) throw new Error("missing frontmatter");
  const fields: Record<string, string> = {};
  for (const line of (match[1] as string).split(/\r?\n/)) {
    const kv = /^(\w+):\s*(.*)$/.exec(line);
    if (kv) fields[kv[1] as string] = (kv[2] as string).trim().replace(/^"(.*)"$/, "$1");
  }
  if (!fields.title) throw new Error("missing title");
  return { title: fields.title, description: fields.description ?? "", body: text.slice(match[0].length) };
}

/** docs/index.md → "", docs/lib/index.md → "lib", docs/a/b.md → "a/b". */
const slugOf = (rel: string) => rel.replace(/\.md$/, "").replace(/(^|\/)index$/, "");

export function loadDocs(docsDir: string): Page[] {
  const order = new Map<string, string>();
  for (const [group, slugs] of GROUPS) for (const slug of slugs) order.set(slug, group);
  const pages: Page[] = [];
  for (const name of readdirSync(docsDir, { recursive: true }) as string[]) {
    if (!name.endsWith(".md")) continue;
    const slug = slugOf(name.replaceAll("\\", "/"));
    const source = join(docsDir, name);
    const { title, description, body } = parseFrontmatter(readFileSync(source, "utf8"));
    pages.push({ slug, title, description, body, group: order.get(slug) ?? "Other", source });
  }
  const rank = (p: Page) => [...order.keys()].indexOf(p.slug) >>> 0;
  return pages.sort((a, b) => rank(a) - rank(b) || a.slug.localeCompare(b.slug));
}

export const pageUrl = (siteUrl: string, slug: string) => (slug ? `${siteUrl}/docs/${slug}` : `${siteUrl}/docs`);
export const markdownUrl = (siteUrl: string, slug: string) => `${pageUrl(siteUrl, slug)}.md`;

const groupsOf = (pages: Page[]) => {
  const out = new Map<string, Page[]>();
  for (const p of pages) out.set(p.group, [...(out.get(p.group) ?? []), p]);
  return out;
};

function renderNav(pages: Page[], current: string, siteUrl: string): string {
  const lines: string[] = [];
  for (const [group, items] of groupsOf(pages)) {
    lines.push(`<h2>${escapeHtml(group)}</h2>`, "<ul>");
    for (const p of items) {
      const cls = p.slug === current ? ' class="active" aria-current="page"' : "";
      lines.push(`<li><a href="${pageUrl(siteUrl, p.slug)}"${cls}>${escapeHtml(p.title)}</a></li>`);
    }
    lines.push("</ul>");
  }
  return lines.join("\n");
}

export function renderLlmsTxt(pages: Page[], siteUrl: string): string {
  const lines = ["# nod", "", "> A coding agent for the terminal that runs on your ChatGPT or Grok subscription.", ""];
  for (const [group, items] of groupsOf(pages)) {
    lines.push(`## ${group}`, "");
    for (const p of items) lines.push(`- [${p.title}](${markdownUrl(siteUrl, p.slug)}): ${p.description}`);
    lines.push("");
  }
  return `${lines.join("\n")}\n`;
}

export function renderLlmsFullTxt(pages: Page[], siteUrl: string): string {
  const parts = [
    "# nod complete documentation",
    "",
    "> Every nod documentation page in one machine-readable file.",
    "",
  ];
  for (const p of pages) {
    parts.push(
      "---",
      `title: "${p.title}"`,
      `description: "${p.description}"`,
      `canonical_url: ${pageUrl(siteUrl, p.slug)}`,
      `markdown_url: ${markdownUrl(siteUrl, p.slug)}`,
      "---",
      "",
      p.body.trim(),
      "",
      "---",
      "",
    );
  }
  return `${parts.join("\n")}\n`;
}

/** TechArticle + breadcrumbs for a docs page; `<` escaped so a title can't close the script tag. */
export function renderJsonLd(p: Page, siteUrl: string): string {
  const crumbs = [
    { name: "nod", item: `${siteUrl}/` },
    { name: "Docs", item: pageUrl(siteUrl, "") },
    ...(p.slug ? [{ name: p.title, item: pageUrl(siteUrl, p.slug) }] : []),
  ];
  const data = {
    "@context": "https://schema.org",
    "@graph": [
      {
        "@type": "TechArticle",
        headline: p.title,
        description: p.description,
        url: pageUrl(siteUrl, p.slug),
        inLanguage: "en",
        isPartOf: { "@id": `${siteUrl}/#website` },
        publisher: { "@id": `${siteUrl}/#org` },
      },
      {
        "@type": "BreadcrumbList",
        itemListElement: crumbs.map((c, i) => ({ "@type": "ListItem", position: i + 1, ...c })),
      },
    ],
  };
  return JSON.stringify(data).replaceAll("<", "\\u003c");
}

export function renderSitemap(pages: Page[], siteUrl: string, date: string): string {
  const url = (loc: string) => `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${date}</lastmod>\n  </url>`;
  const urls = [url(`${siteUrl}/`), ...pages.map((p) => url(pageUrl(siteUrl, p.slug)))];
  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.join("\n")}\n</urlset>\n`;
}

export type BuildOptions = { root: string; docsDir: string; out: string; siteUrl: string; date?: string };

/** Everything except Tailwind: copies public/, renders docs, writes llms.txt, llms-full.txt and the sitemap. */
export function buildStatic({ root, docsDir, out, siteUrl, date }: BuildOptions): Page[] {
  const buildDate = date ?? new Date().toISOString().slice(0, 10);
  const pub = join(root, "public");
  const fill = (text: string) => text.replaceAll("%SITE_URL%", siteUrl).replaceAll("%BUILD_DATE%", buildDate);
  const templated = /\.(html|xml|txt|json|webmanifest)$/;
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(out, rel)), { recursive: true });
    writeFileSync(join(out, rel), text);
  };

  mkdirSync(out, { recursive: true });
  for (const name of readdirSync(pub, { recursive: true }) as string[]) {
    const from = join(pub, name);
    if (statSync(from).isDirectory()) mkdirSync(join(out, name), { recursive: true });
    else if (templated.test(name)) write(name, fill(readFileSync(from, "utf8")));
    else cpSync(from, join(out, name));
  }

  const pages = loadDocs(docsDir);
  const template = readFileSync(join(root, "src", "doc.html"), "utf8");
  // Docs link to the canonical host in Markdown; HTML pages point at the deployed SITE_URL instead.
  const mdLink = /href="https:\/\/nod\.anturno\.cloud\/docs(\/[^"#]*)?\.md(#[^"]*)?"/g;
  for (const p of pages) {
    const html = (marked.parse(p.body, { gfm: true }) as string).replace(
      mdLink,
      (_, path = "", hash = "") => `href="${siteUrl}/docs${path}${hash}"`,
    );
    const page = fill(template)
      .replaceAll("%TITLE%", escapeHtml(p.title))
      .replaceAll("%DESCRIPTION%", escapeHtml(p.description))
      .replaceAll("%CANONICAL%", pageUrl(siteUrl, p.slug))
      .replaceAll("%MARKDOWN%", markdownUrl(siteUrl, p.slug))
      .replaceAll("%JSONLD%", () => renderJsonLd(p, siteUrl))
      .replaceAll("%NAV%", renderNav(pages, p.slug, siteUrl))
      .replaceAll("%BODY%", html);
    write(p.slug ? `docs/${p.slug}/index.html` : "docs/index.html", page);
    write(p.slug ? `docs/${p.slug}.md` : "docs.md", readFileSync(p.source, "utf8"));
  }
  write("llms.txt", renderLlmsTxt(pages, siteUrl));
  write("llms-full.txt", renderLlmsFullTxt(pages, siteUrl));
  write("sitemap.xml", renderSitemap(pages, siteUrl, buildDate));
  return pages;
}

function tailwind(root: string, watchMode: boolean) {
  // --watch=always keeps watching when stdin isn't a TTY (preview servers, CI).
  const args = [
    "tailwindcss",
    "-i",
    "src/styles.css",
    "-o",
    "dist/styles.css",
    watchMode ? "--watch=always" : "--minify",
  ];
  return Bun.spawn(["bunx", ...args], { cwd: root, stdout: "inherit", stderr: "inherit" });
}

if (import.meta.main) {
  const root = import.meta.dir;
  const out = join(root, "dist");
  const docsDir = join(root, "..", "docs");
  const isWatch = process.argv.includes("--watch");
  const port = 4173;
  const siteUrl = (process.env.SITE_URL || `http://localhost:${port}`).replace(/\/+$/, "");
  const opts = { root, docsDir, out, siteUrl };

  rmSync(out, { recursive: true, force: true });
  const pages = buildStatic(opts);

  if (!isWatch) {
    const code = await tailwind(root, false).exited;
    if (code !== 0) process.exit(code);
    console.log(`Built dist/ (${pages.length} docs pages) for ${siteUrl}`);
  } else {
    tailwind(root, true);
    for (const dir of [join(root, "public"), join(root, "src"), docsDir])
      watch(dir, { recursive: true }, () => buildStatic(opts));
    Bun.spawn(["bunx", "serve", "dist", "-l", String(port)], { cwd: root, stdout: "inherit", stderr: "inherit" });
  }
}
