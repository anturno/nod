import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { appendPromptHistory, loadPromptHistory } from "../../src/core/session/history.ts";
import { createEditor, reduceEditor } from "../../src/ui/core/composer.ts";
import { createHistoryNav, HISTORY_CAP, historyDown, historyRemember, historyUp } from "../../src/ui/core/history.ts";

test("up recalls older prompts only at the first line and stashes the live draft", () => {
  const nav = createHistoryNav(["first", "second"]);
  const draft = createEditor("typing");
  const up = historyUp(nav, draft);
  expect(up?.editor.text).toBe("second");
  expect(up?.nav.stash).toBe("typing");
  const up2 = historyUp(up!.nav, up!.editor);
  expect(up2?.editor.text).toBe("first");
  expect(historyUp(up2!.nav, up2!.editor)).toBeNull();
  const down = historyDown(up2!.nav, up2!.editor);
  expect(down?.editor.text).toBe("second");
  const back = historyDown(down!.nav, down!.editor);
  expect(back?.editor.text).toBe("typing");
  expect(historyDown(back!.nav, back!.editor)).toBeNull();
});

test("a multi-line draft only navigates from its edges", () => {
  const nav = createHistoryNav(["old"]);
  const middle = reduceEditor(createEditor("a\nb\nc"), { type: "move", kind: "up" });
  expect(historyUp(nav, middle)).toBeNull();
  expect(historyDown(nav, middle)).toBeNull();
  const top = reduceEditor(middle, { type: "move", kind: "up" });
  expect(historyUp(nav, top)?.editor.text).toBe("old");
});

test("remember dedupes adjacent entries and prunes to 500", () => {
  let nav = createHistoryNav(["a", "a", "b"]);
  expect(nav.entries).toEqual(["a", "b"]);
  nav = historyRemember(nav, "b");
  expect(nav.entries).toEqual(["a", "b"]);
  for (let i = 0; i < 600; i++) nav = historyRemember(nav, `p${i}`);
  expect(nav.entries).toHaveLength(HISTORY_CAP);
  expect(nav.entries.at(-1)).toBe("p599");
  expect(nav.index).toBe(HISTORY_CAP);
});

test("prompts persist in history.jsonl per workspace and slash commands are kept", () => {
  const home = mkdtempSync(join(tmpdir(), "nod-ui-history-"));
  try {
    const deps = { home, now: () => 1 };
    appendPromptHistory(deps, "/ws", "hello");
    appendPromptHistory(deps, "/ws", "/help");
    appendPromptHistory(deps, "/other", "elsewhere");
    expect(loadPromptHistory({ home }, "/ws").reverse()).toEqual(["hello", "/help"]);
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
});
