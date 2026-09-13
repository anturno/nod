/** Paths under ~/.nod/sessions/<id>/ and the deps object every session function takes. */
import { mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { validateSessionId } from "./id.ts";

/** `home` is the resolved ~/.nod path (the config module resolves NOD_HOME); `cwd` is the workspace. */
export type SessionDeps = { home: string; cwd: string; now: () => number };

export const MANIFEST_FILE = "session.json";
export const EVENTS_FILE = "events.jsonl";
export const RECOVERY_FILE = "recovery.json";
export const LOCK_FILE = "session.lock";
export const RESULTS_DIR = "results";

export const sessionsDir = (deps: Pick<SessionDeps, "home">) => join(deps.home, "sessions");
export const sessionDir = (deps: Pick<SessionDeps, "home">, id: string) =>
  join(sessionsDir(deps), validateSessionId(id));
/** Workspace roots are compared byte-for-byte, so normalize once at the boundary. */
export const workspaceRoot = (cwd: string) => resolve(cwd);

export function ensurePrivateDir(dir: string) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
}

/** temp+rename so readers never see a half-written file. */
export function writeAtomic(path: string, contents: string) {
  const tmp = `${path}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, contents, { mode: 0o600 });
  renameSync(tmp, path);
}
