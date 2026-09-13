/** Resolves model-supplied paths against the workspace, home, and additional directories. */
import { realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

export type ResolvedPath = { absolute: string; external: boolean; display: string };

/** message is the fx error name: InvalidPath or HomeNotSet. */
export class PathError extends Error {}

/** realpath of the nearest existing ancestor plus the missing tail, so symlinked roots compare equal. */
export function canonical(path: string): string {
  const tail: string[] = [];
  let current = path;
  for (;;) {
    try {
      return join(realpathSync.native(current), ...tail.reverse());
    } catch {
      const parent = dirname(current);
      if (parent === current) return path;
      tail.push(basename(current));
      current = parent;
    }
  }
}

export function pathInside(root: string, candidate: string): boolean {
  if (root === candidate) return true;
  if (root.length === 0) return false;
  const prefix = root.endsWith(sep) ? root : root + sep;
  return candidate.startsWith(prefix);
}

// ponytail: a workspace-relative symlink escaping the workspace resolves as external (subject to permission policy)
// rather than fx's hard PathOutsideWorkspace rejection; tighten if that ever matters.
export function resolvePath(
  workspaceRoot: string,
  input: string,
  home: string | null | undefined,
  additionalDirectories: string[] = [],
): ResolvedPath {
  const cleaned = input.trim();
  if (cleaned.length === 0 || cleaned.includes("\0")) throw new PathError("InvalidPath");
  let absolute: string;
  if (isAbsolute(cleaned)) absolute = resolve(cleaned);
  else if (cleaned === "~" || cleaned.startsWith("~/")) {
    if (home == null) throw new PathError("HomeNotSet");
    if (home.length === 0 || !isAbsolute(home)) throw new PathError("InvalidPath");
    absolute = resolve(home, cleaned.slice(2));
  } else if (cleaned.startsWith("~")) throw new PathError("InvalidPath");
  else absolute = resolve(workspaceRoot, cleaned);
  absolute = canonical(absolute);
  const root = canonical(workspaceRoot);
  const inWorkspace = pathInside(root, absolute);
  const external = !inWorkspace && !additionalDirectories.some((dir) => pathInside(canonical(dir), absolute));
  const display = inWorkspace ? relative(root, absolute) || "." : absolute;
  return { absolute, external, display };
}
