/** What the draft is asking for (`/` commands, `@` files, `$` skills) and the workspace file index behind `@`. */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import type { Editor } from "./composer.ts";

export type ActiveQuery =
  | { kind: "slash"; prefix: string }
  | { kind: "file"; tokenStart: number; query: string }
  | { kind: "skill"; tokenStart: number; query: string };
/** The query esc put away; editing the token re-arms the picker. */
export type Dismissed = { kind: ActiveQuery["kind"]; tokenStart: number; query: string } | null;

const TERMINATOR = /[\s"'`]/;

export function activeQuery(editor: Editor, dismissed: Dismissed = null): ActiveQuery | null {
  const { text, cursor } = editor;
  const before = text.slice(0, cursor);
  let found: ActiveQuery | null = null;
  if (before.startsWith("/") && !/\s/.test(before)) found = { kind: "slash", prefix: before };
  else {
    let start = cursor;
    while (start > 0 && !TERMINATOR.test(text[start - 1] as string)) start--;
    const token = text.slice(start, cursor);
    const sigil = token[0];
    if ((sigil === "@" || sigil === "$") && (start === 0 || TERMINATOR.test(text[start - 1] as string)))
      found = { kind: sigil === "@" ? "file" : "skill", tokenStart: start, query: token.slice(1) };
  }
  if (!found || !dismissed || dismissed.kind !== found.kind) return found;
  const start = found.kind === "slash" ? 0 : found.tokenStart;
  const query = found.kind === "slash" ? found.prefix : found.query;
  return dismissed.tokenStart === start && dismissed.query === query ? null : found;
}

export const dismissQuery = (q: ActiveQuery): Dismissed =>
  q.kind === "slash"
    ? { kind: "slash", tokenStart: 0, query: q.prefix }
    : { kind: q.kind, tokenStart: q.tokenStart, query: q.query };

export const FILE_INDEX_CAP = 20_000;
export const MAX_INDEXED_PATH = 2048;
export const PICKER_ROWS = 8;

/** `git ls-files` (tracked plus untracked, unignored) or a walk that skips .git; capped, paths ≤ 2048 bytes. */
export function buildFileIndex(cwd: string): string[] {
  const git = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
    cwd,
    stdout: "pipe",
    stderr: "ignore",
  });
  let paths: string[];
  if (git.exitCode === 0) paths = git.stdout.toString().split("\0").filter(Boolean);
  else {
    paths = [];
    const stack = [""];
    while (stack.length && paths.length < FILE_INDEX_CAP) {
      const rel = stack.pop() as string;
      let entries: import("node:fs").Dirent[];
      try {
        entries = readdirSync(join(cwd, rel), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.name === ".git") continue;
        const path = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory()) stack.push(path);
        else if (paths.length < FILE_INDEX_CAP) paths.push(path);
      }
    }
    paths.sort();
  }
  return paths.filter((p) => Buffer.byteLength(p) <= MAX_INDEXED_PATH).slice(0, FILE_INDEX_CAP);
}

const fold = (s: string) => s.toLowerCase();

/** Higher is better; null when `query` is not a subsequence of `candidate`. Contiguous runs score best. */
export function subsequenceScore(query: string, candidate: string): number | null {
  const q = fold(query);
  const c = fold(candidate);
  if (q.length === 0) return 0;
  let spans = 0;
  let at = -1;
  let first = -1;
  for (let i = 0; i < q.length; i++) {
    const next = c.indexOf(q[i] as string, at + 1);
    if (next === -1) return null;
    if (next !== at + 1) spans++;
    if (first === -1) first = next;
    at = next;
  }
  const spread = at - first + 1 - q.length;
  const inBasename = c.lastIndexOf("/") < first ? 1 : 0;
  return 10_000 - spans * 100 - spread * 5 - c.length + inBasename * 50;
}

export function matchPaths(index: string[], query: string, limit = PICKER_ROWS): string[] {
  if (!query) return index.slice(0, limit);
  const scored: { path: string; score: number }[] = [];
  for (const path of index) {
    const score = subsequenceScore(query, path);
    if (score !== null) scored.push({ path, score });
  }
  scored.sort((a, b) => b.score - a.score || a.path.localeCompare(b.path));
  return scored.slice(0, limit).map((s) => s.path);
}
