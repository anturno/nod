import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { grantAllows, grantsAllowAll, suggestedGrants } from "../../src/core/permissions/index.ts";
import type { PermissionTarget } from "../../src/core/tools/spec.ts";

const ws = realpathSync(mkdtempSync(path.join(tmpdir(), "nod-grants-")));
mkdirSync(path.join(ws, "src"));
const external = realpathSync(mkdtempSync(path.join(tmpdir(), "nod-ext-")));

const pathTarget = (absolute: string, permission = "edit"): PermissionTarget => ({
  permission,
  target: absolute.startsWith(ws) ? path.relative(ws, absolute) : absolute,
  kind: "path",
  absolute,
  external: !absolute.startsWith(ws),
});

test("grantAllows: bash exact, web_fetch canonical host, paths by tree or wildcard", () => {
  const grants = [
    { permission: "bash", pattern: "bun test" },
    { permission: "web_fetch", pattern: "domain:example.com" },
    { permission: "edit", pattern: `${ws}/**` },
    { permission: "read", pattern: "/etc/host?" },
  ];
  expect(grantAllows(grants, "bash", "shell", "bun test")).toBe(true);
  expect(grantAllows(grants, "bash", "shell", "bun test x")).toBe(false);
  expect(grantAllows(grants, "web_fetch", "web_fetch", "domain:example.com")).toBe(true);
  expect(grantAllows(grants, "web_fetch", "web_fetch", "domain:evil.com")).toBe(false);
  expect(grantAllows(grants, "web_fetch", "web_fetch", "example.com")).toBe(false);
  expect(grantAllows(grants, "edit", "edit_file", `${ws}/src/a.ts`)).toBe(true);
  expect(grantAllows(grants, "edit", "write_file", `${ws}x/a.ts`)).toBe(false);
  expect(grantAllows(grants, "read", "read_file", "/etc/hosts")).toBe(true);
  expect(grantAllows(grants, "glob", "glob_files", `${ws}/src`)).toBe(false);
  expect(grantsAllowAll(grants, "edit_file", [pathTarget(`${ws}/a.ts`), pathTarget(`${ws}/b.ts`)])).toBe(true);
  expect(grantsAllowAll(grants, "edit_file", [pathTarget(`${ws}/a.ts`), pathTarget(`${external}/b.ts`)])).toBe(false);
});

test("suggestedGrants: exact command, workspace tree for the four path permissions, external dir tree, target otherwise", () => {
  expect(suggestedGrants(ws, [{ permission: "bash", target: "bun test", kind: "command" }])).toEqual([
    { permission: "bash", pattern: "bun test" },
  ]);
  expect(suggestedGrants(ws, [pathTarget(`${ws}/src/a.ts`)])).toEqual(
    ["edit", "read", "glob", "grep"].map((permission) => ({ permission, pattern: `${ws}/**` })),
  );
  expect(suggestedGrants(ws, [pathTarget(`${external}/notes.md`, "read")])).toEqual([
    { permission: "read", pattern: `${external}/**` },
  ]);
  expect(suggestedGrants(ws, [pathTarget(external, "glob")])).toEqual([
    { permission: "glob", pattern: `${external}/**` },
  ]);
  expect(suggestedGrants(ws, [{ permission: "web_fetch", target: "domain:example.com", kind: "host" }])).toEqual([
    { permission: "web_fetch", pattern: "domain:example.com" },
  ]);
  expect(suggestedGrants(ws, [{ permission: "skill", target: "review", kind: "other" }])).toEqual([
    { permission: "skill", pattern: "review" },
  ]);
  expect(suggestedGrants(ws, [pathTarget(`${ws}/a.ts`), pathTarget(`${ws}/b.ts`)])).toHaveLength(4);
});
