/** Incremental Server-Sent Events parser: `\r\n`, `\r`, and `\n` line ends; `data:` lines joined with `\n`. */
export type SseEvent = { event: string; data: string; id?: string };

export type SseParser = { feed(chunk: string): SseEvent[]; end(): SseEvent[] };

export function createSseParser(): SseParser {
  let buffer = "";
  let event = "";
  let data: string[] = [];
  let id: string | undefined;

  const flush = (out: SseEvent[]) => {
    if (data.length > 0)
      out.push({ event: event || "message", data: data.join("\n"), ...(id !== undefined ? { id } : {}) });
    event = "";
    data = [];
  };
  const line = (text: string, out: SseEvent[]) => {
    if (text === "") return flush(out);
    if (text.startsWith(":")) return;
    const colon = text.indexOf(":");
    const field = colon < 0 ? text : text.slice(0, colon);
    let value = colon < 0 ? "" : text.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
    else if (field === "id" && !value.includes("\0")) id = value;
  };
  const drain = (final: boolean): SseEvent[] => {
    const out: SseEvent[] = [];
    let start = 0;
    for (let i = 0; i < buffer.length; i++) {
      const c = buffer[i];
      if (c === "\n" || c === "\r") {
        if (c === "\r" && i + 1 === buffer.length && !final) break;
        line(buffer.slice(start, i), out);
        if (c === "\r" && buffer[i + 1] === "\n") i++;
        start = i + 1;
      }
    }
    buffer = buffer.slice(start);
    if (final) {
      if (buffer.length > 0) line(buffer, out);
      buffer = "";
      flush(out);
    }
    return out;
  };
  return { feed: (chunk) => ((buffer += chunk), drain(false)), end: () => drain(true) };
}

/** Parses a complete SSE body. */
export function parseSse(text: string): SseEvent[] {
  const parser = createSseParser();
  return [...parser.feed(text), ...parser.end()];
}
