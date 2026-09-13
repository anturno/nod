import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  pathInside,
  resolveAccess,
  resolveSavedDirectory,
  rootForPath,
  type WorkspaceError,
} from "../../src/core/workspace/access.ts";
import { runWorkspaceCommand, snapshot } from "../../src/core/workspace/commands.ts";
import { renderWorkspace } from "../../src/core/workspace/render.ts";

let tmp: string;
let home: string;
let ws: string;
let extra: string;
let other: string;
beforeEach(() => {
  tmp = realpathSync(mkdtempSync(join(tmpdir(), "nod-ws-")));
  home = join(tmp, ".nod");
  ws = join(tmp, "workspace");
  extra = join(tmp, "extra");
  other = join(tmp, "other");
  for (const d of [ws, extra, other]) mkdirSync(d, { recursive: true });
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

const saved = () => {
  try {
    return JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).workspaces?.[ws]?.additional_directories;
  } catch {
    return undefined;
  }
};
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as WorkspaceError).code;
  }
  return "no error";
};

test("pathInside and rootForPath", () => {
  expect(pathInside("/workspace", "/workspace")).toBe(true);
  expect(pathInside("/workspace", "/workspace/file.txt")).toBe(true);
  expect(pathInside("/workspace/", "/workspace/file.txt")).toBe(true);
  expect(pathInside("/workspace", "/workspace2/file.txt")).toBe(false);
  expect(pathInside("", "/x")).toBe(false);
  const scope = resolveAccess({ cwd: ws }, [extra, join(tmp, "missing")], { addDirs: [other] });
  expect(rootForPath(scope, join(ws, "a/b"))).toBe(ws);
  expect(rootForPath(scope, join(extra, "x"))).toBe(extra);
  expect(rootForPath(scope, join(other, "x"))).toBe(other);
  expect(rootForPath(scope, join(tmp, "missing/x"))).toBeNull();
  expect(rootForPath(scope, tmp)).toBeNull();
});

test("resolveAccess merges saved and command-line entries and computes active", () => {
  const scope = resolveAccess({ cwd: ws }, [extra, join(tmp, "missing")], { addDirs: [extra, other] });
  expect(scope.limit).toBe(16);
  expect(scope.entries).toEqual([
    { path: extra, saved: true, commandLine: true, available: true, active: true },
    { path: join(tmp, "missing"), saved: true, commandLine: false, available: false, active: false },
    { path: other, saved: false, commandLine: true, available: true, active: true },
  ]);
  const suppressed = resolveAccess({ cwd: ws }, [extra], { addDirs: [other], suppressSaved: true });
  expect(suppressed.savedSuppressed).toBe(true);
  expect(suppressed.entries.map((e) => e.active)).toEqual([false, true]);
  expect(code(() => resolveAccess({ cwd: ws }, [], { addDirs: [join(tmp, "missing")] }))).toBe("PathNotFound");
  expect(code(() => resolveAccess({ cwd: ws }, [], { addDirs: [ws] }))).toBe("PrimaryDirectory");
  expect(code(() => resolveAccess({ cwd: ws }, ["relative"]))).toBe("InvalidPath");
  writeFileSync(join(tmp, "file"), "");
  expect(code(() => resolveAccess({ cwd: ws }, [], { addDirs: [join(tmp, "file")] }))).toBe("NotDirectory");
  expect(code(() => resolveAccess({ cwd: ws }, [], { addDirs: [join(tmp, "file/x")] }))).toBe("NotDirectory");
  const many = Array.from({ length: 17 }, (_, i) => join(tmp, `d${i}`));
  expect(code(() => resolveAccess({ cwd: ws }, many))).toBe("TooManyDirectories");
});

test("saved directories resolve through symlinks and nearest existing ancestor", () => {
  symlinkSync(extra, join(tmp, "link"));
  expect(resolveSavedDirectory(ws, join(tmp, "link"))).toEqual({ path: extra, available: true });
  expect(resolveSavedDirectory(ws, join(tmp, "link/gone/deeper"))).toEqual({
    path: join(extra, "gone/deeper"),
    available: false,
  });
  expect(code(() => resolveSavedDirectory(ws, join(tmp, "workspace/../workspace")))).toBe("PrimaryDirectory");
});

test("add persists the canonical path and reports changes", () => {
  symlinkSync(extra, join(tmp, "link"));
  const scope = resolveAccess({ cwd: ws }, []);
  const added = runWorkspaceCommand({ home }, { kind: "add", path: join(tmp, "link") }, scope);
  expect(saved()).toEqual([extra]);
  expect(added.mutation).toEqual({
    action: "add",
    path: join(tmp, "link"),
    savedChanged: true,
    runtimeChanged: true,
    launchFlagCanRestore: false,
  });
  expect(added.snapshot.entries).toEqual([
    { path: extra, saved: true, commandLine: false, available: true, active: true },
  ]);

  const again = runWorkspaceCommand({ home }, { kind: "add", path: extra }, added.scope);
  expect(again.mutation).toMatchObject({ savedChanged: false, runtimeChanged: false });
  expect(code(() => runWorkspaceCommand({ home }, { kind: "add", path: ws }, added.scope))).toBe("PrimaryDirectory");
  expect(code(() => runWorkspaceCommand({ home }, { kind: "add", path: join(tmp, "nope") }, added.scope))).toBe(
    "PathNotFound",
  );

  // A command-line directory becomes saved as well.
  const cli = resolveAccess({ cwd: ws }, [extra], { addDirs: [other] });
  const promoted = runWorkspaceCommand({ home }, { kind: "add", path: other }, cli);
  expect(saved()).toEqual([extra, other]);
  expect(promoted.mutation).toMatchObject({ savedChanged: true, runtimeChanged: true });
  expect(promoted.snapshot.entries[1]).toEqual({
    path: other,
    saved: true,
    commandLine: true,
    available: true,
    active: true,
  });
});

test("add enforces the limit across saved and command-line entries", () => {
  const dirs = Array.from({ length: 16 }, (_, i) => {
    const d = join(tmp, `d${i}`);
    mkdirSync(d);
    return d;
  });
  const scope = resolveAccess({ cwd: ws }, dirs.slice(0, 8), { addDirs: dirs.slice(8) });
  expect(code(() => runWorkspaceCommand({ home }, { kind: "add", path: extra }, scope))).toBe("TooManyDirectories");
  expect(runWorkspaceCommand({ home }, { kind: "add", path: dirs[15]! }, scope).mutation?.savedChanged).toBe(true);
});

test("remove accepts saved spellings and entry identities; clear drops everything", () => {
  symlinkSync(extra, join(tmp, "link"));
  const missing = join(tmp, "missing");
  const scope = resolveAccess({ cwd: ws }, [join(tmp, "link"), missing], { addDirs: [other] });
  const removed = runWorkspaceCommand({ home }, { kind: "remove", path: join(tmp, "link") }, scope);
  expect(saved()).toEqual([missing]);
  expect(removed.mutation).toMatchObject({ action: "remove", savedChanged: true, runtimeChanged: true });
  expect(removed.snapshot.entries.map((e) => e.path)).toEqual([missing, other]);

  const byIdentity = runWorkspaceCommand({ home }, { kind: "remove", path: `${missing}/` }, removed.scope);
  expect(saved()).toBeUndefined();
  expect(byIdentity.snapshot.entries.map((e) => e.path)).toEqual([other]);

  const cliOnly = runWorkspaceCommand({ home }, { kind: "remove", path: other }, byIdentity.scope);
  expect(cliOnly.mutation).toEqual({
    action: "remove",
    path: other,
    savedChanged: false,
    runtimeChanged: true,
    launchFlagCanRestore: true,
  });
  expect(cliOnly.snapshot.entries).toEqual([]);
  expect(code(() => runWorkspaceCommand({ home }, { kind: "remove", path: extra }, cliOnly.scope))).toBe(
    "UnknownAdditionalDirectory",
  );

  const full = resolveAccess({ cwd: ws }, [extra], { addDirs: [other] });
  const cleared = runWorkspaceCommand({ home }, { kind: "clear" }, full);
  expect(saved()).toBeUndefined();
  expect(cleared.mutation).toEqual({
    action: "clear",
    path: undefined,
    savedChanged: true,
    runtimeChanged: true,
    launchFlagCanRestore: true,
  });
  expect(cleared.snapshot.entries).toEqual([]);
  expect(runWorkspaceCommand({ home }, { kind: "list" }, cleared.scope).mutation).toBeUndefined();
});

test("renders text and json like fx", () => {
  const scope = resolveAccess({ cwd: ws }, [extra], { addDirs: [other], suppressSaved: true });
  expect(renderWorkspace(snapshot(scope), "text")).toBe(
    `[workspace] primary=${ws}\n[workspace] saved_suppressed=true limit=16\n[workspace] additional directories:\n - ${extra} saved=true command_line=false available=true active=false\n - ${other} saved=false command_line=true available=true active=true\n`,
  );
  expect(JSON.parse(renderWorkspace(snapshot(scope), "json"))).toEqual({
    kind: "workspace",
    action: "list",
    changed: false,
    primary_directory: ws,
    saved_suppressed: true,
    limit: 16,
    additional_directories: [
      { path: extra, saved: true, command_line: false, available: true, active: false },
      { path: other, saved: false, command_line: true, available: true, active: true },
    ],
  });
  expect(renderWorkspace(snapshot(resolveAccess({ cwd: ws }, [])), "text")).toBe(
    `[workspace] primary=${ws}\n[workspace] saved_suppressed=false limit=16\n[workspace] additional directories: (none)\n`,
  );

  const removed = runWorkspaceCommand({ home }, { kind: "remove", path: other }, scope);
  const text = renderWorkspace(removed.snapshot, "text");
  expect(text).toContain(
    `[workspace] remove ${other} saved_changed=false runtime_changed=true launch_flag_can_restore=true\n`,
  );
  expect(text).toContain("[workspace] warning: repeating --add-dir can restore removed access on the next launch\n");
  expect(renderWorkspace(removed.snapshot, "json")).toBe(
    `{"kind":"workspace","action":"remove","changed":true,"primary_directory":${JSON.stringify(ws)},"saved_suppressed":true,"limit":16,"path":${JSON.stringify(other)},"saved_changed":false,"runtime_changed":true,"launch_flag_can_restore":true,"additional_directories":[{"path":${JSON.stringify(extra)},"saved":true,"command_line":false,"available":true,"active":false}]}`,
  );
  expect(renderWorkspace({ primary: "/a\x07b", savedSuppressed: false, entries: [] }, "text")).toStartWith(
    "[workspace] primary=/a�b\n",
  );
});
