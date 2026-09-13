import { mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { ToolContext } from "../../src/core/tools/spec.ts";

export function tempWorkspace(): string {
  return realpathSync.native(mkdtempSync(join(tmpdir(), "nod-tools-")));
}

export function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
}

export function makeCtx(workspaceRoot: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    workspaceRoot,
    cwd: workspaceRoot,
    home: join(workspaceRoot, "..", "home-does-not-exist"),
    resultDir: join(workspaceRoot, ".results"),
    sessionId: "test",
    maxToolResultBytes: 64 * 1024,
    images: [],
    additionalDirectories: [],
    ...overrides,
  };
}

export function decodeOk<T>(result: { ok: true; input: T } | { ok: false; failure: string }): T {
  if (!result.ok) throw new Error(`decode failed: ${result.failure}`);
  return result.input;
}

export function decodeFail<T>(result: { ok: true; input: T } | { ok: false; failure: string }): string {
  if (result.ok) throw new Error("expected decode failure");
  return result.failure;
}
