/** Context byte limits: the documented table, `--context-limit name=bytes|off` overrides, and safe prefix cuts. */

export const EMERGENCY_CEILING_BYTES = 64 * 1024 * 1024;

export const DEFAULT_LIMITS = {
  skill_description_bytes: 1024,
  skill_catalog_bytes: 16 * 1024,
  skill_chunk_bytes: 20 * 1024,
  skill_file_bytes: 1024 * 1024,
  mcp_description_bytes: 1024,
  mcp_search_result_bytes: 16 * 1024,
  mcp_server_instructions_bytes: 2 * 1024,
  mcp_selected_schema_bytes: 64 * 1024,
  project_instruction_file_bytes: 64 * 1024,
  project_instructions_total_bytes: 128 * 1024,
  image_adapter_output_bytes: 20 * 1024,
} as const;

export type LimitName = keyof typeof DEFAULT_LIMITS;
export const LIMIT_NAMES = Object.keys(DEFAULT_LIMITS) as LimitName[];
export const isLimitName = (raw: string): raw is LimitName => Object.hasOwn(DEFAULT_LIMITS, raw);

/** "off" lifts the limit to the emergency ceiling. */
export type LimitValue = number | "off";
export type LimitSource = "compiled default" | "global settings" | "workspace settings" | "command line";
export type LimitOverrides = Partial<Record<LimitName, LimitValue>>;
export type LimitOverride = { name: LimitName; value: LimitValue };
export type ResolvedLimit = { value: LimitValue; source: LimitSource; bytes: number };
export type ResolvedLimits = Record<LimitName, ResolvedLimit>;

export type ContextLimitErrorCode =
  | "InvalidContextLimitOverride"
  | "UnknownContextLimit"
  | "InvalidContextLimitValue"
  | "InvalidContextLimitsType";

export class ContextLimitError extends Error {
  constructor(
    public code: ContextLimitErrorCode,
    message: string = code,
  ) {
    super(message);
  }
}

export const effectiveBytes = (value: LimitValue) =>
  Math.min(value === "off" ? EMERGENCY_CEILING_BYTES : value, EMERGENCY_CEILING_BYTES);

function parseValueString(raw: string): LimitValue {
  if (raw.toLowerCase() === "off") return "off";
  if (!/^\d+$/.test(raw))
    throw new ContextLimitError("InvalidContextLimitValue", `invalid context limit value: ${raw}`);
  return Number(raw);
}

/** `--context-limit name=bytes|off`. */
export function parseOverride(raw: string): LimitOverride {
  const separator = raw.indexOf("=");
  if (separator < 0) throw new ContextLimitError("InvalidContextLimitOverride", `expected name=value: ${raw}`);
  const name = raw.slice(0, separator).trim();
  const value = raw.slice(separator + 1).trim();
  if (!name || !value) throw new ContextLimitError("InvalidContextLimitOverride", `expected name=value: ${raw}`);
  if (!isLimitName(name)) throw new ContextLimitError("UnknownContextLimit", `unknown context limit: ${name}`);
  return { name, value: parseValueString(value) };
}

/** The `context_limits` object of settings.json. */
export function parseLimitsObject(json: unknown): LimitOverrides {
  if (typeof json !== "object" || json === null || Array.isArray(json))
    throw new ContextLimitError("InvalidContextLimitsType", "context_limits must be an object");
  const result: LimitOverrides = {};
  for (const [name, value] of Object.entries(json)) {
    if (!isLimitName(name)) throw new ContextLimitError("UnknownContextLimit", `unknown context limit: ${name}`);
    if (typeof value === "string") result[name] = parseValueString(value);
    else if (Number.isInteger(value) && (value as number) >= 0) result[name] = value as number;
    else throw new ContextLimitError("InvalidContextLimitValue", `invalid context limit value for ${name}`);
  }
  return result;
}

/** Later layers win: compiled default → global settings → workspace settings → command line. */
export function resolveLimits(
  global?: LimitOverrides,
  workspace?: LimitOverrides,
  cli?: LimitOverride[],
): ResolvedLimits {
  const out = {} as ResolvedLimits;
  const set = (name: LimitName, value: LimitValue, source: LimitSource) =>
    (out[name] = { value, source, bytes: effectiveBytes(value) });
  for (const name of LIMIT_NAMES) set(name, DEFAULT_LIMITS[name], "compiled default");
  for (const [name, value] of Object.entries(global ?? {}) as [LimitName, LimitValue][])
    set(name, value, "global settings");
  for (const [name, value] of Object.entries(workspace ?? {}) as [LimitName, LimitValue][])
    set(name, value, "workspace settings");
  for (const { name, value } of cli ?? []) set(name, value, "command line");
  return out;
}

const strictUtf8 = new TextDecoder("utf-8", { fatal: true });
const validUtf8 = (bytes: Uint8Array) => {
  try {
    strictUtf8.decode(bytes);
    return true;
  } catch {
    return false;
  }
};

/** Longest prefix of at most `max` bytes that does not split a UTF-8 sequence. */
export function utf8PrefixLength(bytes: Uint8Array, max: number): number {
  let end = Math.min(max, bytes.length);
  while (end > 0 && !validUtf8(bytes.subarray(0, end))) end--;
  return end;
}

/** Like utf8PrefixLength, but ends after the last complete line when the input has to be cut. */
export function lineSafePrefixLength(bytes: Uint8Array, max: number): number {
  const end = utf8PrefixLength(bytes, max);
  if (end === bytes.length) return end;
  const newline = bytes.subarray(0, end).lastIndexOf(0x0a);
  return newline >= 0 ? newline + 1 : end;
}
