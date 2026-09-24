import { describe, expect, test } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { runMcp } from "../../src/cli/mcp.ts";
import type { Io } from "../../src/cli/output.ts";
import { type McpCommandContext, runMcpCommand } from "../../src/core/mcp/commands.ts";
import { fixtureCommand, tempDir } from "./helpers.ts";

const ctx = (extra: Partial<McpCommandContext> = {}): McpCommandContext => ({
  home: tempDir(),
  workspaceRoot: tempDir("nod-ws-"),
  env: process.env,
  openUrl() {},
  interactive: false,
  ...extra,
});
const run = (argv: string, c: McpCommandContext) => runMcpCommand(argv.split(" ").filter(Boolean), c);

describe("mcp commands", () => {
  test("path, add, list, remove", async () => {
    const c = ctx();
    expect(await run("path", c)).toEqual({ ok: true, text: join(c.home, "mcp.json") });
    expect(await run("list", c)).toEqual({ ok: true, text: "No MCP servers configured." });
    expect(await run("add local-tools npx -y @modelcontextprotocol/server-everything", c)).toEqual({
      ok: true,
      text: "Saved MCP server 'local-tools'.",
    });
    expect(await run("add --transport http prisma https://mcp.prisma.io/mcp", c)).toEqual({
      ok: true,
      text: "Saved MCP server 'prisma'.",
    });
    expect(JSON.parse(readFileSync(join(c.home, "mcp.json"), "utf8")).mcp.prisma).toEqual({
      type: "http",
      url: "https://mcp.prisma.io/mcp",
    });
    expect((await run("add", c)).text).toBe(
      "usage: /mcp add <name> <command> [args...] or /mcp add --transport http <name> <url>",
    );
    expect((await run("add --transport sse x https://h", c)).ok).toBe(false);
    expect((await run("add --transport http x http://example.com", c)).text).toContain(
      "Failed to save MCP server config:",
    );
    const list = await run("list", c);
    expect(list.text.split("\n")).toEqual([
      "MCP configuration (2 servers):",
      "  local-tools source=profile policy=optional transport=stdio state=configured auth=none connection=not_checked",
      "  prisma source=profile policy=optional transport=http state=configured auth=none connection=not_checked",
    ]);
    expect(await run("remove prisma", c)).toEqual({ ok: true, text: "Removed MCP server 'prisma'." });
    expect(await run("remove prisma", c)).toEqual({ ok: false, text: "MCP server 'prisma' not found." });
    expect((await run("remove", c)).text).toBe("usage: /mcp remove <name>");
    expect((await run("bogus", c)).text).toBe(
      "usage: /mcp [list|resource|prompt|add|remove|path|reload|auth|logout|trust]",
    );
    expect((await run("list --x", c)).ok).toBe(false);
  });

  test("trust, auth, and logout messages", async () => {
    const c = ctx();
    writeFileSync(join(c.workspaceRoot, ".mcp.json"), JSON.stringify({ mcpServers: { proj: { command: "x" } } }));
    expect((await run("list", c)).text).toContain(
      "  proj source=project policy=optional transport=stdio state=pending auth=none connection=not_checked\n    admission=pending",
    );
    expect(await run("trust approve proj", c)).toEqual({ ok: true, text: "Approving project MCP server 'proj'." });
    expect((await run("list", c)).text).toContain("admission=approved");
    expect(await run("trust reject proj", c)).toEqual({ ok: true, text: "Rejecting project MCP server 'proj'." });
    expect(await run("trust approve-all", c)).toEqual({
      ok: true,
      text: "Approving all project MCP servers for this workspace.",
    });
    expect(await run("trust reset", c)).toEqual({
      ok: true,
      text: "Resetting project MCP choices for this workspace.",
    });
    expect((await run("trust", c)).text).toBe("usage: /mcp trust approve|reject <server> | approve-all | reset");
    expect((await run("trust approve", c)).text).toBe("usage: /mcp trust approve|reject <server>");
    expect((await run("trust reset now", c)).text).toBe("usage: /mcp trust reset");
    expect((await run("auth x", c)).text).toBe("Run /mcp auth x --open to confirm opening your browser.");
    expect((await run("auth x --open", c)).text).toBe("Interactive MCP authentication is unavailable here.");
    expect((await run("auth x --open", { ...c, interactive: true })).text).toBe(
      "MCP authentication for 'x' failed: MCP server 'x' not found.",
    );
    expect((await run("auth", c)).text).toBe("usage: /mcp auth <name> [--open]");
    expect(await run("logout x", c)).toEqual({ ok: false, text: "No stored MCP credentials found for 'x'." });
    writeFileSync(
      join(c.home, "mcp-credentials.json"),
      JSON.stringify({
        x: { access_token: "a", issuer: "i", client_id: "c", resource: "r", token_endpoint: "t" },
        junk: 1,
      }),
    );
    expect(await run("logout x", c)).toEqual({
      ok: true,
      text: "Logged out of MCP server 'x' locally; remote revocation failed. Removed 1 unreadable MCP credential entry.",
    });
  });

  test("list --connect and feature commands use a temporary runtime", async () => {
    const c = ctx();
    writeFileSync(join(c.home, "mcp.json"), JSON.stringify({ mcp: { fix: { command: fixtureCommand() } } }));
    const text = (await run("list --connect", c)).text;
    expect(text).toContain("MCP health (1 server):");
    expect(text).toContain("  fix source=profile policy=optional transport=stdio state=ready auth=none");
    expect(text).toContain("negotiated_name=fixture negotiated_version=1 protocol=2025-11-25");
    expect(text).toContain("tools=1 resources=unavailable");
    const r = await run("resource list fix", c);
    expect(r.ok).toBe(false);
    expect(r.text).toStartWith("MCP resource listing failed: ");
    expect((await run("resource read fix", c)).text).toBe("usage: /mcp resource read <server> <uri>");
    expect((await run("prompt get fix p {bad", c)).text).toBe(
      "MCP prompt invocation failed: arguments must be a JSON object.",
    );
    expect((await run("prompt", c)).text).toBe("usage: /mcp prompt [list|get|complete] ...");
    expect((await run("resource complete fix", c)).text).toBe(
      "usage: /mcp resource complete <server> <uri-template> <variable> [value]",
    );
  });

  test("nod mcp goes through runMcp with the process io", async () => {
    const home = tempDir();
    const out: string[] = [];
    const io: Io = {
      stdout: (t) => void out.push(t),
      stderr: (t) => void out.push(`ERR:${t}`),
      env: { NOD_HOME: home },
      cwd: tempDir("nod-ws-"),
      isTTY: false,
    };
    expect(await runMcp(["path"], io)).toBe(0);
    expect(out).toEqual([`${join(home, "mcp.json")}\n`]);
    expect(await runMcp(["remove", "nothing"], io)).toBe(1);
    expect(out[1]).toBe("ERR:MCP server 'nothing' not found.\n");
  });
});
