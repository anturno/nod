/** Checks GitHub Releases of anturno/nod for a newer build and swaps the running binary in place. */
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { arch, platform as osPlatform, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import type { ResolvedConfig } from "../config/resolve.ts";
import { type Channel, displayVersion, shouldInstall, versionLabel } from "./version.ts";

export { type Channel, compareVersions, displayVersion, parseChannel, parseVersion, shouldInstall } from "./version.ts";

export const REPO = "anturno/nod";
export const RELEASES_API = `https://api.github.com/repos/${REPO}/releases`;
export const CHECK_INTERVAL_MS = 30 * 60 * 1000;
export const SOURCE_RUN_MESSAGE =
  "nod is running from source and has no binary to replace; reinstall with: bun install -g github:anturno/nod";
export const READY_LABEL = "update ready: ctrl+g to reload";

export type Fetch = (url: string, init?: RequestInit) => Promise<Response>;
export type ReleaseAsset = { tag: string; name: string; url: string; sha256Url: string };
export type UpdateCheck = {
  current: string;
  latest: string;
  status: "up_to_date" | "available" | "failed";
  asset?: ReleaseAsset;
  error?: string;
};
export type UpgradeResult = {
  current: string;
  latest: string;
  channel: Channel;
  status: "upgraded" | "up_to_date" | "failed";
  error?: string;
};
export type UpdateStatus = { state: "ready" | "failed"; latest: string; label: string };

/** `macos-aarch64`, `linux-x86_64`, …; unsupported hosts still get a name so the missing asset is reported. */
export function platformName(os = osPlatform(), cpu = arch()): string {
  const osName = os === "darwin" ? "macos" : os;
  const cpuName = cpu === "arm64" ? "aarch64" : cpu === "x64" ? "x86_64" : cpu;
  return `${osName}-${cpuName}`;
}

/** Running under `bun src/cli/main.ts` rather than a compiled binary. */
export const isSourceRun = (execPath: string) => /^bun(-profile)?(\.exe)?$/.test(basename(execPath));

type GhRelease = { tag_name: string; prerelease: boolean; assets: { name: string; browser_download_url: string }[] };

const isRelease = (v: unknown): v is GhRelease =>
  typeof v === "object" &&
  v !== null &&
  typeof (v as GhRelease).tag_name === "string" &&
  Array.isArray((v as GhRelease).assets);

/** Stable: the `releases/latest` object. Dev: the first prerelease tagged `dev-*` in the `releases` list. */
export function selectRelease(channel: Channel, body: unknown): GhRelease | undefined {
  if (channel === "stable") return isRelease(body) ? body : undefined;
  if (!Array.isArray(body)) return undefined;
  return body.find((r) => isRelease(r) && r.prerelease === true && r.tag_name.startsWith("dev-"));
}

export function findAsset(release: GhRelease, platform: string): ReleaseAsset | undefined {
  const name = `nod-${platform}.tar.gz`;
  const archive = release.assets.find((a) => a.name === name);
  const sum = release.assets.find((a) => a.name === `${name}.sha256`);
  if (!archive || !sum) return undefined;
  return { tag: release.tag_name, name, url: archive.browser_download_url, sha256Url: sum.browser_download_url };
}

async function get(fetch: Fetch, url: string): Promise<Response> {
  const res = await fetch(url, { headers: { Accept: "application/vnd.github+json", "User-Agent": "nod" } });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res;
}

export async function checkForUpdate(o: {
  fetch: Fetch;
  currentVersion: string;
  channel: Channel;
  platform?: string;
}): Promise<UpdateCheck> {
  const current = versionLabel(o.currentVersion);
  const platform = o.platform ?? platformName();
  let body: unknown;
  try {
    const url = o.channel === "stable" ? `${RELEASES_API}/latest` : `${RELEASES_API}?per_page=30`;
    body = await (await get(o.fetch, url)).json();
  } catch {
    return { current, latest: "", status: "failed", error: "failed to fetch latest version from GitHub" };
  }
  const release = selectRelease(o.channel, body);
  if (!release) return { current, latest: "", status: "failed", error: `no ${o.channel} release found` };
  const latest = versionLabel(release.tag_name);
  const asset = findAsset(release, platform);
  if (!asset) return { current, latest, status: "failed", error: `no release asset for ${platform}` };
  return {
    current,
    latest,
    asset,
    status: shouldInstall(release.tag_name, o.currentVersion) ? "available" : "up_to_date",
  };
}

const checksumHex = (raw: string) => /^[0-9a-fA-F]{64}/.exec(raw.trim())?.[0]?.toLowerCase();

/** Downloads into tmpDir, verifies the published sha256, extracts, and renames the new binary over execPath. */
export async function installUpdate(o: {
  fetch: Fetch;
  asset: ReleaseAsset;
  execPath: string;
  tmpDir: string;
}): Promise<void> {
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await (await get(o.fetch, o.asset.url)).arrayBuffer());
  } catch {
    throw new Error("failed to download release archive");
  }
  let expected: string | undefined;
  try {
    expected = checksumHex(await (await get(o.fetch, o.asset.sha256Url)).text());
  } catch {
    throw new Error("failed to fetch checksum");
  }
  if (!expected || createHash("sha256").update(bytes).digest("hex") !== expected)
    throw new Error("downloaded archive failed integrity check");
  const archive = join(o.tmpDir, "nod.tar.gz");
  writeFileSync(archive, bytes);
  const tar = Bun.spawnSync(["tar", "-xzf", archive, "-C", o.tmpDir], { stdout: "ignore", stderr: "ignore" });
  if (tar.exitCode !== 0) throw new Error("failed to extract release archive");
  // Stage next to the target so the final rename is atomic and never crosses filesystems.
  const staged = join(dirname(o.execPath), `.${basename(o.execPath)}.new`);
  try {
    copyFileSync(join(o.tmpDir, "nod"), staged);
    chmodSync(staged, 0o755);
    renameSync(staged, o.execPath);
  } catch {
    rmSync(staged, { force: true });
    throw new Error("failed to replace binary (permission denied?)");
  }
}

export type UpgradeOptions = {
  fetch: Fetch;
  currentVersion: string;
  channel: Channel;
  execPath: string;
  tmpDir?: string;
  platform?: string;
};

/** Check then install; never throws, the outcome is in `status`/`error`. */
export async function upgrade(o: UpgradeOptions): Promise<UpgradeResult> {
  const base = { current: versionLabel(o.currentVersion), latest: "", channel: o.channel };
  if (isSourceRun(o.execPath)) return { ...base, status: "failed", error: SOURCE_RUN_MESSAGE };
  const check = await checkForUpdate(o);
  if (check.status === "failed" || !check.asset)
    return { ...base, latest: check.latest, status: "failed", error: check.error };
  if (check.status === "up_to_date") return { ...base, latest: check.latest, status: "up_to_date" };
  const tmp = mkdtempSync(join(o.tmpDir ?? tmpdir(), "nod-upgrade-"));
  try {
    await installUpdate({ fetch: o.fetch, asset: check.asset, execPath: o.execPath, tmpDir: tmp });
    return { ...base, latest: check.latest, status: "upgraded" };
  } catch (e) {
    return { ...base, latest: check.latest, status: "failed", error: (e as Error).message };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export function formatUpgrade(r: UpgradeResult, fmt: "json" | "text"): string {
  if (fmt === "json") {
    const { current, latest, channel, status, error } = r;
    return `${JSON.stringify({ kind: "upgrade", current, latest, channel, status, ...(error ? { error } : {}) })}\n`;
  }
  if (r.status === "failed") return `error: ${r.error ?? "upgrade failed"}\n`;
  if (r.status === "upgraded") return `upgraded to ${displayVersion(r.latest)}\n`;
  return `nod is already up to date (${displayVersion(r.latest)})\n`;
}

/**
 * Interactive auto-upgrade: `poll()` checks at most every 30 minutes, installs a newer build in the background,
 * and answers the footer label once it is ready (`undefined` while nothing needs showing).
 * Disabled by `auto_upgrade: false` / `NOD_AUTO_UPGRADE=0` (already folded into config) and when running from source.
 */
export function createAutoUpgrade(o: {
  fetch: Fetch;
  config: Pick<ResolvedConfig, "autoUpgrade" | "updateChannel">;
  now: () => number;
  currentVersion: string;
  execPath?: string;
  tmpDir?: string;
  platform?: string;
}): { poll(): Promise<UpdateStatus | undefined> } {
  const execPath = o.execPath ?? process.execPath;
  const enabled = o.config.autoUpgrade && !isSourceRun(execPath);
  let lastCheck = Number.NEGATIVE_INFINITY;
  let status: UpdateStatus | undefined;
  let inflight: Promise<UpdateStatus | undefined> | undefined;
  return {
    poll() {
      if (!enabled || status?.state === "ready") return Promise.resolve(status);
      if (inflight) return inflight;
      if (o.now() - lastCheck < CHECK_INTERVAL_MS) return Promise.resolve(status);
      lastCheck = o.now();
      inflight = upgrade({ ...o, channel: o.config.updateChannel, execPath })
        .then((r) => {
          status =
            r.status === "upgraded"
              ? { state: "ready", latest: r.latest, label: READY_LABEL }
              : r.status === "failed"
                ? { state: "failed", latest: r.latest, label: "upgrade failed" }
                : undefined;
          return status;
        })
        .finally(() => {
          inflight = undefined;
        });
      return inflight;
    },
  };
}
