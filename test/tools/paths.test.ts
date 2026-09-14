import { describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { resolvePath } from "../../src/core/tools/paths.ts";
import { tempWorkspace } from "./helpers.ts";

describe("paths", () => {
  const root = tempWorkspace();
  const ws = join(root, "workspace");
  const home = join(root, "home");
  const external = join(root, "external");
  for (const dir of [join(ws, "src"), home, external]) mkdirSync(dir, { recursive: true });
  writeFileSync(join(ws, "src", "a.ts"), "a");
  writeFileSync(join(home, "notes.txt"), "n");
  writeFileSync(join(external, "x.txt"), "x");

  test("workspace-relative, home, absolute, and escapes", () => {
    expect(resolvePath(ws, "src/a.ts", home)).toEqual({
      absolute: join(ws, "src", "a.ts"),
      external: false,
      display: "src/a.ts",
    });
    expect(resolvePath(ws, " ./src/../src/a.ts ", home).display).toBe("src/a.ts");
    expect(resolvePath(ws, ".", home)).toEqual({ absolute: ws, external: false, display: "." });
    expect(resolvePath(ws, "~/notes.txt", home)).toEqual({
      absolute: join(home, "notes.txt"),
      external: true,
      display: join(home, "notes.txt"),
    });
    expect(resolvePath(ws, "~", home).absolute).toBe(home);
    expect(resolvePath(ws, "../external/x.txt", home)).toMatchObject({
      absolute: join(external, "x.txt"),
      external: true,
    });
    expect(resolvePath(ws, join(external, "x.txt"), home).external).toBe(true);
    expect(resolvePath(ws, "../workspace/src/a.ts", home).external).toBe(false);
    expect(resolvePath(ws, "src/new/file.ts", home)).toMatchObject({
      absolute: join(ws, "src", "new", "file.ts"),
      external: false,
    });
  });

  test("additional directories are not external", () => {
    expect(resolvePath(ws, join(external, "x.txt"), home, [external]).external).toBe(false);
    expect(resolvePath(ws, join(external, "x.txt"), home, [external]).display).toBe(join(external, "x.txt"));
  });

  test("invalid inputs", () => {
    for (const input of ["", "   \t\n ", "~other", "~other/file.txt", "~~", "~ user/x"]) {
      expect(() => resolvePath(ws, input, home)).toThrow("InvalidPath");
    }
    expect(() => resolvePath(ws, "~/x", null)).toThrow("HomeNotSet");
    expect(() => resolvePath(ws, "~", "relative/home")).toThrow("InvalidPath");
  });

  test("symlinked workspace roots compare canonically", () => {
    const link = join(root, "ws-link");
    symlinkSync(ws, link);
    expect(resolvePath(link, "src/a.ts", home)).toEqual({
      absolute: join(ws, "src", "a.ts"),
      external: false,
      display: "src/a.ts",
    });
  });
});
