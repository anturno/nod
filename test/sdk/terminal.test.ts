import { describe, expect, test } from "bun:test";
import { createTerminal, type RunTuiOptions, type TerminalAdapter } from "../../src/sdk/terminal.ts";
import { encodeXtermKeyEvent, xtermAdapter } from "../../src/sdk/xterm.ts";

/** A terminal surface that records output and lets the test type. */
function fakeTerminal() {
  const output: string[] = [];
  let data: ((d: string) => void) | undefined;
  let resize: (() => void) | undefined;
  const released: string[] = [];
  let drained = 0;
  const adapter: TerminalAdapter = {
    cols: 100,
    rows: 30,
    write: (bytes) => output.push(typeof bytes === "string" ? bytes : new TextDecoder().decode(bytes)),
    onData(cb) {
      data = cb;
      return () => released.push("data");
    },
    onResize(cb) {
      resize = cb;
      return () => released.push("resize");
    },
    drain() {
      drained++;
    },
  };
  return {
    adapter,
    output,
    released,
    drained: () => drained,
    type: (d: string) => data?.(d),
    resizeEvent: () => resize?.(),
  };
}

/** Stands in for src/ui/index.tsx: prints a prompt, echoes input, exits 0 at stdin end or 7 on "q". */
function fakeTui() {
  const calls: RunTuiOptions[] = [];
  const runTui = (o: RunTuiOptions) => {
    calls.push(o);
    return new Promise<number>((resolve) => {
      o.stdout?.write("ready> ");
      o.stdin?.on("data", (chunk: Buffer) => {
        const text = String(chunk);
        o.stdout?.write(text);
        if (text.includes("q")) resolve(7);
      });
      o.stdin?.on("end", () => resolve(0));
    });
  };
  return { calls, runTui };
}

describe("sdk: createTerminal", () => {
  test("becomes interactive, echoes input from both sides, and exits with the shell's code", async () => {
    const term = fakeTerminal();
    const tui = fakeTui();
    const events: string[] = [];
    const runtime = await createTerminal({
      terminal: term.adapter,
      runTui: tui.runTui,
      env: { NOD_THEME: "light" },
      args: ["--resume", "last", "--full-access"],
      workspace: { cwd: "/tmp/ws" },
      onEvent: (e) => events.push(e.type),
    });
    await runtime.interactive;
    expect(term.drained()).toBe(1);
    expect(term.output.join("")).toBe("ready> ");
    term.type("hi");
    runtime.write("yo");
    await new Promise((r) => setTimeout(r, 10));
    expect(term.output.join("")).toBe("ready> hiyo");
    const o = tui.calls[0]!;
    expect(o).toMatchObject({ cwd: "/tmp/ws", resume: { kind: "last" }, fullAccess: true, patchConsole: false });
    expect(o.env.NOD_THEME).toBe("light");
    expect((o.stdout as unknown as { columns: number }).columns).toBe(100);
    let resized = 0;
    o.stdout?.on("resize", () => resized++);
    term.resizeEvent();
    runtime.resize();
    expect(resized).toBe(2);
    expect(events).toEqual(["runtime.start", "runtime.ready", "terminal.resize", "terminal.resize"]);
    runtime.write("\x03");
    expect(events.at(-1)).toBe("terminal.interrupt");
    runtime.write("q");
    expect(await runtime.exited).toBe(7);
    expect(term.released).toEqual(["data", "resize"]);
    expect(events.at(-1)).toBe("runtime.exit");
  });

  test("abort() exits 130 and releases the subscriptions", async () => {
    const term = fakeTerminal();
    const tui = fakeTui();
    const runtime = await createTerminal({ terminal: term.adapter, runTui: tui.runTui });
    await runtime.interactive;
    runtime.abort();
    expect(await runtime.exited).toBe(130);
    expect(term.released).toEqual(["data", "resize"]);
  });

  test("an early exit rejects interactive; bad options throw", async () => {
    const term = fakeTerminal();
    const runtime = await createTerminal({ terminal: term.adapter, runTui: async () => 3 });
    expect(await runtime.exited).toBe(3);
    await expect(runtime.interactive).rejects.toThrow("exited with code 3 before becoming interactive");
    await expect(createTerminal({} as never)).rejects.toThrow("terminal is required");
    await expect(createTerminal({ terminal: term.adapter, runTui: async () => 0, args: ["ask"] })).rejects.toThrow(
      "unsupported terminal argument: ask",
    );
  });
});

describe("sdk: xterm", () => {
  const key = (
    k: string,
    mods: Partial<{ shiftKey: boolean; metaKey: boolean; altKey: boolean; ctrlKey: boolean }> = {},
  ) => ({
    type: "keydown",
    key: k,
    shiftKey: false,
    metaKey: false,
    altKey: false,
    ctrlKey: false,
    ...mods,
  });

  test("encodeXtermKeyEvent covers the composer keys", () => {
    expect(encodeXtermKeyEvent(key("Enter", { shiftKey: true }))).toBe("\x1b[13;2u");
    expect(encodeXtermKeyEvent(key("Backspace", { metaKey: true }))).toBe("\x1b\x7f");
    expect(encodeXtermKeyEvent(key("ArrowLeft", { metaKey: true }))).toBe("\x1bb");
    expect(encodeXtermKeyEvent(key("ArrowRight", { metaKey: true }))).toBe("\x1bf");
    expect(encodeXtermKeyEvent(key("ArrowUp", { metaKey: true }))).toBe("\x1b[1;9A");
    expect(encodeXtermKeyEvent(key("a", { metaKey: true }))).toBe("\x1b[97;9u");
    expect(encodeXtermKeyEvent(key("Enter"))).toBeNull();
    expect(encodeXtermKeyEvent(key("Enter", { shiftKey: true, ctrlKey: true }))).toBeNull();
    expect(encodeXtermKeyEvent({ ...key("Enter", { shiftKey: true }), type: "keyup" })).toBeNull();
  });

  test("xtermAdapter forwards data, resize, and composer keys", () => {
    const written: string[] = [];
    let handler: ((e: KeyboardEvent) => boolean) | undefined;
    let onData: ((d: string) => void) | undefined;
    const disposed: string[] = [];
    const term = {
      cols: 80,
      rows: 24,
      write: (d: string | Uint8Array) => written.push(String(d)),
      onData(cb: (d: string) => void) {
        onData = cb;
        return { dispose: () => disposed.push("data") };
      },
      onResize() {
        return { dispose: () => disposed.push("resize") };
      },
      attachCustomKeyEventHandler(h: (e: KeyboardEvent) => boolean) {
        handler = h;
      },
      hasSelection: () => false,
    };
    const adapter = xtermAdapter(term);
    expect([adapter.cols, adapter.rows]).toEqual([80, 24]);
    adapter.write("out");
    expect(written).toEqual(["out"]);
    const received: string[] = [];
    const off = adapter.onData((d) => received.push(d));
    onData?.("typed");
    expect(handler?.(key("Enter", { shiftKey: true }) as never)).toBe(false);
    expect(handler?.(key("Enter") as never)).toBe(true);
    expect(received).toEqual(["typed", "\x1b[13;2u"]);
    off();
    adapter.onResize(() => {})();
    expect(disposed).toEqual(["data", "resize"]);
    expect(handler?.(key("Enter", { shiftKey: true }) as never)).toBe(true);
  });
});
