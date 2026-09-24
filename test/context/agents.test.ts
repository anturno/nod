import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gatherProjectContext } from "../../src/core/context/agents.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nod-agents-"));
});
afterEach(() => rmSync(home, { recursive: true, force: true }));

const limits = (file = 65536, total = 131072) => ({
  project_instruction_file_bytes: { value: file, source: "compiled default" as const, bytes: file },
  project_instructions_total_bytes: { value: total, source: "compiled default" as const, bytes: total },
});

const write = (path: string, text: string) => {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, text);
};

test("global, ancestor, project and target scopes render in order", () => {
  const ws = join(home, "dev", "proj");
  write(join(home, ".nod", "AGENTS.md"), "global");
  write(join(home, "dev", "AGENTS.md"), "ancestor");
  write(join(ws, "AGENTS.md"), "project");
  write(join(ws, "apps", "web", "AGENTS.md"), "web");
  mkdirSync(join(ws, "apps", "web", "src"), { recursive: true });
  const ctx = gatherProjectContext({
    home,
    workspaceRoot: ws,
    targets: [join(ws, "apps/web/src/a.ts")],
    limits: limits(),
    enabled: true,
  });
  expect(ctx.text).toBe(
    [
      "<project-instructions-guidance>\nDirect user instructions take precedence over project instructions. When project instructions conflict, follow the narrowest applicable project scope.\n</project-instructions-guidance>",
      `<global-rules from="${join(home, ".nod", "AGENTS.md")}">\nglobal\n</global-rules>`,
      `<scoped-rules from="${join(home, "dev", "AGENTS.md")}" scope="dev">\nancestor\n</scoped-rules>`,
      `<project-rules from="${join(ws, "AGENTS.md")}">\nproject\n</project-rules>`,
      `<scoped-rules from="${join(ws, "apps", "web", "AGENTS.md")}" scope="apps/web">\nweb\n</scoped-rules>`,
    ].join("\n\n"),
  );
  expect(ctx.delivered).toHaveLength(4);
  const packages = gatherProjectContext({
    home,
    workspaceRoot: ws,
    targets: [join(ws, "packages/x.ts")],
    limits: limits(),
    enabled: true,
  });
  expect(packages.text).not.toContain("apps/web");
});

test("disabled, outside-home omission hidden, symlink escape omitted", () => {
  const ws = join(home, "ws");
  write(join(ws, "AGENTS.md"), "p");
  expect(gatherProjectContext({ home, workspaceRoot: ws, limits: limits(), enabled: false }).text).toBe("");
  const outside = mkdtempSync(join(tmpdir(), "nod-outside-"));
  try {
    write(join(outside, "AGENTS.md"), "o");
    const ctx = gatherProjectContext({ home, workspaceRoot: outside, limits: limits(), enabled: true });
    expect(ctx.text).toContain('reason="home_outside_workspace"');
    expect(ctx.notices).toHaveLength(0);
    const linked = join(home, "linked");
    mkdirSync(linked);
    symlinkSync(join(outside, "AGENTS.md"), join(linked, "AGENTS.md"));
    const sym = gatherProjectContext({ home, workspaceRoot: linked, limits: limits(), enabled: true });
    expect(sym.text).toContain('reason="symlink"');
  } finally {
    rmSync(outside, { recursive: true, force: true });
  }
});

test("per-file truncation marker cuts at a line boundary and total cap keeps global then narrowest", () => {
  const ws = join(home, "ws");
  write(join(home, ".nod", "AGENTS.md"), "g");
  write(join(ws, "AGENTS.md"), "line one\nline two\nline three\n");
  const ctx = gatherProjectContext({ home, workspaceRoot: ws, limits: limits(20), enabled: true });
  expect(ctx.text).toContain("<project-rules from=");
  expect(ctx.text).toContain("line one\nline two\n</project-rules>");
  expect(ctx.text).toContain('<context_limit name="project_instruction_file_bytes" action="truncated"');
  expect(ctx.notices[0]).toContain("truncated: observed=29 bytes effective=20 bytes");
  write(join(ws, "a", "AGENTS.md"), "a".repeat(50));
  write(join(ws, "a", "b", "AGENTS.md"), "narrow");
  mkdirSync(join(ws, "a", "b", "c"), { recursive: true });
  const capped = gatherProjectContext({
    home,
    workspaceRoot: ws,
    targets: [join(ws, "a/b/c")],
    limits: limits(65536, 420),
    enabled: true,
  });
  expect(capped.text).toContain("<global-rules");
  expect(capped.text).toContain("narrow");
  expect(capped.text).not.toContain("aaaaaaaa");
  expect(capped.text).toContain('action="omitted" omitted_count="');
  expect(capped.notices.some((n) => n.includes("project instructions omitted"))).toBe(true);
});
