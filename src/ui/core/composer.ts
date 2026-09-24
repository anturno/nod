/** The composer editor: text + cursor with pasted blocks, image and skill tokens, undo/redo and a kill ring. */
import type { DeleteKind, MoveKind } from "./keys.ts";

export type PastedBlock = { id: number; text: string; lines: number };
export type ImageToken = { id: number };
export type SkillToken = { name: string; location: string };
type Snapshot = { text: string; cursor: number };

export type Editor = {
  text: string;
  cursor: number;
  preferredColumn?: number;
  pasted: PastedBlock[];
  images: ImageToken[];
  skills: SkillToken[];
  undo: Snapshot[];
  redo: Snapshot[];
  killRing: string[];
  /** Consecutive word characters coalesce into one undo step. */
  group?: "word";
  /** Set when an edit was refused; the host shows it and clears it. */
  notice?: string;
};

export const MAX_INPUT_BYTES = 64 * 1024;
export const KILL_RING_CAP = 32;
export const UNDO_CAP = 200;
/** A paste longer than either becomes a placeholder block. */
export const PASTE_INLINE_LINES = 3;
export const PASTE_INLINE_BYTES = 400;
export const IMAGE_EXTENSIONS = /\.(png|jpe?g|gif|webp)$/i;

export type EditorAction =
  | { type: "insert"; text: string }
  | { type: "insert_newline" }
  | { type: "move"; kind: MoveKind }
  | { type: "delete"; kind: DeleteKind }
  | { type: "yank" }
  | { type: "undo" }
  | { type: "redo" }
  | { type: "paste"; text: string }
  | { type: "set_text"; text: string; cursor?: number }
  | { type: "clear" }
  | { type: "add_image"; id: number }
  | { type: "add_skill"; token: SkillToken; tokenStart: number }
  | { type: "replace_range"; start: number; end: number; text: string };

export const createEditor = (text = ""): Editor => ({
  text,
  cursor: text.length,
  pasted: [],
  images: [],
  skills: [],
  undo: [],
  redo: [],
  killRing: [],
});

export const pastePlaceholder = (id: number, lines: number) =>
  `[Pasted text #${id}, ${lines} ${lines === 1 ? "line" : "lines"}]`;
export const imagePlaceholder = (id: number) => `[Image #${id}]`;
export const isImagePath = (text: string) => IMAGE_EXTENSIONS.test(text.trim()) && !/\s/.test(text.trim());

const isWord = (ch: string | undefined) => ch !== undefined && /\w/.test(ch);
const isSpace = (ch: string | undefined) => ch !== undefined && /\s/.test(ch);

export function lineStart(text: string, at: number): number {
  return text.lastIndexOf("\n", at - 1) + 1;
}
export function lineEnd(text: string, at: number): number {
  const nl = text.indexOf("\n", at);
  return nl === -1 ? text.length : nl;
}
export const onFirstLine = (e: Editor) => !e.text.slice(0, e.cursor).includes("\n");
export const onLastLine = (e: Editor) => !e.text.slice(e.cursor).includes("\n");

function wordLeft(text: string, at: number): number {
  let i = at;
  while (i > 0 && !isWord(text[i - 1])) i--;
  while (i > 0 && isWord(text[i - 1])) i--;
  return i;
}
function wordRight(text: string, at: number): number {
  let i = at;
  while (i < text.length && !isWord(text[i])) i++;
  while (i < text.length && isWord(text[i])) i++;
  return i;
}
function whitespaceWordLeft(text: string, at: number): number {
  let i = at;
  while (i > 0 && isSpace(text[i - 1])) i--;
  while (i > 0 && !isSpace(text[i - 1])) i--;
  return i;
}

function moveTarget(e: Editor, kind: MoveKind): { cursor: number; preferredColumn?: number } {
  const { text, cursor } = e;
  switch (kind) {
    case "left":
      return { cursor: Math.max(0, cursor - 1) };
    case "right":
      return { cursor: Math.min(text.length, cursor + 1) };
    case "word_left":
      return { cursor: wordLeft(text, cursor) };
    case "word_right":
      return { cursor: wordRight(text, cursor) };
    case "line_start":
      return { cursor: lineStart(text, cursor) };
    case "line_end":
      return { cursor: lineEnd(text, cursor) };
    case "page_up":
      return { cursor: 0 };
    case "page_down":
      return { cursor: text.length };
    case "up":
    case "down": {
      const start = lineStart(text, cursor);
      const column = e.preferredColumn ?? cursor - start;
      const targetStart = kind === "up" ? (start === 0 ? -1 : lineStart(text, start - 1)) : lineEnd(text, cursor) + 1;
      if (targetStart < 0 || targetStart > text.length) return { cursor, preferredColumn: column };
      const end = lineEnd(text, targetStart);
      return { cursor: Math.min(targetStart + column, end), preferredColumn: column };
    }
  }
}

function deleteRange(e: Editor, kind: DeleteKind): { start: number; end: number; kill: boolean } | null {
  const { text, cursor } = e;
  switch (kind) {
    case "backward":
      return cursor === 0 ? null : { start: cursor - 1, end: cursor, kill: false };
    case "forward":
      return cursor === text.length ? null : { start: cursor, end: cursor + 1, kill: false };
    case "word_left":
      return { start: wordLeft(text, cursor), end: cursor, kill: true };
    case "whitespace_word_left":
      return { start: whitespaceWordLeft(text, cursor), end: cursor, kill: true };
    case "word_right":
      return { start: cursor, end: wordRight(text, cursor), kill: true };
    case "to_line_start":
      return { start: lineStart(text, cursor), end: cursor, kill: true };
    case "to_line_end": {
      const end = lineEnd(text, cursor);
      // At the end of a line ctrl+k joins the next one, as in readline.
      return { start: cursor, end: end === cursor ? Math.min(text.length, end + 1) : end, kill: true };
    }
  }
}

const bytes = (s: string) => Buffer.byteLength(s);

function snapshot(e: Editor, group?: "word"): Editor {
  if (group && e.group === "word") return { ...e, redo: [] };
  const undo = [...e.undo, { text: e.text, cursor: e.cursor }].slice(-UNDO_CAP);
  return { ...e, undo, redo: [], group };
}

function splice(e: Editor, start: number, end: number, insert: string, group?: "word"): Editor {
  const text = e.text.slice(0, start) + insert + e.text.slice(end);
  if (bytes(text) > MAX_INPUT_BYTES) return { ...e, notice: `Input exceeds ${MAX_INPUT_BYTES} bytes` };
  const next = snapshot(e, group);
  return { ...next, text, cursor: start + insert.length, preferredColumn: undefined, notice: undefined };
}

export function reduceEditor(e: Editor, a: EditorAction): Editor {
  switch (a.type) {
    case "insert": {
      const word = a.text.length === 1 && isWord(a.text);
      return splice(e, e.cursor, e.cursor, a.text, word ? "word" : undefined);
    }
    case "insert_newline":
      return splice(e, e.cursor, e.cursor, "\n");
    case "replace_range":
      return splice(e, a.start, a.end, a.text);
    case "move":
      return { ...e, preferredColumn: undefined, ...moveTarget(e, a.kind), group: undefined, notice: undefined };
    case "delete": {
      const range = deleteRange(e, a.kind);
      if (!range || range.start === range.end) return { ...e, group: undefined };
      const killed = e.text.slice(range.start, range.end);
      const next = splice(e, range.start, range.end, "");
      if (!range.kill) return next;
      return { ...next, killRing: [...e.killRing, killed].slice(-KILL_RING_CAP) };
    }
    case "yank": {
      const last = e.killRing.at(-1);
      return last ? splice(e, e.cursor, e.cursor, last) : e;
    }
    case "undo": {
      const prev = e.undo.at(-1);
      if (!prev) return e;
      return {
        ...e,
        ...prev,
        undo: e.undo.slice(0, -1),
        redo: [...e.redo, { text: e.text, cursor: e.cursor }],
        group: undefined,
        preferredColumn: undefined,
      };
    }
    case "redo": {
      const next = e.redo.at(-1);
      if (!next) return e;
      return {
        ...e,
        ...next,
        redo: e.redo.slice(0, -1),
        undo: [...e.undo, { text: e.text, cursor: e.cursor }],
        group: undefined,
      };
    }
    case "paste": {
      const text = a.text.replace(/\r\n?/g, "\n");
      const lines = text.split("\n").length;
      if (lines <= PASTE_INLINE_LINES && bytes(text) <= PASTE_INLINE_BYTES) return splice(e, e.cursor, e.cursor, text);
      const id = (e.pasted.at(-1)?.id ?? 0) + 1;
      const inserted = splice(e, e.cursor, e.cursor, pastePlaceholder(id, lines));
      if (inserted.notice) return inserted;
      return { ...inserted, pasted: [...e.pasted, { id, text, lines }] };
    }
    case "set_text":
      return { ...snapshot(e), text: a.text, cursor: a.cursor ?? a.text.length, preferredColumn: undefined };
    case "clear":
      return {
        ...createEditor(),
        images: [],
        killRing: e.killRing,
        undo: e.text ? [...e.undo, { text: e.text, cursor: e.cursor }] : e.undo,
      };
    case "add_image": {
      const token = imagePlaceholder(a.id);
      const sep = e.text.length === 0 || /\s$/.test(e.text.slice(0, e.cursor)) ? "" : " ";
      const next = splice(e, e.cursor, e.cursor, `${sep}${token}`);
      return next.notice ? next : { ...next, images: [...e.images, { id: a.id }] };
    }
    case "add_skill": {
      const next = splice(e, a.tokenStart, e.cursor, `$${a.token.name} `);
      return next.notice ? next : { ...next, skills: [...e.skills.filter((s) => s.name !== a.token.name), a.token] };
    }
  }
}

/** `\` right before the cursor plus enter → newline instead of submit. */
export function backslashNewline(e: Editor): Editor | null {
  if (e.text[e.cursor - 1] !== "\\") return null;
  return splice(e, e.cursor - 1, e.cursor, "\n");
}

/** The prompt text the model receives: placeholders replaced by their blocks; unknown placeholders stay literal. */
export function expandForSubmit(e: Editor): string {
  let text = e.text;
  for (const block of e.pasted) text = text.split(pastePlaceholder(block.id, block.lines)).join(block.text);
  return text;
}

/** Image ids whose tokens are still in the text, in text order. */
export function referencedImages(e: Editor): number[] {
  return [...e.text.matchAll(/\[Image #(\d+)\]/g)]
    .map((m) => Number(m[1]))
    .filter((id) => e.images.some((i) => i.id === id));
}
