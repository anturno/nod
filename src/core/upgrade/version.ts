/** Release tags: `v1.2.3` (stable) and `dev-<sha>` (dev prerelease). */

export type Channel = "stable" | "dev";
export type ParsedVersion = { channel: "stable"; parts: [number, number, number] } | { channel: "dev"; sha: string };

export const parseChannel = (raw: string): Channel | undefined => {
  const lower = raw.toLowerCase();
  return lower === "stable" || lower === "dev" ? lower : undefined;
};

/** `v0.1.0`, `0.1.0`, `dev-0123abcd`; anything else is undefined. */
export function parseVersion(raw: string): ParsedVersion | undefined {
  const tag = raw.trim();
  if (tag.startsWith("dev-")) {
    const sha = tag.slice(4).toLowerCase();
    return /^[0-9a-f]{7,64}$/.test(sha) ? { channel: "dev", sha } : undefined;
  }
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(tag);
  if (!m) return undefined;
  return { channel: "stable", parts: [Number(m[1]), Number(m[2]), Number(m[3])] };
}

/** Semver order for stable tags; unparseable tags sort as 0.0.0. */
export function compareVersions(a: string, b: string): -1 | 0 | 1 {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  const partsOf = (p: ParsedVersion | undefined): [number, number, number] =>
    p?.channel === "stable" ? p.parts : [0, 0, 0];
  const [x, y] = [partsOf(pa), partsOf(pb)];
  for (let i = 0; i < 3; i++) {
    const d = (x[i] as number) - (y[i] as number);
    if (d !== 0) return d > 0 ? 1 : -1;
  }
  return 0;
}

/** Same rule as fx: a channel switch always installs; stable installs strictly newer; dev installs a different sha. */
export function shouldInstall(latest: string, current: string): boolean {
  const l = parseVersion(latest);
  const c = parseVersion(current);
  if (!l) return false;
  if (!c || l.channel !== c.channel) return true;
  if (l.channel === "stable") return compareVersions(latest, current) > 0;
  if (c.channel !== "dev") return true;
  const n = Math.min(l.sha.length, c.sha.length);
  return l.sha.slice(0, n) !== c.sha.slice(0, n);
}

/** `v0.1.0` → `0.1.0`; dev tags unchanged. */
export const versionLabel = (tag: string) => (tag.startsWith("v") ? tag.slice(1) : tag);

/** Human label: `v0.1.0` or `dev 0123abcd4567`. */
export const displayVersion = (tag: string) => {
  const p = parseVersion(tag);
  if (p?.channel === "dev") return `dev ${p.sha.slice(0, 12)}`;
  return tag.startsWith("v") ? tag : `v${tag}`;
};
