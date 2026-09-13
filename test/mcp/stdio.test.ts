import { describe, expect, test } from "bun:test";
import { connectClient } from "../../src/core/mcp/client.ts";
import { injectCidfile, spawnStdio } from "../../src/core/mcp/transport/stdio.ts";
import { fixtureCommand } from "./helpers.ts";

const open = (env: Record<string, string> = {}, graceMs = 150) => {
  let transport: ReturnType<typeof spawnStdio> | undefined;
  const closes: (Error | undefined)[] = [];
  const client = connectClient({
    openTransport: (h) => {
      transport = spawnStdio({ ...h, command: fixtureCommand(), env: { ...process.env, ...env }, graceMs });
      return transport;
    },
    operationTimeoutMs: 3000,
    startupTimeoutMs: 5000,
    version: "t",
    onClose: (r) => void closes.push(r),
  });
  return { client, transport: () => transport as ReturnType<typeof spawnStdio>, closes };
};

describe("stdio transport", () => {
  test("negotiates, lists tools, calls, keeps stderr, and exits cleanly on stdin close", async () => {
    const { client, transport, closes } = open();
    const c = await client;
    expect(c.protocolVersion).toBe("2025-11-25");
    expect(c.instructions).toBe("Fixture instructions");
    const { tools, rejected } = await c.listTools();
    expect(tools.map((t) => t.name)).toEqual(["echo"]);
    expect(rejected).toBe(1);
    const r = await c.callTool("echo", { text: "hi" });
    expect(r.content).toEqual([{ type: "text", text: "echo:hi" }]);
    await new Promise((res) => setTimeout(res, 20));
    expect(c.stderrTail()).toEqual(["handling call"]);
    await c.close();
    expect(await transport().exited).toBe(0);
    expect(closes).toEqual([]);
  });

  test("falls back to the version a strict server accepts", async () => {
    const { client } = open({ MCP_FIXTURE_VERSION: "2025-06-18", MCP_FIXTURE_STRICT: "1" });
    const c = await client;
    expect(c.protocolVersion).toBe("2025-06-18");
    await c.close();
  });

  test("escalates stdin close → SIGTERM → SIGKILL for a server that ignores both", async () => {
    const { client, transport } = open({ MCP_FIXTURE_IGNORE_TERM: "1" }, 100);
    const c = await client;
    const started = Date.now();
    await c.close();
    const elapsed = Date.now() - started;
    expect(elapsed).toBeGreaterThanOrEqual(180);
    expect(elapsed).toBeLessThan(2000);
    expect(await transport().exited).not.toBe(0);
  });

  test("an unexpected exit rejects in-flight requests and reports the close", async () => {
    const { client, closes } = open({ MCP_FIXTURE_CRASH_ON_CALL: "1" });
    const c = await client;
    await expect(c.callTool("echo", {})).rejects.toThrow("exited with code 3");
    expect(closes[0]?.message).toBe("MCP server exited with code 3");
  });

  test("docker run gets a cidfile unless one is present", () => {
    expect(injectCidfile(["docker", "run", "img"], "/tmp/c")).toEqual(["docker", "run", "--cidfile", "/tmp/c", "img"]);
    const own = ["docker", "run", "--cidfile=/x", "img"];
    expect(injectCidfile(own, "/tmp/c")).toBe(own);
    const other = ["node", "s.js"];
    expect(injectCidfile(other, "/tmp/c")).toBe(other);
  });
});
