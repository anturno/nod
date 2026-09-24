import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  findLastSession,
  formatCursor,
  languageLabel,
  listSessions,
  parseCursor,
  renderMigration,
  renderRecovery,
  renderSessionDetail,
  renderSessions,
  terminalSafe,
  utcTimestamp,
} from "../../src/core/session/catalog.ts";
import { SessionError } from "../../src/core/session/id.ts";
import { createSession, readSessionDetail, saveTurn } from "../../src/core/session/store.ts";

let root: string;
let clock = 1_700_000_000_000;
const deps = () => ({ home: join(root, ".nod"), cwd: join(root, "ws"), now: () => (clock += 1000) });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "nod-catalog-"));
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

test("cursor is canonical only", () => {
  expect(parseCursor("v1:5:abc")).toEqual({ updated_at_ms: 5, id: "abc" });
  for (const bad of ["", "v2:5:abc", "v1:05:abc", "v1:x:abc", "v1:5:a/b", "v1:5:abc:d", "v1:5"])
    expect(() => parseCursor(bad)).toThrow(SessionError);
  expect(formatCursor({ updated_at_ms: 5, id: "abc" })).toBe("v1:5:abc");
});

test("lists by workspace, paginates with cursor, counts invalid dirs, finds last", () => {
  const d = deps();
  const ids: string[] = [];
  for (let i = 0; i < 3; i++) {
    const s = createSession(d, { id: `s${i}` });
    if (i > 0)
      saveTurn(s, {
        kind: "assistant",
        user: { text: `p${i}` },
        assistant: "",
        execution: { steps: [], steering: [] },
      });
    s.close();
    ids.push(s.id);
  }
  const other = createSession({ ...d, cwd: join(root, "other") }, { id: "other" });
  other.close();
  mkdirSync(join(d.home, "sessions", "broken"));
  writeFileSync(join(d.home, "sessions", "broken", "session.json"), "{nope");

  const page = listSessions(d, { limit: 2 });
  expect(page.sessions.map((s) => s.id)).toEqual(["s2", "s1"]);
  expect(page.has_more).toBe(true);
  expect(page.skipped_invalid).toBe(1);
  const next = listSessions(d, { limit: 2, cursor: page.next_cursor });
  expect(next.sessions.map((s) => s.id)).toEqual(["s0"]);
  expect(next.has_more).toBe(false);
  expect(listSessions(d, { scope: "all" }).sessions.map((s) => s.id)).toEqual(["other", "s2", "s1", "s0"]);
  expect(() => listSessions(d, { limit: 0 })).toThrow(SessionError);
  expect(() => listSessions(d, { limit: 101 })).toThrow(SessionError);
  expect(findLastSession(d)?.id).toBe("s2");
  expect(findLastSession({ ...d, cwd: join(root, "other") })).toBeUndefined();
  expect(findLastSession({ ...d, cwd: join(root, "other") }, "all")?.id).toBe("s2");
});

test("renders sessions text and json exactly", () => {
  const empty = { sessions: [], has_more: false, skipped_invalid: 0, all_workspaces: false };
  expect(renderSessions(empty, "text")).toBe("[sessions] no saved sessions\n");
  expect(renderSessions(empty, "json")).toBe('{"kind":"sessions","count":0,"sessions":[]}');
  const page = {
    sessions: [
      {
        id: "abc",
        title: "Fix\tbug",
        preview: "Fix\tbug",
        workspace_root: "/w",
        origin_workspace_root: "/w",
        created_at_ms: 1_700_000_000_000,
        updated_at_ms: 1_700_000_000_123,
        history_len: 1,
        conversation_language: "en-US",
        has_checkpoint: false,
      },
      {
        id: "def",
        title: null,
        preview: null,
        workspace_root: "/w",
        origin_workspace_root: null as unknown as string,
        created_at_ms: 0,
        updated_at_ms: 0,
        history_len: 0,
        conversation_language: "und",
        has_checkpoint: false,
      },
    ],
    has_more: true,
    next_cursor: "v1:0:def",
    skipped_invalid: 2,
    all_workspaces: true,
  };
  expect(renderSessions(page, "text")).toBe(
    "[sessions] 2 saved\n" +
      " - Fix\\x09bug\n" +
      "   id=abc | 1 turn | English | updated 2023-11-14 22:13:20.123 UTC\n" +
      " - Untitled session\n" +
      "   id=def | 0 turns | updated 1970-01-01 00:00:00.000 UTC\n" +
      "[sessions] more saved sessions; continue with `nod sessions --all --cursor v1:0:def`\n" +
      "[sessions] warning: skipped 2 unreadable saved sessions; run `nod doctor` for recovery guidance\n",
  );
  expect(renderSessions(page, "json")).toBe(
    '{"kind":"sessions","count":2,"skipped_invalid":2,"has_more":true,"next_cursor":"v1:0:def","sessions":[' +
      '{"id":"abc","title":"Fix\\tbug","preview":"Fix\\tbug","workspace_root":"/w","origin_workspace_root":"/w","created_at_ms":1700000000000,"updated_at_ms":1700000000123,"history_len":1,"conversation_language":"en-US"},' +
      '{"id":"def","title":"Untitled session","preview":null,"workspace_root":"/w","origin_workspace_root":null,"created_at_ms":0,"updated_at_ms":0,"history_len":0,"conversation_language":"und"}]}',
  );
  expect(renderSessions({ ...empty, skipped_invalid: 1 }, "text")).toBe(
    "[sessions] no readable saved sessions\n[sessions] warning: skipped 1 unreadable saved session; run `nod doctor` for recovery guidance\n",
  );
});

test("renders session detail, migration and recovery exactly", () => {
  const d = deps();
  const s = createSession(d, { id: "sess" });
  expect(renderSessionDetail(readSessionDetail(d, "sess"), "text")).toBe(
    `[session] sess\ncreated_at_ms: ${s.manifest.created_at_ms}\nupdated_at_ms: ${s.manifest.updated_at_ms}\nlanguage: und\nhistory_len: 0\n\n(no history yet)\n`,
  );
  saveTurn(s, {
    kind: "assistant",
    user: { text: "hi", images: [{ id: 1, mime: "image/png", data: "", path: "/p.png" }] },
    assistant: "hello",
    execution: {
      steps: [
        {
          assistant: "run",
          toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }],
          results: [{ role: "tool", toolCallId: "c1", name: "bash", content: "out", status: "success" }],
        },
      ],
      steering: [],
    },
  });
  saveTurn(s, {
    kind: "interrupted",
    user: { text: "x" },
    activeToolCall: { id: "c2", name: "read", arguments: "{}" },
    completedToolNames: [],
    execution: { steps: [], steering: [] },
    reason: "cancelled",
    origin: "turn",
  });
  saveTurn(s, { kind: "compacted_summary", handoff: "sum", removedTurns: 1 });
  s.close();
  const detail = readSessionDetail(d, "sess");
  const head = `[session] sess\ncreated_at_ms: ${detail.created_at_ms}\nupdated_at_ms: ${detail.updated_at_ms}\nlanguage: und\nhistory_len: 2\n`;
  expect(renderSessionDetail(detail, "text")).toBe(
    `${head}\n[turn 1]\n[compacted] removed_turns=1 compactions=1\nsum\n` +
      "\n[turn 2]\n[user]\nx\n[interrupted]\ntool_call_id: c2\ntool_name: read\n",
  );
  const json = JSON.parse(renderSessionDetail(detail, "json"));
  expect(json).toMatchObject({ kind: "session_detail", id: "sess", history_len: 2 });
  expect(json.history[0]).toEqual({
    kind: "compacted_summary",
    summary: "sum",
    removed_turn_count: 1,
    compaction_count: 1,
  });
  expect(json.history[1]).toEqual({
    kind: "interrupted",
    user: { text: "x", images: [] },
    assistant: null,
    tool_call: { id: "c2", name: "read", arguments_json: "{}" },
    completed_tool_names: [],
  });
  // the assistant turn before compaction renders with execution + images
  const before = readSessionDetail(d, "sess");
  before.history = [
    {
      kind: "assistant",
      user: { text: "hi", images: [{ id: 1, mime: "image/png", data: "", path: "/p.png" }] },
      assistant: "hello",
      execution: {
        steps: [
          {
            assistant: "run",
            toolCalls: [{ id: "c1", name: "bash", arguments: "{}" }],
            results: [{ role: "tool", toolCallId: "c1", name: "bash", content: "out", status: "success" }],
          },
        ],
        steering: [],
      },
    },
  ];
  expect(renderSessionDetail(before, "text")).toContain(
    "[user]\nhi\n[images] 1\n - /p.png (image/png)\n[execution]\nassistant:\nrun\ntool_call: c1 bash\narguments:\n{}\ntool_result: c1 bash success\noutput:\nout\n[assistant]\nhello\n",
  );
  expect(JSON.parse(renderSessionDetail(before, "json")).history[0]).toEqual({
    kind: "assistant",
    user: { text: "hi", images: [{ path: "/p.png", media_type: "image/png" }] },
    assistant: "hello",
    execution: {
      schema_version: 3,
      tool_steps: [
        {
          assistant: "run",
          tool_calls: [{ id: "c1", name: "bash", arguments_json: "{}", provider_result: null }],
          tool_results: [
            {
              tool_call_id: "c1",
              tool_name: "bash",
              status: "success",
              output: "out",
              output_bytes: 3,
              stored_output_bytes: 3,
              truncated: false,
              provider_native: false,
              created_at_ms: 0,
              permission_feedback: [],
            },
          ],
        },
      ],
      files: [],
      steering: [],
    },
  });
  expect(
    renderMigration({ id: "a", status: "already_current", source_schema_version: 1, source_bytes: 9 }, "text"),
  ).toBe("[session migration] a\nstatus: already_current\nsource_schema_version: 1\nsource_bytes: 9\n");
  expect(
    renderMigration({ id: "a", status: "already_current", source_schema_version: 1, source_bytes: 9 }, "json"),
  ).toBe('{"kind":"session_migration","id":"a","status":"already_current","source_schema_version":1,"source_bytes":9}');
  const rec = { source_id: "a", recovered_id: "b", status: "recovered" as const, history_turns: 2 };
  expect(renderRecovery(rec, "text")).toBe(
    "[session recovery] copied a to b\nhistory_turns: 2\nresume: nod --resume b\n",
  );
  expect(renderRecovery(rec, "json")).toBe(
    '{"kind":"session_recovery","source_id":"a","recovered_id":"b","status":"recovered","history_turns":2}',
  );
});

test("helpers", () => {
  expect(terminalSafe("a\x1b[0m​")).toBe("a\\x1b[0m\\u{200b}");
  expect(utcTimestamp(-1)).toBe("unknown");
  expect(languageLabel("und")).toBeUndefined();
  expect(languageLabel("und-Latn")).toBe("Latin script");
  expect(languageLabel("es-MX")).toBe("Spanish");
  expect(languageLabel("xx")).toBe("xx");
});
