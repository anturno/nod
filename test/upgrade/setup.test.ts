import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { platformName } from "../../src/core/upgrade/index.ts";

const ROOT = join(import.meta.dir, "../..");
const SCRIPT = join(ROOT, "scripts/setup.sh");

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nod-setup-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

test("setup.sh parses and the site serves the same script", () => {
  expect(Bun.spawnSync(["bash", "-n", SCRIPT]).exitCode).toBe(0);
  expect(readFileSync(join(ROOT, "site/public/setup.sh"), "utf8")).toBe(readFileSync(SCRIPT, "utf8"));
});

/** Lays out <releases>/<tag>/nod-<platform>.tar.gz(.sha256) with a fake `nod` script inside. */
function fakeRelease(tag: string) {
  const dir = join(tmp, "releases", tag);
  const src = join(tmp, "src");
  mkdirSync(dir, { recursive: true });
  mkdirSync(src, { recursive: true });
  writeFileSync(join(src, "nod"), `#!/bin/sh\necho nod ${tag}\n`, { mode: 0o755 });
  const name = `nod-${platformName()}.tar.gz`;
  expect(Bun.spawnSync(["tar", "-czf", join(dir, name), "-C", src, "nod"]).exitCode).toBe(0);
  const sha = createHash("sha256")
    .update(readFileSync(join(dir, name)))
    .digest("hex");
  writeFileSync(join(dir, `${name}.sha256`), `${sha}  ${name}\n`);
  return join(dir, `${name}.sha256`);
}

function install(tag: string) {
  const home = join(tmp, "home");
  mkdirSync(home, { recursive: true });
  const proc = Bun.spawnSync(["bash", SCRIPT, tag], {
    env: {
      PATH: "/usr/bin:/bin",
      HOME: home,
      SHELL: "/bin/zsh",
      NOD_INSTALL_DIR: join(tmp, "bin"),
      NOD_RELEASE_BASE_URL: `file://${join(tmp, "releases")}`,
    },
    stdin: "ignore",
  });
  return { code: proc.exitCode, out: proc.stdout.toString(), err: proc.stderr.toString(), home };
}

test("dry run installs from a file:// tarball, verifies the checksum, and appends PATH to .zshrc", () => {
  fakeRelease("v9.9.9");
  const r = install("v9.9.9");
  expect(r.err).toContain("installed nod 9.9.9 to");
  expect(r.code).toBe(0);
  const bin = join(tmp, "bin", "nod");
  expect(statSync(bin).mode & 0o111).not.toBe(0);
  expect(Bun.spawnSync([bin]).stdout.toString()).toBe("nod v9.9.9\n");
  expect(r.out.trim()).toBe(bin);
  expect(readFileSync(join(r.home, ".zshrc"), "utf8")).toContain(`export PATH="${join(tmp, "bin")}:$PATH"`);

  // A second run does not duplicate the PATH line.
  install("v9.9.9");
  expect(readFileSync(join(r.home, ".zshrc"), "utf8").split("# nod CLI").length).toBe(2);
});

test("dry run refuses an archive whose checksum does not match", () => {
  const sumPath = fakeRelease("v9.9.9");
  writeFileSync(sumPath, `${"0".repeat(64)}  x\n`);
  const r = install("v9.9.9");
  expect(r.code).toBe(1);
  expect(r.err).toContain("downloaded archive failed integrity check");
});

test("dry run fails clearly when the version does not exist", () => {
  const r = install("v0.0.0");
  expect(r.code).toBe(1);
  expect(r.err).toContain("failed to download");
});
