/** Tiny helpers shared by tool decoders. */
import type { DecodeResult } from "./spec.ts";

export type Args = Record<string, unknown>;

export const isRecord = (value: unknown): value is Args =>
  typeof value === "object" && value !== null && !Array.isArray(value);

export const ok = <T>(input: T): DecodeResult<T> => ({ ok: true, input });
export const fail = <T>(failure: string): DecodeResult<T> => ({ ok: false, failure });

/** Returns the integer, undefined when absent, or a failure string when present but invalid. */
export function optionalInt(
  args: Args,
  key: string,
  min: number,
  tool: string,
  description: string,
): number | undefined | { failure: string } {
  if (!(key in args)) return undefined;
  const value = args[key];
  if (!Number.isInteger(value) || (value as number) < min) {
    return { failure: `${tool} field "${key}" must be a ${description} integer` };
  }
  return value as number;
}

export const errorName = (err: unknown): string => {
  const code = (err as NodeJS.ErrnoException)?.code;
  if (code === "ENOENT") return "FileNotFound";
  if (code === "EACCES" || code === "EPERM") return "AccessDenied";
  if (code === "ENOTDIR") return "NotDir";
  if (code === "EISDIR") return "IsDir";
  if (code === "ELOOP") return "SymLinkLoop";
  if (code === "ENAMETOOLONG") return "NameTooLong";
  if (code) return code;
  return err instanceof Error ? err.message : String(err);
};

export const isAccessDenied = (err: unknown): boolean => errorName(err) === "AccessDenied";
