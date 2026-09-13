import { expect, test } from "bun:test";
import { SLASH } from "../../src/cli/commands.ts";
import {
  completeSlash,
  cycleTab,
  helpText,
  parseSlash,
  SLASH_TABS,
  slashRows,
  slashTitle,
  unknownCommandNotice,
} from "../../src/ui/core/commands.ts";

test("rows search command, alias, description and category; the title counts them", () => {
  expect(slashRows("/", null)).toHaveLength(SLASH.length);
  expect(slashRows("/cost", null).map((s) => s.command)).toEqual(["/usage"]);
  expect(slashRows("/fresh", null).map((s) => s.command)).toEqual(["/clear", "/new", "/reset"]);
  expect(slashRows("/", "Media").every((s) => s.category === "Media")).toBe(true);
  expect(slashRows("/appearance", null).map((s) => s.category)).toContain("Appearance");
  expect(slashTitle(3)).toBe("Commands 3");
});

test("tab completes a unique prefix, with a space when the command takes arguments", () => {
  expect(completeSlash("/mod")).toBe("/model ");
  expect(completeSlash("/hel")).toBe("/help");
  expect(completeSlash("/exi")).toBe("/exit");
  expect(completeSlash("/s")).toBeNull();
  expect(completeSlash("/zzz")).toBeNull();
});

test("category tabs cycle both ways through All and every category", () => {
  expect(cycleTab(null, 1)).toBe("General");
  expect(cycleTab(null, -1)).toBe("Product");
  expect(cycleTab("Product", 1)).toBeNull();
  let tab: (typeof SLASH_TABS)[number] = null;
  for (let i = 0; i < SLASH_TABS.length; i++) tab = cycleTab(tab, 1);
  expect(tab).toBeNull();
});

test("parseSlash tells commands, unknown commands and paths apart", () => {
  expect(parseSlash("/rename  My title")).toMatchObject({ kind: "command", token: "/rename", rest: "My title" });
  expect(parseSlash("/exit")).toMatchObject({ kind: "command", token: "/exit" });
  expect(parseSlash("/nope")).toEqual({ kind: "unknown", token: "/nope" });
  expect(parseSlash("/src/x.ts is broken")).toEqual({ kind: "prompt" });
  expect(unknownCommandNotice("/nope")).toBe("Unknown command /nope. Type / to see all commands.");
});

test("help lists every command under its category", () => {
  const text = helpText();
  for (const s of SLASH) expect(text).toContain(s.help);
  expect(text).toContain("General");
  expect(text).toContain("shift+enter newline");
});
