/** Timed key gestures: double esc within 500 ms clears the draft; ctrl+c twice within 3 s exits. */

export const DOUBLE_ESC_MS = 500;
export const CTRL_C_WINDOW_MS = 3000;

export type Gestures = { lastEscape: number | null; ctrlCArmedAt: number | null };
export const createGestures = (): Gestures => ({ lastEscape: null, ctrlCArmedAt: null });

/** `double` is true on the second esc inside the window; the window restarts after a double. */
export function escapeGesture(g: Gestures, now: number): { gestures: Gestures; double: boolean } {
  const double = g.lastEscape !== null && now - g.lastEscape <= DOUBLE_ESC_MS;
  return { gestures: { ...g, lastEscape: double ? null : now }, double };
}

/** `exit` is true on the second ctrl+c inside the window; otherwise the window is (re)armed. */
export function ctrlCGesture(g: Gestures, now: number): { gestures: Gestures; exit: boolean } {
  const exit = g.ctrlCArmedAt !== null && now - g.ctrlCArmedAt <= CTRL_C_WINDOW_MS;
  return { gestures: { ...g, ctrlCArmedAt: exit ? null : now }, exit };
}

export const ctrlCArmed = (g: Gestures, now: number) =>
  g.ctrlCArmedAt !== null && now - g.ctrlCArmedAt <= CTRL_C_WINDOW_MS;
export const disarmCtrlC = (g: Gestures): Gestures => ({ ...g, ctrlCArmedAt: null });
