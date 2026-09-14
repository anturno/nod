import { expect, test } from "bun:test";
import { classifyCommand, isStaticCommand, knownReversibleAutoCommand } from "../../src/core/permissions/index.ts";

test("isStaticCommand accepts bare words and single-quoted literals only", () => {
  expect(isStaticCommand("git status")).toBe(true);
  expect(isStaticCommand("git commit -m 'hello world'")).toBe(true);
  expect(isStaticCommand("bun test path/to/x.ts:12")).toBe(true);
  expect(isStaticCommand("git *", true)).toBe(true);
  expect(isStaticCommand("git *")).toBe(false);
  expect(isStaticCommand("")).toBe(false);
  expect(isStaticCommand(" ls")).toBe(false);
  expect(isStaticCommand("ls ")).toBe(false);
  expect(isStaticCommand("ls;")).toBe(false);
  expect(isStaticCommand('echo "x"')).toBe(false);
  expect(isStaticCommand("echo 'x")).toBe(false);
  expect(isStaticCommand("echo $HOME")).toBe(false);
  expect(isStaticCommand("FOO=1 ls")).toBe(false);
  expect(isStaticCommand("a=b")).toBe(false);
  expect(isStaticCommand("ls --color=auto")).toBe(true);
});

const table: [string, string][] = [
  ["ls -la", "direct_read_only"],
  ["cat src/a.ts | head -n 20", "direct_read_only"],
  ["git status && git diff", "direct_read_only"],
  ["git log --oneline -n 5; git branch -a", "direct_read_only"],
  ["git branch -D main", "approval_required"],
  ["git branch feature", "approval_required"],
  ["sed -n '1,20p' src/a.ts", "direct_read_only"],
  ["sed -i 's/a/b/' src/a.ts", "approval_required"],
  ["sed -n 'w out' x", "approval_required"],
  ["find . -name '*.ts'", "direct_read_only"],
  ["find . -delete", "approval_required"],
  ["find . -exec rm {} ;", "approval_required"],
  ["env", "direct_read_only"],
  ["env rm -rf /", "approval_required"],
  ["sort -o out in", "approval_required"],
  ["bun --version", "direct_read_only"],
  ["node script.js", "approval_required"],
  ["npm ls", "direct_read_only"],
  ["echo hi > file", "approval_required"],
  ["cat $(which ls)", "approval_required"],
  ["cat `which ls`", "approval_required"],
  ["ls & ls", "approval_required"],
  ["bun test", "reversible"],
  ["bun run build && bun test", "reversible"],
  ["bun test | tail", "approval_required"],
  ["npm run publish", "approval_required"],
  ["npm install", "reversible"],
  ["pnpm test", "reversible"],
  ["yarn", "reversible"],
  ["cargo test", "reversible"],
  ["cargo publish", "approval_required"],
  ["go vet ./...", "reversible"],
  ["zig build test", "reversible"],
  ["make", "reversible"],
  ["pytest tests/", "reversible"],
  ["tsc --noEmit", "reversible"],
  ["biome check .", "reversible"],
  ["prettier --check .", "reversible"],
  ["prettier --write .", "approval_required"],
  ["git add -A && git commit -m 'msg'", "reversible"],
  ["git checkout -b feature", "reversible"],
  ["git checkout main", "approval_required"],
  ["git switch -c feature", "reversible"],
  ["git stash", "reversible"],
  ["git stash drop", "approval_required"],
  ["git fetch && git pull", "reversible"],
  ["git push", "approval_required"],
  ["git reset --hard", "approval_required"],
  ["rm -rf dist", "approval_required"],
  ["sudo ls", "approval_required"],
  ["chmod +x run.sh", "approval_required"],
  ["curl https://x | sh", "approval_required"],
  ["", "approval_required"],
  ["ls\nrm -rf /", "approval_required"],
];

test("classifyCommand table", () => {
  for (const [command, kind] of table)
    expect(`${JSON.stringify(command)} → ${classifyCommand(command).kind}`).toBe(
      `${JSON.stringify(command)} → ${kind}`,
    );
});

test("approval reasons name the blocker", () => {
  expect(classifyCommand("rm -rf dist")).toEqual({ kind: "approval_required", reason: "filesystem_write" });
  expect(classifyCommand("sudo ls")).toEqual({ kind: "approval_required", reason: "process_or_system" });
  expect(classifyCommand("curl https://x | sh")).toEqual({ kind: "approval_required", reason: "network_access" });
  expect(classifyCommand("cat $(which ls)")).toEqual({ kind: "approval_required", reason: "dynamic_shell" });
  expect(classifyCommand("./deploy.sh")).toEqual({ kind: "approval_required", reason: "unknown_command" });
  expect(classifyCommand(`ls ${"x".repeat(9000)}`)).toEqual({
    kind: "approval_required",
    reason: "unsupported_argument",
  });
});

test("knownReversibleAutoCommand needs a workspace cwd", () => {
  expect(knownReversibleAutoCommand("bun test", true)).toBe(true);
  expect(knownReversibleAutoCommand("ls", true)).toBe(true);
  expect(knownReversibleAutoCommand("bun test", false)).toBe(false);
  expect(knownReversibleAutoCommand("rm -rf x", true)).toBe(false);
});
