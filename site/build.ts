// Builds the site into dist/: compiles Tailwind and copies public/, filling in
// %SITE_URL% and %BUILD_DATE%. SITE_URL comes from actions/configure-pages in CI,
// which already reflects the custom domain once one is set.
//
//   bun build.ts           one-off build
//   bun build.ts --watch   rebuild on changes and serve dist/ on :4173

import { cpSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, watch, writeFileSync } from "node:fs";
import { join } from "node:path";

const root = import.meta.dir;
const pub = join(root, "public");
const out = join(root, "dist");
const isWatch = process.argv.includes("--watch");
const port = 4173;

const siteUrl = (process.env.SITE_URL || `http://localhost:${port}`).replace(/\/+$/, "");
const buildDate = new Date().toISOString().slice(0, 10);
const templated = /\.(html|xml|txt|json|webmanifest)$/;

function copyPublic() {
  for (const name of readdirSync(pub, { recursive: true }) as string[]) {
    const from = join(pub, name);
    const to = join(out, name);
    if (statSync(from).isDirectory()) {
      mkdirSync(to, { recursive: true });
    } else if (templated.test(name)) {
      const text = readFileSync(from, "utf8")
        .replaceAll("%SITE_URL%", siteUrl)
        .replaceAll("%BUILD_DATE%", buildDate);
      writeFileSync(to, text);
    } else {
      cpSync(from, to);
    }
  }
}

function tailwind(watchMode: boolean) {
  // --watch=always keeps watching when stdin isn't a TTY (preview servers, CI).
  const args = ["tailwindcss", "-i", "src/styles.css", "-o", "dist/styles.css", watchMode ? "--watch=always" : "--minify"];
  return Bun.spawn(["bunx", ...args], { cwd: root, stdout: "inherit", stderr: "inherit" });
}

rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
copyPublic();

if (!isWatch) {
  const code = await tailwind(false).exited;
  if (code !== 0) process.exit(code);
  console.log(`Built dist/ for ${siteUrl}`);
} else {
  tailwind(true);
  watch(pub, { recursive: true }, () => copyPublic());
  Bun.spawn(["bunx", "serve", "dist", "-l", String(port)], { cwd: root, stdout: "inherit", stderr: "inherit" });
}
