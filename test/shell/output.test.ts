import { describe, expect, test } from "bun:test";
import { boundOutput, terminalSafe } from "../../src/core/shell/output.ts";

describe("terminalSafe", () => {
  test("strips CSI, OSC and DCS sequences", () => {
    expect(terminalSafe("\x1b[31mred\x1b[0m")).toBe("red");
    expect(terminalSafe("\x1b]0;title\x07body")).toBe("body");
    expect(terminalSafe("\x1b]8;;http://x\x1b\\link\x1b]8;;\x1b\\")).toBe("link");
    expect(terminalSafe("\x1bPq...\x1b\\after")).toBe("after");
    expect(terminalSafe("\x1b(Bx")).toBe("x");
  });

  test("escapes other control characters but keeps tab and newline", () => {
    expect(terminalSafe("a\x01b\tc\nd\x7f")).toBe("a\\u{0001}b\tc\nd\\u{007f}");
    expect(terminalSafe("\x1b")).toBe("\\u{001b}");
    expect(terminalSafe("x\u200by\ufeff")).toBe("x\\u{200b}y\\u{feff}");
    expect(terminalSafe("\u0085")).toBe("\\u{0085}");
  });

  test("applies bare carriage return as line overwrite", () => {
    expect(terminalSafe("abc\rXY")).toBe("XYc");
    expect(terminalSafe("10%\r50%\r100%\ndone")).toBe("100%\ndone");
    expect(terminalSafe("line\r\nnext")).toBe("line\nnext");
    expect(terminalSafe("keep\r")).toBe("keep");
  });

  test("keeps valid UTF-8 and drops invalid bytes", () => {
    expect(terminalSafe(Buffer.from([0x61, 0xff, 0x62, 0xc3, 0xa9]))).toBe("abé");
    expect(terminalSafe("日本語 ✓")).toBe("日本語 ✓");
  });
});

describe("boundOutput", () => {
  const marker = "<cut>";

  test("returns short text untouched", () => {
    expect(boundOutput("hello", 5, marker)).toBe("hello");
  });

  test("keeps head and tail around the marker within the budget", () => {
    const text = "0123456789abcdefghij";
    const out = boundOutput(text, 13, marker);
    expect(out).toBe("0123<cut>ghij");
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(13);
  });

  test("rounds an odd budget towards the head", () => {
    expect(boundOutput("0123456789abcdefghij", 14, marker)).toBe("01234<cut>ghij");
  });

  test("cuts at UTF-8 boundaries", () => {
    const out = boundOutput("ééééééééééé", 12, marker);
    expect(out).toBe("éé<cut>é");
    expect(Buffer.byteLength(out)).toBeLessThanOrEqual(12);
    expect(boundOutput("ééééééééééé", 11, marker)).toBe("é<cut>é");
  });

  test("degrades to a marker prefix when the budget cannot hold it", () => {
    expect(boundOutput("0123456789", 3, marker)).toBe("<cu");
    expect(boundOutput("0123456789", 0, marker)).toBe("");
  });
});
