/** Terminal-safe projection of raw command output and byte-bounded head/tail trimming. */

// biome-ignore-start lint/suspicious/noControlCharactersInRegex: matching ESC and C0/C1 is the whole point
const ANSI = [
  /\x1b\[[0-?]*[ -/]*[@-~]/g, // CSI
  /\x1b\][^\x07\x1b\n]*(?:\x07|\x1b\\)?/g, // OSC (bell or ST terminated; unterminated ends at newline)
  /\x1b[PX^_][^\x1b]*?\x1b\\/g, // DCS, SOS, PM, APC
  /\x1b[ -/]*[0-~]/g, // remaining two-byte and nF escapes
];
// C0 (except \t \n), DEL, C1, and the invisible format codepoints fx escapes.
const CONTROL = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f\x80-\x9f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g;
// biome-ignore-end lint/suspicious/noControlCharactersInRegex: matching ESC and C0/C1 is the whole point

/** Applies `\r` as "return to column 0 and overwrite" within one line. */
function overwriteLine(line: string): string {
  const parts = line.split("\r");
  let out = parts[0] ?? "";
  for (const next of parts.slice(1)) out = next.length >= out.length ? next : next + out.slice(next.length);
  return out;
}

/**
 * Strips ANSI control sequences, escapes other control characters as `\u{XXXX}`,
 * applies bare `\r` as a line overwrite, and drops bytes that are not valid UTF-8.
 */
export function terminalSafe(raw: Uint8Array | string): string {
  // ponytail: invalid bytes become U+FFFD and are dropped, so a genuine U+FFFD is dropped too.
  let text = typeof raw === "string" ? raw : new TextDecoder("utf-8").decode(raw).replaceAll("�", "");
  for (const re of ANSI) text = text.replace(re, "");
  text = text.replaceAll("\r\n", "\n");
  if (text.includes("\r")) text = text.split("\n").map(overwriteLine).join("\n");
  return text.replace(CONTROL, (c) => `\\u{${c.codePointAt(0)!.toString(16).padStart(4, "0")}}`);
}

/** Largest index <= index that does not split a UTF-8 sequence. */
export function utf8Backward(bytes: Uint8Array, index: number): number {
  let i = Math.min(index, bytes.length);
  while (i > 0 && i < bytes.length && (bytes[i]! & 0xc0) === 0x80) i--;
  return i;
}

/** Smallest index >= index that does not split a UTF-8 sequence. */
export function utf8Forward(bytes: Uint8Array, index: number): number {
  let i = Math.min(index, bytes.length);
  while (i < bytes.length && (bytes[i]! & 0xc0) === 0x80) i++;
  return i;
}

/** Keeps `text` within maxBytes as head + marker + tail, cutting at UTF-8 boundaries (head rounds up). */
export function boundOutput(text: string, maxBytes: number, marker: string): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  const mark = Buffer.from(marker);
  if (maxBytes <= mark.length) return mark.subarray(0, maxBytes).toString();
  const retained = maxBytes - mark.length;
  const head = Math.ceil(retained / 2);
  const tail = retained - head;
  return (
    bytes.subarray(0, utf8Backward(bytes, head)).toString() +
    marker +
    bytes.subarray(utf8Forward(bytes, bytes.length - tail)).toString()
  );
}
