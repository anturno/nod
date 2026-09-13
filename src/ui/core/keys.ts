/** Terminal bytes → key actions (fx escape_parser.zig + shortcuts.zig). Stateful: partial sequences, lone ESC, paste. */

export type MoveKind =
  | "left"
  | "right"
  | "up"
  | "down"
  | "word_left"
  | "word_right"
  | "line_start"
  | "line_end"
  | "page_up"
  | "page_down";
export type DeleteKind =
  | "backward"
  | "forward"
  | "word_left"
  | "word_right"
  | "to_line_start"
  | "to_line_end"
  | "whitespace_word_left";

export type KeyAction =
  | { type: "insert"; text: string }
  | { type: "insert_newline" }
  | { type: "submit" }
  | { type: "escape" }
  | { type: "ctrl_c" }
  | { type: "ctrl_o" }
  | { type: "ctrl_g" }
  | { type: "ctrl_l" }
  | { type: "toggle_permission_mode" }
  | { type: "move"; kind: MoveKind }
  | { type: "delete"; kind: DeleteKind }
  | { type: "history_next" }
  | { type: "yank" }
  | { type: "undo" }
  | { type: "tab" }
  | { type: "paste"; text: string }
  | { type: "wheel"; direction: "up" | "down" };

/** A lone ESC is reported only after this long without a continuation byte. */
export const ESC_ALONE_MS = 25;

const ESC = "\x1b";
const PASTE_END = "\x1b[201~";

const move = (kind: MoveKind): KeyAction => ({ type: "move", kind });
const del = (kind: DeleteKind): KeyAction => ({ type: "delete", kind });

/** C0 bytes the composer owns. ctrl+s/q/z/x/v/r are deliberately absent. */
export function controlAction(code: number): KeyAction | null {
  switch (code) {
    case 0x0d:
      return { type: "submit" };
    case 0x0a:
      return { type: "insert_newline" };
    case 0x01:
      return move("line_start");
    case 0x05:
      return move("line_end");
    case 0x02:
      return move("left");
    case 0x06:
      return move("right");
    case 0x0e:
      return { type: "history_next" };
    case 0x04:
      return del("forward");
    case 0x0b:
      return del("to_line_end");
    case 0x15:
      return del("to_line_start");
    case 0x17:
      return del("whitespace_word_left");
    case 0x19:
      return { type: "yank" };
    case 0x1f:
      return { type: "undo" };
    case 0x0c:
      return { type: "ctrl_l" };
    case 0x0f:
      return { type: "ctrl_o" };
    case 0x07:
      return { type: "ctrl_g" };
    case 0x03:
      return { type: "ctrl_c" };
    case 0x09:
      return { type: "tab" };
    case 0x7f:
    case 0x08:
      return del("backward");
    default:
      return null;
  }
}

/** ESC + one byte: alt bindings and the alt+enter newline. */
function altAction(ch: string): KeyAction | null {
  switch (ch) {
    case "\r":
    case "\n":
      return { type: "insert_newline" };
    case "b":
      return move("word_left");
    case "f":
      return move("word_right");
    case "d":
      return del("word_right");
    case "\x7f":
    case "\x08":
      return del("word_left");
    default:
      return null;
  }
}

/** Kitty `CSI code;mod u`. mod-1 is a bitfield: 1 shift, 2 alt, 4 ctrl. */
function kittyAction(code: number, mod: number): KeyAction | null {
  const bits = Math.max(0, mod - 1);
  const shift = (bits & 1) !== 0;
  const alt = (bits & 2) !== 0;
  const ctrl = (bits & 4) !== 0;
  if (code === 13) return shift || alt ? { type: "insert_newline" } : { type: "submit" };
  if (code === 27) return { type: "escape" };
  if (code === 9) return shift ? { type: "toggle_permission_mode" } : { type: "tab" };
  if (code === 127) return alt ? del("word_left") : del("backward");
  const ch = String.fromCodePoint(code);
  if (ctrl && code >= 0x40 && code <= 0x7e) return controlAction(code & 0x1f);
  if (alt) return altAction(ch);
  return code >= 0x20 ? { type: "insert", text: ch } : null;
}

function csiAction(params: string, final: string): KeyAction | null {
  const nums = params.split(";").map((p) => Number.parseInt(p, 10));
  const first = nums[0] ?? Number.NaN;
  const mod = nums[1] ?? 1;
  const word = mod === 3 || mod === 5;
  switch (final) {
    case "u":
      return Number.isNaN(first) ? null : kittyAction(first, mod);
    case "A":
      return move("up");
    case "B":
      return move("down");
    case "C":
      return move(word ? "word_right" : "right");
    case "D":
      return move(word ? "word_left" : "left");
    case "H":
      return move("line_start");
    case "F":
      return move("line_end");
    case "Z":
      return { type: "toggle_permission_mode" };
    case "~":
      switch (first) {
        case 1:
        case 7:
          return move("line_start");
        case 4:
        case 8:
          return move("line_end");
        case 3:
          return del(word ? "word_right" : "forward");
        case 5:
          return move("page_up");
        case 6:
          return move("page_down");
        default:
          return null;
      }
    default:
      return null;
  }
}

export type KeyDecoder = {
  /** Decodes what it can; a trailing partial sequence or lone ESC waits for more bytes or flush(). */
  feed(bytes: string): KeyAction[];
  /** Resolves a lone pending ESC as escape; drops any other partial sequence. */
  flush(): KeyAction[];
  pendingEscape(): boolean;
};

export function createKeyDecoder(): KeyDecoder {
  let buffer = "";
  let paste: string | null = null;

  function drain(): KeyAction[] {
    const out: KeyAction[] = [];
    let i = 0;
    let text = "";
    const flushText = () => {
      if (text) out.push({ type: "insert", text });
      text = "";
    };
    while (i < buffer.length) {
      if (paste !== null) {
        const end = buffer.indexOf(PASTE_END, i);
        if (end === -1) {
          // Keep a possible prefix of the end marker in the buffer.
          let keep = 0;
          for (let n = Math.min(PASTE_END.length - 1, buffer.length - i); n > 0; n--)
            if (buffer.endsWith(PASTE_END.slice(0, n))) {
              keep = n;
              break;
            }
          paste += buffer.slice(i, buffer.length - keep);
          buffer = buffer.slice(buffer.length - keep);
          return out;
        }
        paste += buffer.slice(i, end);
        out.push({ type: "paste", text: paste });
        paste = null;
        i = end + PASTE_END.length;
        continue;
      }
      const ch = buffer[i] as string;
      if (ch !== ESC) {
        const code = ch.charCodeAt(0);
        if (code < 0x20 || code === 0x7f) {
          flushText();
          const action = controlAction(code);
          if (action) out.push(action);
          i++;
        } else {
          const cp = buffer.codePointAt(i) as number;
          const s = String.fromCodePoint(cp);
          text += s;
          i += s.length;
        }
        continue;
      }
      flushText();
      const next = buffer[i + 1];
      if (next === undefined) {
        buffer = buffer.slice(i);
        return out;
      }
      if (next === "[") {
        let j = i + 2;
        while (j < buffer.length && !(buffer.charCodeAt(j) >= 0x40 && buffer.charCodeAt(j) <= 0x7e)) j++;
        if (j >= buffer.length) {
          buffer = buffer.slice(i);
          return out;
        }
        const params = buffer.slice(i + 2, j);
        const final = buffer[j] as string;
        i = j + 1;
        if (params === "200" && final === "~") paste = "";
        else if (params.startsWith("<")) {
          const button = Number.parseInt(params.slice(1), 10);
          if (final === "M" && button === 64) out.push({ type: "wheel", direction: "up" });
          else if (final === "M" && button === 65) out.push({ type: "wheel", direction: "down" });
        } else {
          const action = csiAction(params, final);
          if (action) out.push(action);
        }
        continue;
      }
      if (next === "O") {
        const key = buffer[i + 2];
        if (key === undefined) {
          buffer = buffer.slice(i);
          return out;
        }
        const action = csiAction("", key);
        if (action) out.push(action);
        i += 3;
        continue;
      }
      if (next === "]") {
        const bel = buffer.indexOf("\x07", i);
        const st = buffer.indexOf("\x1b\\", i);
        const end = bel === -1 ? st : st === -1 ? bel : Math.min(bel, st);
        if (end === -1) {
          buffer = buffer.slice(i);
          return out;
        }
        i = end + (end === bel ? 1 : 2);
        continue;
      }
      if (next === ESC) {
        out.push({ type: "escape" });
        i++;
        continue;
      }
      const action = altAction(next);
      if (action) out.push(action);
      i += 2;
    }
    flushText();
    buffer = "";
    return out;
  }

  return {
    feed(bytes) {
      buffer += bytes;
      return drain();
    },
    flush() {
      const wasEscape = buffer === ESC;
      buffer = "";
      return wasEscape ? [{ type: "escape" }] : [];
    },
    pendingEscape: () => buffer === ESC,
  };
}
