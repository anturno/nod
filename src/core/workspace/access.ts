/** The primary workspace plus up to 16 additional directories: saved in settings, added for one run, or both. */
import { lstatSync, realpathSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export const MAX_ADDITIONAL_DIRECTORIES = 16;

export type WorkspaceErrorCode =
  | "InvalidPath"
  | "PathNotFound"
  | "NotDirectory"
  | "UnknownAdditionalDirectory"
  | "PrimaryDirectory"
  | "TooManyDirectories";

const MESSAGES: Record<WorkspaceErrorCode, string> = {
  InvalidPath: "path is invalid",
  PathNotFound: "directory does not exist",
  NotDirectory: "path is not a directory",
  UnknownAdditionalDirectory: "directory is not configured as an additional workspace",
  PrimaryDirectory: "the primary workspace cannot be added or removed",
  TooManyDirectories: "additional directory limit reached",
};

export class WorkspaceError extends Error {
  constructor(public code: WorkspaceErrorCode) {
    super(MESSAGES[code]);
  }
}

export type Entry = { path: string; saved: boolean; commandLine: boolean; available: boolean; active: boolean };
/** A saved spelling and the identity it resolved to (real path, or normalized path when it does not exist). */
export type SavedSource = { source: string; identity: string };

export type AccessScope = {
  primary: string;
  entries: Entry[];
  savedSources: SavedSource[];
  savedSuppressed: boolean;
  limit: typeof MAX_ADDITIONAL_DIRECTORIES;
};

const validInput = (path: string) => path.length > 0 && !path.includes("\0");
const absoluteInput = (primary: string, input: string) => {
  if (!validInput(input)) throw new WorkspaceError("InvalidPath");
  return isAbsolute(input) ? resolve(input) : resolve(primary, input);
};

/** Real path of an existing directory that is not the primary workspace. */
export function canonicalExistingDirectory(primary: string, input: string): string {
  const absolute = absoluteInput(primary, input);
  let canonical: string;
  try {
    canonical = realpathSync(absolute);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === "ENOTDIR") throw new WorkspaceError("NotDirectory");
    if (code === "ENOENT" || code === "EACCES" || code === "EPERM" || code === "ELOOP" || code === "ENAMETOOLONG")
      throw new WorkspaceError("PathNotFound");
    throw new WorkspaceError("InvalidPath");
  }
  if (!lstatSync(canonical).isDirectory()) throw new WorkspaceError("NotDirectory");
  if (canonical === primary) throw new WorkspaceError("PrimaryDirectory");
  return canonical;
}

/** Identity for a stored path: its real path when it exists, else the real path of its nearest existing ancestor plus the rest. */
export function resolveSavedDirectory(primary: string, input: string): { path: string; available: boolean } {
  if (!validInput(input) || !isAbsolute(input)) throw new WorkspaceError("InvalidPath");
  try {
    return { path: canonicalExistingDirectory(primary, input), available: true };
  } catch (err) {
    const code = (err as WorkspaceError).code;
    if (code !== "PathNotFound" && code !== "NotDirectory") throw err;
  }
  const normalized = resolve(input);
  if (normalized === primary) throw new WorkspaceError("PrimaryDirectory");
  let existing = normalized;
  while (existing !== dirname(existing)) {
    try {
      const real = realpathSync(existing);
      return { path: join(real, relative(existing, normalized)), available: false };
    } catch {
      existing = dirname(existing);
    }
  }
  return { path: normalized, available: false };
}

function appendOrMerge(entries: Entry[], entry: Omit<Entry, "active">) {
  const existing = entries.find((e) => e.path === entry.path);
  if (existing) {
    existing.saved ||= entry.saved;
    existing.commandLine ||= entry.commandLine;
    existing.available ||= entry.available;
    return;
  }
  if (entries.length >= MAX_ADDITIONAL_DIRECTORIES) throw new WorkspaceError("TooManyDirectories");
  entries.push({ ...entry, active: false });
}

/** Runtime access = saved directories ∪ `--add-dir`; `--no-additional-dirs` keeps saved ones listed but inactive. */
export function resolveAccess(
  { cwd }: { home?: string; cwd: string },
  saved: string[],
  { addDirs = [], suppressSaved = false }: { addDirs?: string[]; suppressSaved?: boolean } = {},
): AccessScope {
  const primary = cwd;
  const entries: Entry[] = [];
  const savedSources: SavedSource[] = [];
  for (const source of saved) {
    const resolved = resolveSavedDirectory(primary, source);
    appendOrMerge(entries, { path: resolved.path, saved: true, commandLine: false, available: resolved.available });
    savedSources.push({ source, identity: resolved.path });
  }
  for (const path of addDirs) {
    const canonical = canonicalExistingDirectory(primary, path);
    appendOrMerge(entries, { path: canonical, saved: false, commandLine: true, available: true });
  }
  for (const entry of entries) entry.active = entry.available && (entry.commandLine || (entry.saved && !suppressSaved));
  return { primary, entries, savedSources, savedSuppressed: suppressSaved, limit: MAX_ADDITIONAL_DIRECTORIES };
}

export function pathInside(root: string, candidate: string): boolean {
  if (root === candidate) return true;
  if (!root || !candidate.startsWith(root)) return false;
  if (root.endsWith(sep)) return true;
  return candidate.length > root.length && candidate[root.length] === sep;
}

/** The primary root or the active additional directory that contains `abs`, else null. */
export function rootForPath(scope: AccessScope, abs: string): string | null {
  if (pathInside(scope.primary, abs)) return scope.primary;
  return scope.entries.find((e) => e.active && pathInside(e.path, abs))?.path ?? null;
}

/** Identity of the directory `input` refers to for removal: a saved spelling, else an entry path. */
export function removalIdentity(scope: AccessScope, input: string): string {
  const normalized = absoluteInput(scope.primary, input);
  const bySource = scope.savedSources.find((s) => absoluteInput(scope.primary, s.source) === normalized);
  if (bySource) return bySource.identity;
  const resolved = resolveSavedDirectory(scope.primary, normalized);
  if (scope.entries.some((e) => e.path === resolved.path)) return resolved.path;
  throw new WorkspaceError("UnknownAdditionalDirectory");
}
