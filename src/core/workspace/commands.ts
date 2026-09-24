/** `nod workspace list|add|remove|clear`: stages the change, persists it under settings.workspaces[primary], reloads. */
import { writeWorkspacePatch } from "../config/settings-store.ts";
import {
  type AccessScope,
  canonicalExistingDirectory,
  type Entry,
  MAX_ADDITIONAL_DIRECTORIES,
  removalIdentity,
  resolveAccess,
  WorkspaceError,
} from "./access.ts";

export type WorkspaceAction =
  | { kind: "list" }
  | { kind: "add"; path: string }
  | { kind: "remove"; path: string }
  | { kind: "clear" };

export type Mutation = {
  action: "add" | "remove" | "clear";
  path?: string;
  savedChanged: boolean;
  runtimeChanged: boolean;
  /** A `--add-dir` directory was removed for this run; repeating the flag brings it back. */
  launchFlagCanRestore: boolean;
};

export type WorkspaceResult = {
  primary: string;
  savedSuppressed: boolean;
  entries: Entry[];
  mutation?: Mutation;
};

export const snapshot = (scope: AccessScope): WorkspaceResult => ({
  primary: scope.primary,
  savedSuppressed: scope.savedSuppressed,
  entries: scope.entries,
});

const sameEntries = (a: Entry[], b: Entry[]) =>
  a.length === b.length &&
  a.every((l, i) => {
    const r = b[i]!;
    return (
      l.path === r.path &&
      l.saved === r.saved &&
      l.commandLine === r.commandLine &&
      l.available === r.available &&
      l.active === r.active
    );
  });

const commandLinePaths = (scope: AccessScope) => scope.entries.filter((e) => e.commandLine).map((e) => e.path);

export function runWorkspaceCommand(
  deps: { home: string },
  action: WorkspaceAction,
  scope: AccessScope,
): { snapshot: WorkspaceResult; mutation?: Mutation; scope: AccessScope } {
  if (action.kind === "list") return { snapshot: snapshot(scope), scope };

  let saved = scope.savedSources.map((s) => s.source);
  let addDirs = commandLinePaths(scope);
  let path: string | undefined;
  if (action.kind === "add") {
    path = action.path;
    const identity = canonicalExistingDirectory(scope.primary, action.path);
    if (!scope.savedSources.some((s) => s.identity === identity)) {
      const isNewEntry = !scope.entries.some((e) => e.path === identity);
      if (isNewEntry && scope.entries.length >= MAX_ADDITIONAL_DIRECTORIES)
        throw new WorkspaceError("TooManyDirectories");
      saved = [...saved, identity];
    }
  } else if (action.kind === "remove") {
    path = action.path;
    const identity = removalIdentity(scope, action.path);
    saved = scope.savedSources.filter((s) => s.identity !== identity).map((s) => s.source);
    addDirs = addDirs.filter((p) => p !== identity);
  } else {
    saved = [];
    addDirs = [];
  }

  const before = scope.savedSources.map((s) => s.source);
  const savedChanged = saved.length !== before.length || saved.some((p, i) => p !== before[i]);
  if (savedChanged)
    writeWorkspacePatch(deps.home, scope.primary, { additional_directories: saved.length ? saved : undefined });

  const next = resolveAccess({ cwd: scope.primary }, saved, { addDirs, suppressSaved: scope.savedSuppressed });
  const mutation: Mutation = {
    action: action.kind,
    path,
    savedChanged,
    runtimeChanged: !sameEntries(scope.entries, next.entries),
    launchFlagCanRestore: scope.entries.some(
      (e) => e.commandLine && !next.entries.some((n) => n.commandLine && n.path === e.path),
    ),
  };
  return { snapshot: { ...snapshot(next), mutation }, mutation, scope: next };
}
