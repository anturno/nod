import { expect, test } from "bun:test";
import { applySound, soundLevel, soundPatch } from "../../src/ui/sound.ts";
import { detectTheme, palette, parseOscBackground, themeFromColorFgBg } from "../../src/ui/theme.ts";

test("NOD_THEME wins, then the OSC 11 reply, then COLORFGBG, then dark", async () => {
  expect(await detectTheme({ env: { NOD_THEME: "light" } })).toBe("light");
  expect(await detectTheme({ env: {}, query: async () => "\x1b]11;rgb:ffff/ffff/ffff\x07" })).toBe("light");
  expect(await detectTheme({ env: {}, query: async () => "\x1b]11;rgb:1010/1010/1010\x1b\\" })).toBe("dark");
  expect(await detectTheme({ env: { COLORFGBG: "0;15" }, query: async () => null })).toBe("light");
  expect(await detectTheme({ env: { COLORFGBG: "15;0" } })).toBe("dark");
  expect(await detectTheme({ env: {} })).toBe("dark");
});

test("OSC parsing handles 8, 12 and 16 bit channels", () => {
  expect(parseOscBackground("\x1b]11;rgb:ff/ff/ff\x07")).toBe("light");
  expect(parseOscBackground("\x1b]11;rgb:000/000/000\x07")).toBe("dark");
  expect(parseOscBackground("nonsense")).toBeNull();
  expect(themeFromColorFgBg(undefined)).toBeNull();
  expect(themeFromColorFgBg("7")).toBe("light");
});

test("the two palettes differ in foreground and the accent stays gold-ish", () => {
  expect(palette(true).foreground).not.toBe(palette(false).foreground);
  expect(palette(false).accent).toBe("#E3B756");
});

test("/sound: toggle, on, off, max", () => {
  const off = { turnEnd: false, attentionRequired: false, max: false };
  expect(applySound(off)).toMatchObject({ turnEnd: true });
  expect(applySound(off, "on")).toEqual({ turnEnd: true, attentionRequired: true, max: false });
  expect(applySound(applySound(off, "max")!, "off")).toEqual(off);
  expect(applySound(off, "loud")).toBeNull();
  expect(soundLevel(applySound(off, "max")!)).toBe("max");
  expect(soundPatch(off)).toEqual({ notifications: { turn_end: false, attention_required: false, max: false } });
});
