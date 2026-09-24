import { expect, test } from "bun:test";
import {
  backslashNewline,
  createEditor,
  type Editor,
  expandForSubmit,
  isImagePath,
  MAX_INPUT_BYTES,
  pastePlaceholder,
  reduceEditor,
  referencedImages,
} from "../../src/ui/core/composer.ts";

const type = (e: Editor, text: string) =>
  [...text].reduce((acc, ch) => reduceEditor(acc, { type: "insert", text: ch }), e);

test("backslash before the cursor turns enter into a newline", () => {
  const e = type(createEditor(), "hello\\");
  const next = backslashNewline(e);
  expect(next?.text).toBe("hello\n");
  expect(next?.cursor).toBe(6);
  expect(backslashNewline(type(createEditor(), "hello"))).toBeNull();
});

test("a short paste stays inline; a long one becomes a placeholder that expands on submit", () => {
  const inline = reduceEditor(createEditor(), { type: "paste", text: "a\r\nb" });
  expect(inline.text).toBe("a\nb");
  expect(inline.pasted).toEqual([]);
  const long = reduceEditor(type(createEditor(), "see "), { type: "paste", text: "1\n2\n3\n4\n5" });
  expect(long.text).toBe("see [Pasted text #1, 5 lines]");
  expect(long.pasted).toEqual([{ id: 1, text: "1\n2\n3\n4\n5", lines: 5 }]);
  const again = reduceEditor(long, { type: "paste", text: "x".repeat(500) });
  expect(again.text).toBe(`see [Pasted text #1, 5 lines][Pasted text #2, 1 line]`);
  expect(expandForSubmit(again)).toBe(`see 1\n2\n3\n4\n5${"x".repeat(500)}`);
  expect(pastePlaceholder(3, 1)).toBe("[Pasted text #3, 1 line]");
});

test("the 64 KiB cap refuses the edit and reports it", () => {
  const big = reduceEditor(createEditor(), { type: "set_text", text: "y".repeat(MAX_INPUT_BYTES - 10) });
  expect(big.notice).toBeUndefined();
  const over = reduceEditor(big, { type: "insert", text: "z".repeat(20) });
  expect(over.notice).toBe(`Input exceeds ${MAX_INPUT_BYTES} bytes`);
  expect(over.text).toBe(big.text);
});

test("cursor moves by character, word and line; vertical moves keep the column", () => {
  let e = type(createEditor(), "foo bar\nbazqux");
  e = reduceEditor(e, { type: "move", kind: "word_left" });
  expect(e.cursor).toBe(8);
  e = reduceEditor(e, { type: "move", kind: "up" });
  expect(e.cursor).toBe(0);
  e = reduceEditor(e, { type: "move", kind: "line_end" });
  expect(e.cursor).toBe(7);
  e = reduceEditor(e, { type: "move", kind: "down" });
  expect(e.cursor).toBe(14);
  e = reduceEditor(e, { type: "move", kind: "word_left" });
  expect(e.cursor).toBe(8);
  e = reduceEditor(e, { type: "move", kind: "left" });
  expect(e.cursor).toBe(7);
});

test("deletions feed the kill ring and yank puts the last kill back", () => {
  let e = type(createEditor(), "one two three");
  e = reduceEditor(e, { type: "delete", kind: "whitespace_word_left" });
  expect(e.text).toBe("one two ");
  e = reduceEditor(e, { type: "delete", kind: "to_line_start" });
  expect(e.text).toBe("");
  expect(e.killRing).toEqual(["three", "one two "]);
  e = reduceEditor(e, { type: "yank" });
  expect(e.text).toBe("one two ");
  e = reduceEditor(e, { type: "delete", kind: "backward" });
  expect(e.killRing).toHaveLength(2);
});

test("undo groups a typed word and redo replays it", () => {
  let e = type(createEditor(), "abc def");
  e = reduceEditor(e, { type: "undo" });
  expect(e.text).toBe("abc ");
  e = reduceEditor(e, { type: "undo" });
  expect(e.text).toBe("abc");
  e = reduceEditor(e, { type: "redo" });
  expect(e.text).toBe("abc ");
});

test("image tokens and skill tokens", () => {
  let e = type(createEditor(), "look");
  e = reduceEditor(e, { type: "add_image", id: 1 });
  expect(e.text).toBe("look [Image #1]");
  expect(referencedImages(e)).toEqual([1]);
  e = reduceEditor(e, { type: "delete", kind: "backward" });
  expect(referencedImages(e)).toEqual([]);
  let s = type(createEditor(), "use $rev");
  s = reduceEditor(s, { type: "add_skill", token: { name: "review", location: "/skills/review" }, tokenStart: 4 });
  expect(s.text).toBe("use $review ");
  expect(s.skills).toEqual([{ name: "review", location: "/skills/review" }]);
  expect(isImagePath("/tmp/shot.PNG")).toBe(true);
  expect(isImagePath("notes.md")).toBe(false);
});
