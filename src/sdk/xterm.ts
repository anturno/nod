/** xterm.js glue for createTerminal: the adapter plus the key encoding the composer expects. */
import type { TerminalAdapter } from "./terminal.ts";

type KeyEvent = { type: string; key: string; shiftKey: boolean; altKey: boolean; ctrlKey: boolean; metaKey: boolean };

type XtermLike = {
  cols: number;
  rows: number;
  write(data: string | Uint8Array): void;
  onData(cb: (data: string) => void): { dispose(): void };
  onResize(cb: () => void): { dispose(): void };
  attachCustomKeyEventHandler?(handler: (event: KeyboardEvent) => boolean): void;
  hasSelection?(): boolean;
};

/**
 * Browser key events the composer needs verbatim: shift+enter as a kitty CSI u sequence, meta+backspace as ESC DEL,
 * meta+arrows as the readline word motions. Null means "let xterm encode it".
 */
export function encodeXtermKeyEvent(event: KeyEvent): string | null {
  if (event.type !== "keydown" || event.altKey || event.ctrlKey) return null;
  if (event.key === "Enter" && event.shiftKey && !event.metaKey) return "\x1b[13;2u";
  if (!event.metaKey) return null;
  if (event.key === "Backspace") return "\x1b\x7f";
  if (event.key === "ArrowLeft") return "\x1bb";
  if (event.key === "ArrowRight") return "\x1bf";
  const modifiers = 8 | (event.shiftKey ? 1 : 0);
  const arrow = { ArrowUp: "A", ArrowDown: "B" }[event.key];
  if (arrow) return `\x1b[1;${modifiers + 1}${arrow}`;
  const shortcut = { a: 97, c: 99, x: 120, z: 122 }[event.key.toLowerCase()];
  return shortcut ? `\x1b[${shortcut};${modifiers + 1}u` : null;
}

const ownsShortcut = (term: XtermLike, event: KeyEvent) =>
  event.type === "keydown" && event.metaKey && /^[cx]$/i.test(event.key) && term.hasSelection?.() === true;

/** A TerminalAdapter over an xterm.js Terminal; installs the composer key handler when xterm supports it. */
export function xtermAdapter(term: XtermLike): TerminalAdapter {
  let keyData: ((data: string) => void) | null = null;
  term.attachCustomKeyEventHandler?.((event) => {
    if (ownsShortcut(term, event)) return true;
    const data = encodeXtermKeyEvent(event);
    if (data === null || keyData === null) return true;
    keyData(data);
    return false;
  });
  return {
    get cols() {
      return term.cols;
    },
    get rows() {
      return term.rows;
    },
    write: (bytes) => term.write(bytes),
    onData(cb) {
      keyData = cb;
      const sub = term.onData(cb);
      return () => {
        sub.dispose();
        if (keyData === cb) keyData = null;
      };
    },
    onResize(cb) {
      const sub = term.onResize(cb);
      return () => sub.dispose();
    },
  };
}
