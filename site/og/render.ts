// Renders the social preview image and PNG icons into public/ with headless Chrome.
// Run after changing og/og.html or public/favicon.svg:  bun run og
// Set CHROME to override the browser path.

import { join } from "node:path";

const root = join(import.meta.dir, "..");
const chrome =
  process.env.CHROME ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

async function shot(source: string, output: string, width: number, height: number) {
  const proc = Bun.spawn(
    [
      chrome,
      "--headless",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      "--virtual-time-budget=5000",
      `--window-size=${width},${height}`,
      `--screenshot=${join(root, "public", output)}`,
      source.startsWith("file://") ? source : `file://${source}`,
    ],
    { stdout: "ignore", stderr: "ignore" },
  );
  if ((await proc.exited) !== 0) throw new Error(`Chrome failed rendering ${output}`);
  console.log(`public/${output} (${width}x${height})`);
}

await shot(join(import.meta.dir, "og.html"), "og.png", 1200, 630);
await shot(`file://${join(import.meta.dir, "icon.html")}?s=180`, "apple-touch-icon.png", 180, 180);
await shot(`file://${join(import.meta.dir, "icon.html")}?s=32`, "favicon-32.png", 32, 32);
