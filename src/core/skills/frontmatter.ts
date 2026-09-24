/** SKILL.md frontmatter: name (required, one line) and description (plain, quoted, or a > >- | block). */

export const MAX_FRONTMATTER_BYTES = 64 * 1024;
export const MAX_NAME_BYTES = 256;

export type InvalidCause =
  | "missing_closing_delimiter"
  | "frontmatter_too_long"
  | "missing_name"
  | "invalid_name"
  | "duplicate_recognized_key"
  | "unsupported_multiline"
  | "invalid_utf8"
  | "control_byte";

export type ParsedSkillFile =
  | { status: "valid"; name: string; description: string; body: string }
  | { status: "no_frontmatter"; body: string }
  | { status: "invalid"; cause: InvalidCause };

// biome-ignore lint/suspicious/noControlCharactersInRegex: control bytes are exactly what frontmatter must reject
const hasControl = (s: string) => /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(s);

export function validSkillName(name: string): boolean {
  if (name.length === 0 || Buffer.byteLength(name) > MAX_NAME_BYTES) return false;
  if (name === "." || name === "..") return false;
  if (/[/\\\n\r]/.test(name) || hasControl(name)) return false;
  return true;
}

function scalar(raw: string): string {
  const v = raw.trim();
  if (v.length >= 2 && ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))))
    return v.slice(1, -1);
  return v;
}

/** Folds (>) joins lines with spaces; literal (|) keeps newlines; the "-" chomp strips the trailing newline. */
function block(indicator: string, lines: string[]): string | InvalidCause {
  if (!/^[>|]-?$/.test(indicator)) return "unsupported_multiline";
  const first = lines.find((l) => l.trim().length > 0);
  if (first === undefined) return "";
  const indent = first.length - first.trimStart().length;
  if (indent === 0 || first.startsWith("\t")) return "unsupported_multiline";
  const out: string[] = [];
  for (const line of lines) {
    if (line.trim().length === 0) {
      out.push("");
      continue;
    }
    if (line.startsWith("\t")) return "unsupported_multiline";
    const lineIndent = line.length - line.trimStart().length;
    if (lineIndent < indent) return "unsupported_multiline";
    out.push(line.slice(indent));
  }
  let text: string;
  if (indicator.startsWith("|")) text = `${out.join("\n")}\n`;
  else {
    text = "";
    for (const line of out) {
      if (line === "") text += "\n";
      else if (text === "" || text.endsWith("\n")) text += line;
      else text += ` ${line}`;
    }
    text += "\n";
  }
  return indicator.endsWith("-") ? text.replace(/\n+$/, "") : text.replace(/\n+$/, "\n");
}

export function parseSkillFile(input: Buffer | string): ParsedSkillFile {
  const bytes = typeof input === "string" ? Buffer.from(input) : input;
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { status: "invalid", cause: "invalid_utf8" };
  }
  if (text.startsWith("﻿")) text = text.slice(1);
  const normalized = text.replace(/\r\n/g, "\n");
  if (!normalized.startsWith("---\n")) return { status: "no_frontmatter", body: normalized };
  const close = normalized.indexOf("\n---", 3);
  if (close < 0) return { status: "invalid", cause: "missing_closing_delimiter" };
  if (close > MAX_FRONTMATTER_BYTES) return { status: "invalid", cause: "frontmatter_too_long" };
  const header = normalized.slice(4, close);
  const bodyStart = normalized.indexOf("\n", close + 1);
  const body = bodyStart < 0 ? "" : normalized.slice(bodyStart + 1);
  if (hasControl(header)) return { status: "invalid", cause: "control_byte" };
  const lines = header.split("\n");
  let name: string | undefined;
  let description: string | undefined;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const m = /^([A-Za-z0-9_-]+):(.*)$/.exec(line);
    if (!m) continue;
    const key = m[1] as string;
    const rest = (m[2] as string).trim();
    if (key !== "name" && key !== "description") continue;
    let value: string;
    if (/^[>|]/.test(rest)) {
      if (key === "name") return { status: "invalid", cause: "unsupported_multiline" };
      const blockLines: string[] = [];
      while (i + 1 < lines.length && !/^[A-Za-z0-9_-]+:/.test(lines[i + 1] as string))
        blockLines.push(lines[++i] as string);
      const folded = block(rest, blockLines);
      if (folded === "unsupported_multiline") return { status: "invalid", cause: folded };
      value = folded as string;
    } else value = scalar(rest);
    if (key === "name") {
      if (name !== undefined) return { status: "invalid", cause: "duplicate_recognized_key" };
      name = value;
    } else {
      if (description !== undefined) return { status: "invalid", cause: "duplicate_recognized_key" };
      description = value;
    }
  }
  if (name === undefined || name.length === 0) return { status: "invalid", cause: "missing_name" };
  if (!validSkillName(name)) return { status: "invalid", cause: "invalid_name" };
  return { status: "valid", name, description: description ?? "", body };
}
