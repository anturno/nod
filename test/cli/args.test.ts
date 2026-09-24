import { expect, test } from "bun:test";
import { parseAskArgs } from "../../src/cli/ask-args.ts";
import {
  findTopLevel,
  looksLikeSlashCommand,
  matchSlash,
  renderTopLevelHelp,
  SLASH,
  searchSlash,
} from "../../src/cli/commands.ts";
import { parseFlags, parseGlobalArgs, parseResumeArgs } from "../../src/cli/global-args.ts";

test("global flags stop at the first command token", () => {
  const g = parseGlobalArgs([
    "--context-limit",
    "skill_catalog_bytes=1",
    "--add-dir=../x",
    "--no-additional-dirs",
    "--full-access",
    "ask",
    "--json",
    "hi",
  ]);
  expect(g.contextLimits).toEqual(["skill_catalog_bytes=1"]);
  expect(g.addDirs).toEqual(["../x"]);
  expect(g.noAdditionalDirs).toBe(true);
  expect(g.fullAccess).toBe(true);
  expect(g.rest).toEqual(["ask", "--json", "hi"]);
  expect(() => parseGlobalArgs(["--context-limit"])).toThrow("requires a value");
  expect(() => parseGlobalArgs(["--no-additional-dirs", "--no-additional-dirs"])).toThrow("once");
});

test("every resume spelling", () => {
  expect(parseGlobalArgs(["-r"]).resume).toEqual({ kind: "picker" });
  expect(parseGlobalArgs(["-c"]).resume).toEqual({ kind: "last" });
  expect(parseGlobalArgs(["--resume"]).resume).toEqual({ kind: "last" });
  expect(parseGlobalArgs(["--resume", "abc"]).resume).toEqual({ kind: "id", id: "abc" });
  expect(parseGlobalArgs(["--resume-abc"]).resume).toEqual({ kind: "id", id: "abc" });
  expect(() => parseGlobalArgs(["--resume-"])).toThrow();
  expect(parseResumeArgs([])).toEqual({ kind: "last" });
  expect(parseResumeArgs(["--id", "last"])).toEqual({ kind: "id", id: "last" });
  expect(parseResumeArgs(["xyz"])).toEqual({ kind: "id", id: "xyz" });
  expect(() => parseResumeArgs(["a", "b"])).toThrow();
});

test("parseFlags rejects duplicates and unknown options", () => {
  expect(parseFlags(["--json", "--limit", "5", "x"], { "--json": "boolean", "--limit": "string" }, "u")).toEqual({
    flags: { "--json": true, "--limit": "5" },
    positionals: ["x"],
  });
  expect(() => parseFlags(["--json", "--json"], { "--json": "boolean" }, "u")).toThrow("once");
  expect(() => parseFlags(["--nope"], {}, "u")).toThrow("unknown option");
});

test("ask args", () => {
  const a = parseAskArgs(["--auto", "--image", "a.png", "--image", "b.png", "--json", "--", "--not-a-flag", "hi"]);
  expect(a.permission).toBe("auto");
  expect(a.images).toEqual(["a.png", "b.png"]);
  expect(a.promptArgs).toEqual(["--not-a-flag", "hi"]);
  expect(parseAskArgs(["hello", "world"]).promptArgs).toEqual(["hello", "world"]);
  expect(parseAskArgs(["--resume", "last", "x"]).resume).toEqual({ kind: "last" });
  expect(parseAskArgs(["--resume-id", "last"]).resume).toEqual({ kind: "id", id: "last" });
  expect(() => parseAskArgs(["--auto", "--full-access", "x"])).toThrow("mutually exclusive");
  expect(() => parseAskArgs(["--no-save", "--resume", "last", "x"])).toThrow("--no-save");
  expect(() => parseAskArgs(["--continue-recovery"])).toThrow("requires --resume");
  expect(() => parseAskArgs(["--resume", "last", "--continue-recovery", "prompt"])).toThrow("does not accept");
  expect(() => parseAskArgs(["-x"])).toThrow("unknown option");
});

test("top-level help and lookup", () => {
  const help = renderTopLevelHelp("1.2.3");
  expect(help).toStartWith("nod v1.2.3\n");
  expect(help).toContain("  ask <prompt>");
  expect(help).not.toContain("credits");
  expect(findTopLevel("-h")?.token).toBe("help");
  expect(findTopLevel("--continue")?.token).toBe("resume");
});

test("slash registry order, aliases and matching", () => {
  expect(SLASH.map((s) => s.command).slice(0, 4)).toEqual(["/help", "/clear", "/new", "/reset"]);
  expect(SLASH.at(-1)?.command).toBe("/quit");
  expect(matchSlash("/exit")?.spec.command).toBe("/quit");
  expect(matchSlash("/model\tgpt")?.rest).toBe("gpt");
  expect(matchSlash("/rename My title here")?.rest).toBe("My title here");
  expect(matchSlash("/background")).toBeNull();
  expect(looksLikeSlashCommand("/src/app.ts")).toBe(false);
  expect(looksLikeSlashCommand("/model x")).toBe(true);
  expect(searchSlash("/cost").map((s) => s.command)).toEqual(["/usage"]);
  expect(searchSlash("", "Media").map((s) => s.command)).toEqual(["/image", "/images", "/paste"]);
});
