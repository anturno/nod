import { expect, test } from "bun:test";
import {
  CTRL_C_WINDOW_MS,
  createGestures,
  ctrlCArmed,
  ctrlCGesture,
  DOUBLE_ESC_MS,
  escapeGesture,
} from "../../src/ui/core/gestures.ts";

test("double esc within 500 ms; a slower second press starts over", () => {
  const first = escapeGesture(createGestures(), 1000);
  expect(first.double).toBe(false);
  expect(escapeGesture(first.gestures, 1000 + DOUBLE_ESC_MS).double).toBe(true);
  const late = escapeGesture(first.gestures, 1000 + DOUBLE_ESC_MS + 1);
  expect(late.double).toBe(false);
  expect(escapeGesture(late.gestures, 1000 + DOUBLE_ESC_MS + 100).double).toBe(true);
});

test("ctrl+c arms a 3 s window; the second press inside it exits", () => {
  const armed = ctrlCGesture(createGestures(), 5000);
  expect(armed.exit).toBe(false);
  expect(ctrlCArmed(armed.gestures, 5000 + CTRL_C_WINDOW_MS)).toBe(true);
  expect(ctrlCArmed(armed.gestures, 5000 + CTRL_C_WINDOW_MS + 1)).toBe(false);
  expect(ctrlCGesture(armed.gestures, 5000 + CTRL_C_WINDOW_MS + 1).exit).toBe(false);
  expect(ctrlCGesture(armed.gestures, 6000).exit).toBe(true);
});
