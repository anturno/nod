import { expect, test } from "bun:test";
import {
  type ContextLimitError,
  DEFAULT_LIMITS,
  EMERGENCY_CEILING_BYTES,
  LIMIT_NAMES,
  lineSafePrefixLength,
  parseLimitsObject,
  parseOverride,
  resolveLimits,
  utf8PrefixLength,
} from "../../src/core/context/limits.ts";

const bytes = (s: string) => new TextEncoder().encode(s);
const code = (fn: () => unknown) => {
  try {
    fn();
  } catch (err) {
    return (err as ContextLimitError).code;
  }
  return "no error";
};

test("defaults match the public context limit contract", () => {
  const limits = resolveLimits();
  expect(LIMIT_NAMES).toHaveLength(11);
  for (const name of LIMIT_NAMES) {
    expect(limits[name].bytes).toBe(DEFAULT_LIMITS[name]);
    expect(limits[name].source).toBe("compiled default");
  }
  expect(DEFAULT_LIMITS.skill_file_bytes).toBe(1024 * 1024);
  expect(DEFAULT_LIMITS.project_instructions_total_bytes).toBe(131072);
});

test("overrides accept bytes and off", () => {
  expect(parseOverride("skill_chunk_bytes=4096")).toEqual({ name: "skill_chunk_bytes", value: 4096 });
  expect(parseOverride(" mcp_description_bytes = OFF ")).toEqual({ name: "mcp_description_bytes", value: "off" });
  expect(
    resolveLimits(undefined, undefined, [parseOverride("mcp_description_bytes=off")]).mcp_description_bytes.bytes,
  ).toBe(EMERGENCY_CEILING_BYTES);
});

test("overrides reject unknown names and malformed values", () => {
  expect(code(() => parseOverride("wat=1"))).toBe("UnknownContextLimit");
  expect(code(() => parseOverride("skill_chunk_bytes=-1"))).toBe("InvalidContextLimitValue");
  expect(code(() => parseOverride("skill_chunk_bytes"))).toBe("InvalidContextLimitOverride");
  expect(code(() => parseOverride("=1"))).toBe("InvalidContextLimitOverride");
  expect(code(() => parseOverride("skill_chunk_bytes="))).toBe("InvalidContextLimitOverride");
});

test("settings object parses integers and strings", () => {
  expect(parseLimitsObject({ skill_chunk_bytes: 10, mcp_description_bytes: "off", skill_file_bytes: "2048" })).toEqual({
    skill_chunk_bytes: 10,
    mcp_description_bytes: "off",
    skill_file_bytes: 2048,
  });
  expect(code(() => parseLimitsObject([]))).toBe("InvalidContextLimitsType");
  expect(code(() => parseLimitsObject({ nope: 1 }))).toBe("UnknownContextLimit");
  expect(code(() => parseLimitsObject({ skill_chunk_bytes: -1 }))).toBe("InvalidContextLimitValue");
  expect(code(() => parseLimitsObject({ skill_chunk_bytes: 1.5 }))).toBe("InvalidContextLimitValue");
  expect(code(() => parseLimitsObject({ skill_chunk_bytes: true }))).toBe("InvalidContextLimitValue");
});

test("resolution records the winning layer per limit", () => {
  const limits = resolveLimits({ skill_chunk_bytes: 1, skill_file_bytes: 2 }, { skill_file_bytes: 3 }, [
    { name: "mcp_description_bytes", value: 4 },
  ]);
  expect(limits.skill_chunk_bytes).toEqual({ value: 1, source: "global settings", bytes: 1 });
  expect(limits.skill_file_bytes).toEqual({ value: 3, source: "workspace settings", bytes: 3 });
  expect(limits.mcp_description_bytes).toEqual({ value: 4, source: "command line", bytes: 4 });
  expect(limits.skill_catalog_bytes.source).toBe("compiled default");
  expect(resolveLimits({ skill_chunk_bytes: EMERGENCY_CEILING_BYTES * 2 }).skill_chunk_bytes.bytes).toBe(
    EMERGENCY_CEILING_BYTES,
  );
});

test("line safe prefix preserves utf8 and complete lines when possible", () => {
  expect(lineSafePrefixLength(bytes("one\ntwo\n"), 7)).toBe(4);
  expect(lineSafePrefixLength(bytes("éclair"), 1)).toBe(0);
  expect(lineSafePrefixLength(bytes("éclair"), 2)).toBe(2);
  expect(lineSafePrefixLength(new Uint8Array([0x61, 0x62, 0x63, 0xe4]), 4)).toBe(3);
  expect(lineSafePrefixLength(bytes("one\ntwo"), 100)).toBe(7);
  expect(utf8PrefixLength(bytes("日本"), 4)).toBe(3);
  expect(utf8PrefixLength(bytes("abc"), 0)).toBe(0);
});
