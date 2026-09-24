import { expect, test } from "bun:test";
import { createKeyDecoder, type KeyAction } from "../../src/ui/core/keys.ts";

const decode = (bytes: string): KeyAction[] => createKeyDecoder().feed(bytes);

test("enter submits; \\n, ESC \\r, ESC \\n, kitty shift+enter and alt+enter insert a newline", () => {
  expect(decode("\r")).toEqual([{ type: "submit" }]);
  for (const seq of ["\n", "\x1b\r", "\x1b\n", "\x1b[13;2u", "\x1b[13;3u"])
    expect(decode(seq)).toEqual([{ type: "insert_newline" }]);
  expect(decode("\x1b[13;1u")).toEqual([{ type: "submit" }]);
});

test("control bytes map to the composer shortcuts and never to ctrl+s/q/z/x/v/r", () => {
  expect(decode("\x01\x05\x02\x06")).toEqual([
    { type: "move", kind: "line_start" },
    { type: "move", kind: "line_end" },
    { type: "move", kind: "left" },
    { type: "move", kind: "right" },
  ]);
  expect(decode("\x0e\x04\x0b\x15\x17\x19\x1f")).toEqual([
    { type: "history_next" },
    { type: "delete", kind: "forward" },
    { type: "delete", kind: "to_line_end" },
    { type: "delete", kind: "to_line_start" },
    { type: "delete", kind: "whitespace_word_left" },
    { type: "yank" },
    { type: "undo" },
  ]);
  expect(decode("\x0c\x0f\x07\x03\t\x7f\x08")).toEqual([
    { type: "ctrl_l" },
    { type: "ctrl_o" },
    { type: "ctrl_g" },
    { type: "ctrl_c" },
    { type: "tab" },
    { type: "delete", kind: "backward" },
    { type: "delete", kind: "backward" },
  ]);
  expect(decode("\x13\x11\x1a\x18\x16\x12")).toEqual([]);
});

test("kitty CSI u carries ctrl+o, ctrl+c, escape, shift+tab and plain characters", () => {
  expect(decode("\x1b[111;5u")).toEqual([{ type: "ctrl_o" }]);
  expect(decode("\x1b[99;5u")).toEqual([{ type: "ctrl_c" }]);
  expect(decode("\x1b[27u")).toEqual([{ type: "escape" }]);
  expect(decode("\x1b[9;2u")).toEqual([{ type: "toggle_permission_mode" }]);
  expect(decode("\x1b[Z")).toEqual([{ type: "toggle_permission_mode" }]);
  expect(decode("\x1b[97u")).toEqual([{ type: "insert", text: "a" }]);
  expect(decode("\x1b[98;3u")).toEqual([{ type: "move", kind: "word_left" }]);
});

test("arrows, home/end, page keys, delete, and modifier 3/5 word moves", () => {
  expect(decode("\x1b[A\x1b[B\x1b[C\x1b[D")).toEqual([
    { type: "move", kind: "up" },
    { type: "move", kind: "down" },
    { type: "move", kind: "right" },
    { type: "move", kind: "left" },
  ]);
  expect(decode("\x1b[1;5C\x1b[1;3D")).toEqual([
    { type: "move", kind: "word_right" },
    { type: "move", kind: "word_left" },
  ]);
  expect(decode("\x1b[H\x1b[F\x1b[1~\x1b[4~\x1bOH\x1bOF")).toEqual([
    { type: "move", kind: "line_start" },
    { type: "move", kind: "line_end" },
    { type: "move", kind: "line_start" },
    { type: "move", kind: "line_end" },
    { type: "move", kind: "line_start" },
    { type: "move", kind: "line_end" },
  ]);
  expect(decode("\x1b[5~\x1b[6~\x1b[3~\x1b[3;5~")).toEqual([
    { type: "move", kind: "page_up" },
    { type: "move", kind: "page_down" },
    { type: "delete", kind: "forward" },
    { type: "delete", kind: "word_right" },
  ]);
  expect(decode("\x1bb\x1bf\x1bd\x1b\x7f")).toEqual([
    { type: "move", kind: "word_left" },
    { type: "move", kind: "word_right" },
    { type: "delete", kind: "word_right" },
    { type: "delete", kind: "word_left" },
  ]);
});

test("bracketed paste arrives as one paste action, even split across chunks", () => {
  const d = createKeyDecoder();
  expect(d.feed("ab\x1b[200~line 1\nli")).toEqual([{ type: "insert", text: "ab" }]);
  expect(d.feed("ne 2\x1b[20")).toEqual([]);
  expect(d.feed("1~c")).toEqual([
    { type: "paste", text: "line 1\nline 2" },
    { type: "insert", text: "c" },
  ]);
});

test("SGR wheel reports become wheel actions and other mouse reports are ignored", () => {
  expect(decode("\x1b[<64;10;5M\x1b[<65;10;5M\x1b[<0;1;1M\x1b[<0;1;1m")).toEqual([
    { type: "wheel", direction: "up" },
    { type: "wheel", direction: "down" },
  ]);
});

test("a lone ESC waits; flush reports escape; a continuation byte completes the sequence instead", () => {
  const d = createKeyDecoder();
  expect(d.feed("\x1b")).toEqual([]);
  expect(d.pendingEscape()).toBe(true);
  expect(d.flush()).toEqual([{ type: "escape" }]);
  expect(d.pendingEscape()).toBe(false);
  const e = createKeyDecoder();
  expect(e.feed("\x1b")).toEqual([]);
  expect(e.feed("[A")).toEqual([{ type: "move", kind: "up" }]);
  expect(decode("\x1b\x1b")).toEqual([{ type: "escape" }]);
});

test("printable runs coalesce into one insert and OSC replies are swallowed", () => {
  expect(decode("héllo wörld")).toEqual([{ type: "insert", text: "héllo wörld" }]);
  expect(decode("\x1b]11;rgb:0000/0000/0000\x07x")).toEqual([{ type: "insert", text: "x" }]);
});
