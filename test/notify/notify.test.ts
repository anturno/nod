import { expect, test } from "bun:test";
import { notify, type Sink, soundPrefs } from "../../src/core/notify/index.ts";

const sink = (platform: NodeJS.Platform, failSpawn = false) => {
  const calls: string[] = [];
  const s: Sink = {
    platform,
    spawn(cmd, args) {
      if (failSpawn) throw new Error("no afplay");
      calls.push(`${cmd} ${args.join(" ")}`);
    },
    bell: () => calls.push("bell"),
  };
  return { s, calls };
};
const prefs = {
  turn_end: true,
  attention_required: true,
  max: false,
  cueFiles: { success: "/t/s.m4a", error: "/t/e.m4a" },
};

test("macOS plays the cue, falls back to bell; attention always bells; other platforms bell", () => {
  let m = sink("darwin");
  notify("turn_end", "success", prefs, m.s);
  expect(m.calls).toEqual(["/usr/bin/afplay /t/s.m4a"]);
  m = sink("darwin", true);
  notify("turn_end", "error", prefs, m.s);
  expect(m.calls).toEqual(["bell"]);
  m = sink("darwin");
  notify("attention_required", "success", prefs, m.s);
  expect(m.calls).toEqual(["bell", "/usr/bin/afplay /t/s.m4a"]);
  m = sink("linux");
  notify("turn_end", "success", prefs, m.s);
  expect(m.calls).toEqual(["bell"]);
  m = sink("darwin");
  notify("turn_end", "success", { ...prefs, turn_end: false }, m.s);
  expect(m.calls).toEqual([]);
  m = sink("darwin");
  notify("turn_end", "success", { ...prefs, cueFiles: {} }, m.s);
  expect(m.calls).toEqual(["bell"]);
});

test("soundPrefs: defaults per platform, settings, NOD_SOUND override", () => {
  expect(soundPrefs(undefined, {}, "darwin")).toEqual({ turn_end: true, attention_required: true, max: false });
  expect(soundPrefs(undefined, {}, "linux")).toEqual({ turn_end: false, attention_required: false, max: false });
  expect(soundPrefs({ turn_end: false, max: true }, {}, "darwin")).toEqual({
    turn_end: false,
    attention_required: true,
    max: true,
  });
  expect(soundPrefs({ turn_end: true }, { NOD_SOUND: "off" }, "darwin")).toEqual({
    turn_end: false,
    attention_required: false,
    max: false,
  });
  expect(soundPrefs({ turn_end: false }, { NOD_SOUND: "1" }, "linux")).toEqual({
    turn_end: true,
    attention_required: true,
    max: false,
  });
  expect(soundPrefs({ turn_end: false }, { NOD_SOUND: "MAX" }, "linux")).toEqual({
    turn_end: true,
    attention_required: true,
    max: true,
  });
  expect(soundPrefs({ turn_end: false }, { NOD_SOUND: "  " }, "linux")).toEqual({
    turn_end: false,
    attention_required: false,
    max: false,
  });
});
