/** Prompt history navigation: up/down only at the edge of the draft, the live draft stashed while browsing. */
import { createEditor, type Editor, onFirstLine, onLastLine } from "./composer.ts";

export const HISTORY_CAP = 500;

export type HistoryNav = {
  /** Oldest first. */
  entries: string[];
  /** entries.length means "the live draft". */
  index: number;
  stash: string | null;
};

function dedupe(entries: string[]): string[] {
  const out: string[] = [];
  for (const e of entries) if (e !== out.at(-1)) out.push(e);
  return out.slice(-HISTORY_CAP);
}

export function createHistoryNav(entries: string[]): HistoryNav {
  const clean = dedupe(entries);
  return { entries: clean, index: clean.length, stash: null };
}

export function historyRemember(nav: HistoryNav, text: string): HistoryNav {
  const entries = dedupe([...nav.entries, text]);
  return { entries, index: entries.length, stash: null };
}

const withText = (editor: Editor, text: string): Editor => ({ ...createEditor(text), killRing: editor.killRing });

/** null when the cursor is not on the first line or there is nothing older. */
export function historyUp(nav: HistoryNav, editor: Editor): { nav: HistoryNav; editor: Editor } | null {
  if (!onFirstLine(editor) || nav.index === 0) return null;
  const stash = nav.index === nav.entries.length ? editor.text : nav.stash;
  const index = nav.index - 1;
  return { nav: { ...nav, index, stash }, editor: withText(editor, nav.entries[index] as string) };
}

/** null when the cursor is not on the last line or already at the live draft. */
export function historyDown(nav: HistoryNav, editor: Editor): { nav: HistoryNav; editor: Editor } | null {
  if (!onLastLine(editor) || nav.index >= nav.entries.length) return null;
  const index = nav.index + 1;
  const text = index === nav.entries.length ? (nav.stash ?? "") : (nav.entries[index] as string);
  return {
    nav: { ...nav, index, stash: index === nav.entries.length ? null : nav.stash },
    editor: withText(editor, text),
  };
}

/** Editing the draft leaves history mode; the stash is what the user was typing. */
export const historyReset = (nav: HistoryNav): HistoryNav => ({ ...nav, index: nav.entries.length, stash: null });
