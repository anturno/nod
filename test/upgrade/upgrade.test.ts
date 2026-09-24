import { afterEach, beforeEach, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Io } from "../../src/cli/output.ts";
import { runUpgrade } from "../../src/cli/upgrade.ts";
import {
  CHECK_INTERVAL_MS,
  checkForUpdate,
  compareVersions,
  createAutoUpgrade,
  type Fetch,
  formatUpgrade,
  installUpdate,
  parseVersion,
  READY_LABEL,
  RELEASES_API,
  type ReleaseAsset,
  SOURCE_RUN_MESSAGE,
  selectRelease,
  shouldInstall,
  upgrade,
} from "../../src/core/upgrade/index.ts";

let tmp: string;
beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), "nod-upgrade-"));
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const DL = "https://github.com/anturno/nod/releases/download";
const release = (tag: string, prerelease = false, platform = "macos-aarch64") => ({
  tag_name: tag,
  prerelease,
  assets: [
    { name: `nod-${platform}.tar.gz`, browser_download_url: `${DL}/${tag}/nod-${platform}.tar.gz` },
    { name: `nod-${platform}.tar.gz.sha256`, browser_download_url: `${DL}/${tag}/nod-${platform}.tar.gz.sha256` },
  ],
});

function fakeFetch(routes: Record<string, () => Response>): Fetch & { calls: string[] } {
  const calls: string[] = [];
  const f = (async (url: string) => {
    calls.push(url);
    return routes[url]?.() ?? new Response("not found", { status: 404 });
  }) as Fetch & { calls: string[] };
  f.calls = calls;
  return f;
}
const json = (v: unknown) => () => Response.json(v);

/** A real tar.gz holding a fake `nod` script, plus its sha256 line as the release workflow writes it. */
function tarball(dir: string, body = "#!/bin/sh\necho nod 9.9.9\n") {
  const src = join(dir, "src");
  mkdirSync(src);
  writeFileSync(join(src, "nod"), body, { mode: 0o755 });
  const archive = join(dir, "nod-macos-aarch64.tar.gz");
  const tar = Bun.spawnSync(["tar", "-czf", archive, "-C", src, "nod"]);
  if (tar.exitCode !== 0) throw new Error("tar failed");
  const bytes = readFileSync(archive);
  return { bytes, sha256: `${createHash("sha256").update(bytes).digest("hex")}  nod-macos-aarch64.tar.gz\n` };
}

test("parseVersion accepts v-prefixed semver and dev-<sha> tags", () => {
  expect(parseVersion("v1.2.3")).toEqual({ channel: "stable", parts: [1, 2, 3] });
  expect(parseVersion(" 0.1.0\n")).toEqual({ channel: "stable", parts: [0, 1, 0] });
  expect(parseVersion("dev-0123ABCdef")).toEqual({ channel: "dev", sha: "0123abcdef" });
  for (const bad of ["1.2", "v1.2.3-rc1", "dev-xyz", "dev-abc", "", "nightly"])
    expect(parseVersion(bad)).toBeUndefined();
});

test("compareVersions orders numerically, not lexically", () => {
  expect(compareVersions("v1.10.0", "1.9.9")).toBe(1);
  expect(compareVersions("0.1.0", "v0.1.0")).toBe(0);
  expect(compareVersions("0.0.9", "0.1.0")).toBe(-1);
});

test("shouldInstall: stable strictly newer, dev by sha, channel switch always", () => {
  expect(shouldInstall("v0.2.0", "0.1.0")).toBe(true);
  expect(shouldInstall("v0.1.0", "0.1.0")).toBe(false);
  expect(shouldInstall("v0.0.1", "0.1.0")).toBe(false);
  expect(shouldInstall("dev-abcdef0123456789", "dev-abcdef0")).toBe(false);
  expect(shouldInstall("dev-abcdef0123456789", "dev-1234567")).toBe(true);
  expect(shouldInstall("dev-abcdef0", "0.1.0")).toBe(true);
  expect(shouldInstall("v0.0.1", "dev-abcdef0")).toBe(true);
  expect(shouldInstall("garbage", "0.1.0")).toBe(false);
});

test("selectRelease: stable takes releases/latest, dev takes the first dev-* prerelease", () => {
  const latest = release("v0.3.0");
  expect(selectRelease("stable", latest)?.tag_name).toBe("v0.3.0");
  expect(selectRelease("stable", [latest])).toBeUndefined();
  const list = [release("v0.3.0"), release("dev-1111111", false), release("rc-1", true), release("dev-2222222", true)];
  expect(selectRelease("dev", list)?.tag_name).toBe("dev-2222222");
  expect(selectRelease("dev", [release("v0.3.0")])).toBeUndefined();
  expect(selectRelease("dev", { tag_name: "dev-3333333" })).toBeUndefined();
});

test("checkForUpdate hits the right endpoint per channel and reports the asset", async () => {
  const fetch = fakeFetch({
    [`${RELEASES_API}/latest`]: json(release("v0.2.0")),
    [`${RELEASES_API}?per_page=30`]: json([release("dev-abcdef0", true)]),
  });
  const stable = await checkForUpdate({ fetch, currentVersion: "0.1.0", channel: "stable", platform: "macos-aarch64" });
  expect(stable).toMatchObject({ current: "0.1.0", latest: "0.2.0", status: "available" });
  expect(stable.asset).toEqual({
    tag: "v0.2.0",
    name: "nod-macos-aarch64.tar.gz",
    url: `${DL}/v0.2.0/nod-macos-aarch64.tar.gz`,
    sha256Url: `${DL}/v0.2.0/nod-macos-aarch64.tar.gz.sha256`,
  });
  const same = await checkForUpdate({ fetch, currentVersion: "v0.2.0", channel: "stable", platform: "macos-aarch64" });
  expect(same.status).toBe("up_to_date");
  const dev = await checkForUpdate({ fetch, currentVersion: "0.2.0", channel: "dev", platform: "macos-aarch64" });
  expect(dev).toMatchObject({ latest: "dev-abcdef0", status: "available" });
  expect(fetch.calls).toEqual([`${RELEASES_API}/latest`, `${RELEASES_API}/latest`, `${RELEASES_API}?per_page=30`]);

  const missing = await checkForUpdate({
    fetch,
    currentVersion: "0.1.0",
    channel: "stable",
    platform: "linux-riscv64",
  });
  expect(missing).toMatchObject({ status: "failed", error: "no release asset for linux-riscv64" });
  const offline = await checkForUpdate({ fetch: fakeFetch({}), currentVersion: "0.1.0", channel: "stable" });
  expect(offline).toMatchObject({ status: "failed", error: "failed to fetch latest version from GitHub" });
});

test("installUpdate rejects a tampered archive and otherwise replaces the binary in place", async () => {
  const { bytes, sha256 } = tarball(tmp);
  const asset: ReleaseAsset = { tag: "v9.9.9", name: "nod-macos-aarch64.tar.gz", url: "a", sha256Url: "s" };
  const bin = join(tmp, "bin");
  mkdirSync(bin);
  const execPath = join(bin, "nod");
  writeFileSync(execPath, "old");

  const bad = fakeFetch({ a: () => new Response(bytes), s: () => new Response(`${"0".repeat(64)}  x\n`) });
  await expect(installUpdate({ fetch: bad, asset, execPath, tmpDir: tmp })).rejects.toThrow(
    "downloaded archive failed integrity check",
  );
  expect(readFileSync(execPath, "utf8")).toBe("old");

  const noSum = fakeFetch({ a: () => new Response(bytes) });
  await expect(installUpdate({ fetch: noSum, asset, execPath, tmpDir: tmp })).rejects.toThrow(
    "failed to fetch checksum",
  );

  const good = fakeFetch({ a: () => new Response(bytes), s: () => new Response(sha256) });
  await installUpdate({ fetch: good, asset, execPath, tmpDir: tmp });
  expect(readFileSync(execPath, "utf8")).toContain("echo nod 9.9.9");
  expect(existsSync(join(bin, ".nod.new"))).toBe(false);
  expect(Bun.spawnSync([execPath]).stdout.toString()).toBe("nod 9.9.9\n");
});

test("formatUpgrade JSON golden and text forms", () => {
  const up = { current: "0.1.0", latest: "0.2.0", channel: "stable" as const, status: "upgraded" as const };
  expect(formatUpgrade(up, "json")).toBe(
    '{"kind":"upgrade","current":"0.1.0","latest":"0.2.0","channel":"stable","status":"upgraded"}\n',
  );
  expect(formatUpgrade(up, "text")).toBe("upgraded to v0.2.0\n");
  expect(formatUpgrade({ ...up, status: "up_to_date", latest: "0.1.0" }, "text")).toBe(
    "nod is already up to date (v0.1.0)\n",
  );
  expect(formatUpgrade({ ...up, channel: "dev", latest: "dev-abcdef0123456789" }, "text")).toBe(
    "upgraded to dev abcdef012345\n",
  );
  const failed = { ...up, latest: "", status: "failed" as const, error: "boom" };
  expect(formatUpgrade(failed, "json")).toBe(
    '{"kind":"upgrade","current":"0.1.0","latest":"","channel":"stable","status":"failed","error":"boom"}\n',
  );
  expect(formatUpgrade(failed, "text")).toBe("error: boom\n");
});

test("upgrade from source reports the reinstall command without touching the network", async () => {
  const fetch = fakeFetch({});
  const r = await upgrade({ fetch, currentVersion: "0.1.0", channel: "stable", execPath: "/usr/local/bin/bun" });
  expect(r).toEqual({ current: "0.1.0", latest: "", channel: "stable", status: "failed", error: SOURCE_RUN_MESSAGE });
  expect(fetch.calls).toEqual([]);
});

test("upgrade end to end: check, download, verify, replace", async () => {
  const { bytes, sha256 } = tarball(tmp);
  const execPath = join(tmp, "nod");
  writeFileSync(execPath, "old");
  const fetch = fakeFetch({
    [`${RELEASES_API}/latest`]: json(release("v9.9.9")),
    [`${DL}/v9.9.9/nod-macos-aarch64.tar.gz`]: () => new Response(bytes),
    [`${DL}/v9.9.9/nod-macos-aarch64.tar.gz.sha256`]: () => new Response(sha256),
  });
  const o = {
    fetch,
    currentVersion: "0.1.0",
    channel: "stable" as const,
    execPath,
    tmpDir: tmp,
    platform: "macos-aarch64",
  };
  expect(await upgrade(o)).toEqual({ current: "0.1.0", latest: "9.9.9", channel: "stable", status: "upgraded" });
  expect(readFileSync(execPath, "utf8")).toContain("9.9.9");
  expect(await upgrade({ ...o, currentVersion: "9.9.9" })).toMatchObject({ status: "up_to_date", latest: "9.9.9" });
});

test("runUpgrade: flags, channel persistence, source-run failure", async () => {
  const home = join(tmp, "home");
  mkdirSync(home);
  const run = async (args: string[], execPath = "/opt/homebrew/bin/bun") => {
    let out = "";
    let err = "";
    const io: Io = {
      stdout: (t) => (out += t),
      stderr: (t) => (err += t),
      env: { NOD_HOME: home },
      cwd: tmp,
      isTTY: false,
    };
    const code = await runUpgrade(args, io, { fetch: fakeFetch({}), execPath, currentVersion: "0.1.0" });
    return { code, out, err };
  };
  expect(await run([])).toEqual({ code: 1, out: `error: ${SOURCE_RUN_MESSAGE}\n`, err: "" });
  expect(JSON.parse((await run(["--json"])).out)).toEqual({
    kind: "upgrade",
    current: "0.1.0",
    latest: "",
    channel: "stable",
    status: "failed",
    error: SOURCE_RUN_MESSAGE,
  });
  const dev = await run(["--channel", "dev", "--json"]);
  expect(JSON.parse(dev.out).channel).toBe("dev");
  expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).update_channel).toBe("dev");
  expect(JSON.parse((await run(["--json"])).out).channel).toBe("dev");
  await expect(run(["--channel", "nightly"])).rejects.toThrow("--channel must be stable or dev");
  await expect(run(["extra"])).rejects.toThrow("usage: nod upgrade");
  await expect(run(["--json", "--json"])).rejects.toThrow("--json may be given once");

  const compiled = await run([], join(tmp, "nod"));
  expect(compiled.code).toBe(1);
  expect(compiled.out).toBe("error: failed to fetch latest version from GitHub\n");
});

test("createAutoUpgrade polls every 30 minutes and settles on ready", async () => {
  const { bytes, sha256 } = tarball(tmp);
  const execPath = join(tmp, "nod");
  writeFileSync(execPath, "old");
  const fetch = fakeFetch({
    [`${RELEASES_API}/latest`]: json(release("v9.9.9")),
    [`${DL}/v9.9.9/nod-macos-aarch64.tar.gz`]: () => new Response(bytes),
    [`${DL}/v9.9.9/nod-macos-aarch64.tar.gz.sha256`]: () => new Response(sha256),
  });
  let clock = 1_000;
  const base = { fetch, now: () => clock, currentVersion: "0.1.0", execPath, tmpDir: tmp, platform: "macos-aarch64" };

  const off = createAutoUpgrade({ ...base, config: { autoUpgrade: false, updateChannel: "stable" } });
  expect(await off.poll()).toBeUndefined();
  const source = createAutoUpgrade({
    ...base,
    execPath: "/usr/bin/bun",
    config: { autoUpgrade: true, updateChannel: "stable" },
  });
  expect(await source.poll()).toBeUndefined();
  expect(fetch.calls).toEqual([]);

  const upToDate = createAutoUpgrade({
    ...base,
    currentVersion: "9.9.9",
    config: { autoUpgrade: true, updateChannel: "stable" },
  });
  expect(await upToDate.poll()).toBeUndefined();
  expect(await upToDate.poll()).toBeUndefined();
  expect(fetch.calls.length).toBe(1);
  clock += CHECK_INTERVAL_MS;
  expect(await upToDate.poll()).toBeUndefined();
  expect(fetch.calls.length).toBe(2);

  const auto = createAutoUpgrade({ ...base, config: { autoUpgrade: true, updateChannel: "stable" } });
  const [a, b] = await Promise.all([auto.poll(), auto.poll()]);
  expect(a).toEqual({ state: "ready", latest: "9.9.9", label: READY_LABEL });
  expect(b).toBe(a);
  expect(fetch.calls.length).toBe(5);
  clock += CHECK_INTERVAL_MS;
  expect(await auto.poll()).toBe(a);
  expect(fetch.calls.length).toBe(5);
  expect(readFileSync(execPath, "utf8")).toContain("9.9.9");
});
