import { afterEach, beforeEach, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { HistoryTurn } from "../../src/core/agent/types.ts";
import { readEvents } from "../../src/core/session/events.ts";
import { generateSessionId, SessionError, validateSessionId } from "../../src/core/session/id.ts";
import { readManifest } from "../../src/core/session/manifest.ts";
import { clearRecovery, readRecovery, writeRecovery } from "../../src/core/session/recovery.ts";
import { readToolResult, storeToolResult } from "../../src/core/session/results.ts";
import {
  createSession,
  deleteSession,
  migrateSession,
  openSession,
  readSessionDetail,
  recoverSession,
  renameSession,
  saveTurn,
} from "../../src/core/session/store.ts";

let root: string;
let clock = 1_700_000_000_000;
const deps = () => ({ home: join(root, ".nod"), cwd: join(root, "ws"), now: () => ++clock });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nod-session-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const turn = (text: string, assistant = "ok"): HistoryTurn => ({
  kind: "assistant",
  user: { text },
  assistant,
  execution: { steps: [], steering: [] },
});

test("session ids are 12-char base64url and validation rejects unsafe ids", () => {
  const id = generateSessionId();
  expect(id).toHaveLength(12);
  expect(id).toMatch(/^[A-Za-z0-9_-]+$/);
  for (const bad of ["", ".", "..", "../x", "/tmp/x", "a/b", "a\\b", "a".repeat(256)])
    expect(() => validateSessionId(bad)).toThrow(SessionError);
  for (const ok of ["session.v3", ".hidden", "a..b", "last", "1786460757753-1786460757753277000-ef75d8fd94fdab1"])
    expect(validateSessionId(ok)).toBe(ok);
});

test("create, save turns, reopen with projected history and manifest totals", () => {
  const d = deps();
  const s = createSession(d, { provider: "codex", model: "gpt-5" });
  expect(existsSync(join(s.dir, "session.lock"))).toBe(true);
  saveTurn(s, turn("Fix the login bug\nplease", "done"), { inputTokens: 10, outputTokens: 5 });
  saveTurn(
    s,
    {
      kind: "assistant",
      user: { text: "and tests" },
      assistant: "added",
      execution: {
        steps: [
          {
            assistant: "running",
            toolCalls: [{ id: "c1", name: "bash", arguments: '{"cmd":"ls"}' }],
            results: [{ role: "tool", toolCallId: "c1", name: "bash", content: "a\nb", status: "success" }],
            feedback: [{ role: "user", content: "fine", permissionFeedback: true, toolCallId: "c1" }],
          },
        ],
        steering: [{ text: "hurry", afterStep: 1 }],
      },
    },
    { inputTokens: 1, outputTokens: 1, requestCount: 2 },
  );
  expect(s.manifest.title).toBe("Fix the login bug");
  expect(s.manifest.preview).toBe("Fix the login bug\nplease");
  expect(s.manifest.history_len).toBe(2);
  expect(s.manifest.usage).toMatchObject({ input_tokens: 11, output_tokens: 6, request_count: 3, total_cost: 0 });
  s.close();
  expect(existsSync(join(s.dir, "session.lock"))).toBe(false);

  const again = openSession(d, s.id);
  expect(again.history).toMatchObject(s.history);
  expect(readManifest(again.dir).history_len).toBe(2);
  saveTurn(again, turn("third"));
  expect(readEvents(again.dir).frames.map((f) => f.seq)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13]);
  again.close();
});

test("second open while the pid is alive fails with open_elsewhere; stale pids are ignored", () => {
  const d = deps();
  const s = createSession(d);
  writeFileSync(join(s.dir, "session.lock"), `${process.pid}\n`);
  // same pid re-opening is allowed (single process); simulate another live process with pid 1
  writeFileSync(join(s.dir, "session.lock"), "1\n");
  expect(() => openSession(d, s.id)).toThrow(expect.objectContaining({ code: "open_elsewhere" }));
  expect(() => deleteSession(d, s.id)).toThrow(expect.objectContaining({ code: "open_elsewhere" }));
  writeFileSync(join(s.dir, "session.lock"), "999999999\n");
  const reopened = openSession(d, s.id);
  expect(readFileSync(join(s.dir, "session.lock"), "utf8")).toBe(`${process.pid}\n`);
  reopened.close();
  deleteSession(d, s.id);
  expect(existsSync(s.dir)).toBe(false);
});

test("workspace mismatch needs rebindWorkspace", () => {
  const d = deps();
  const s = createSession(d);
  s.close();
  const other = { ...d, cwd: join(root, "elsewhere") };
  expect(() => openSession(other, s.id)).toThrow(expect.objectContaining({ code: "workspace_mismatch" }));
  const rebound = openSession(other, s.id, { rebindWorkspace: true });
  expect(rebound.manifest.workspace_root).toBe(join(root, "elsewhere"));
  expect(rebound.manifest.origin_workspace_root).toBe(join(root, "ws"));
  rebound.close();
});

test("rename fixes the title and clears title_generated", () => {
  const s = createSession(deps());
  s.manifest.title_generated = true;
  renameSession(s, "  My title ");
  expect(readManifest(s.dir)).toMatchObject({ title: "My title", title_generated: false });
  expect(() => renameSession(s, "  ")).toThrow(SessionError);
  s.close();
});

test("large tool results go to results/<call_id>.txt and read back in bounded slices", () => {
  const s = createSession(deps());
  const small = storeToolResult(s.dir, "c1", "hi");
  expect(small).toEqual({ inline_output: "hi", output_bytes: 2, stored_bytes: 2 });
  const big = "x".repeat(70_000);
  const stored = storeToolResult(s.dir, "c2", big);
  expect(stored).toEqual({ artifact_ref: "results/c2.txt", output_bytes: 70_000, stored_bytes: 70_000 });
  const slice = readToolResult(s.dir, "results/c2.txt");
  expect(slice.text).toHaveLength(64 * 1024);
  expect(slice.truncated).toBe(true);
  const tail = readToolResult(s.dir, "results/c2.txt", 65_536, 10_000);
  expect(tail.text).toHaveLength(70_000 - 65_536);
  expect(tail.truncated).toBe(false);
  expect(() => readToolResult(s.dir, "../session.json")).toThrow(SessionError);
  s.close();
});

test("recovery checkpoint round-trips and clears", () => {
  const s = createSession(deps());
  writeRecovery(s.dir, {
    version: 2,
    disposition: "continuable",
    turn_id: 1,
    user: { text: "hi" },
    assistant_source: "par",
    cause: "provider_error",
    action: "retry",
    tool_state: "none",
    fast_mode: false,
    max_provider_attempts: 3,
    consumed_provider_attempts: 1,
  });
  expect(readRecovery(s.dir)?.assistant_source).toBe("par");
  clearRecovery(s.dir);
  expect(readRecovery(s.dir)).toBeUndefined();
  s.close();
});

test("detail, migrate, and recover on a session with a corrupt middle line", () => {
  const d = deps();
  const s = createSession(d);
  saveTurn(s, turn("one"));
  saveTurn(s, turn("two"));
  s.close();
  expect(migrateSession(d, s.id)).toEqual({
    id: s.id,
    status: "already_current",
    source_schema_version: 1,
    source_bytes: readFileSync(join(s.dir, "events.jsonl")).length,
  });
  const lines = readFileSync(join(s.dir, "events.jsonl"), "utf8").split("\n");
  lines[3] = "{corrupt";
  writeFileSync(join(s.dir, "events.jsonl"), lines.join("\n"));
  expect(() => readSessionDetail(d, s.id)).toThrow(expect.objectContaining({ code: "unreadable" }));
  const r = recoverSession(d, s.id);
  expect(r).toMatchObject({ source_id: s.id, status: "recovered", history_turns: 1 });
  const detail = readSessionDetail(d, r.recovered_id);
  expect(detail.history).toHaveLength(1);
  expect(detail.title).toBe("one");
});

test("a partial trailing line is tolerated and truncated on open", () => {
  const d = deps();
  const s = createSession(d);
  saveTurn(s, turn("one"));
  s.close();
  writeFileSync(join(s.dir, "events.jsonl"), '{"schema_version":1,"seq":4,"time', { flag: "a" });
  const again = openSession(d, s.id);
  expect(again.history).toHaveLength(1);
  expect(readFileSync(join(s.dir, "events.jsonl"), "utf8").endsWith("\n")).toBe(true);
  again.close();
});
