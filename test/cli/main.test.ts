import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { main } from "../../src/cli/main.ts";
import type { Io } from "../../src/cli/output.ts";

let home: string;
let cwd: string;
const realHome = process.env.NOD_HOME;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nod-cli-"));
  cwd = join(home, "ws");
  mkdirSync(cwd);
  // The auth store reads NOD_HOME from the process, so a real login must stay out of these runs.
  process.env.NOD_HOME = home;
});
afterEach(() => {
  process.env.NOD_HOME = realHome;
  rmSync(home, { recursive: true, force: true });
});

async function run(...argv: string[]) {
  let out = "";
  let err = "";
  const io: Io = { stdout: (t) => (out += t), stderr: (t) => (err += t), env: { NOD_HOME: home }, cwd, isTTY: false };
  const code = await main(argv, io);
  return { code, out, err };
}

test("version, help and unknown commands", async () => {
  expect((await run("--version")).out).toMatch(/^nod \d+\.\d+\.\d+\n$/);
  expect((await run("help")).out).toContain("Commands:");
  expect((await run("ask", "--help")).out).toContain("ask");
  const bogus = await run("bogus");
  expect(bogus.code).toBe(1);
  expect(bogus.err).toContain("unknown command: bogus");
});

test("status and doctor without a subscription", async () => {
  const status = await run("status", "--json");
  expect(status.code).toBe(0);
  expect(JSON.parse(status.out)).toMatchObject({
    kind: "status",
    auth: "missing",
    permission_mode: "auto",
    workspace: cwd,
    history_turns: 0,
  });
  expect((await run("status")).out).toContain("[status] auth=missing\n");
  const doctor = await run("doctor", "--json");
  expect(doctor.code).toBe(1);
  expect(JSON.parse(doctor.out).checks.map((c: { name: string; status: string }) => `${c.name}:${c.status}`)).toEqual(
    expect.arrayContaining(["workspace:ok", "auth:fail", "sessions:warn"]),
  );
});

test("sessions, session, usage, workspace and permissions on an empty home", async () => {
  expect(JSON.parse((await run("sessions", "--json")).out)).toEqual({ kind: "sessions", count: 0, sessions: [] });
  expect((await run("sessions")).out).toBe("[sessions] no saved sessions\n");
  const missing = await run("session", "last", "--json");
  expect(missing.code).toBe(1);
  expect(JSON.parse(missing.out).kind).toBe("session");
  expect(JSON.parse((await run("usage", "--json")).out)).toMatchObject({ kind: "usage", period: "30d" });
  expect((await run("usage", "--period", "1y")).code).toBe(1);
  const ws = await run("workspace", "--json");
  expect(JSON.parse(ws.out)).toMatchObject({
    kind: "workspace",
    action: "list",
    primary_directory: cwd,
    additional_directories: [],
  });
  const add = await run("workspace", "add", "/nonexistent-dir-xyz", "--json");
  expect(add.code).toBe(1);
  expect(JSON.parse(add.out).kind).toBe("workspace");
  expect(JSON.parse((await run("permissions", "--json")).out)).toMatchObject({
    kind: "permissions",
    mode: "auto",
    rules: [],
  });
  expect((await run("permissions", "extra")).code).toBe(1);
});

test("ask without a prompt or a subscription reports JSON failures and leaves no session behind", async () => {
  const empty = await run("ask", "--json", "");
  expect(JSON.parse(empty.out)).toMatchObject({ exit_code: 1, error: "PromptEmpty", tool_calls: [] });
  const noAuth = await run("ask", "--json", "hello");
  expect(JSON.parse(noAuth.out)).toMatchObject({ exit_code: 1 });
  expect(JSON.parse(noAuth.out).error).toBe("AuthRequired");
  expect(noAuth.err).toBe("");
  expect(JSON.parse((await run("sessions", "--json")).out).count).toBe(0);
  expect((await run("ask", "--no-save", "--resume", "last", "x")).code).toBe(1);
});
