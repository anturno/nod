import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyTrust } from "../../src/core/mcp/project.ts";
import { createMcpRuntime, type McpRuntimeDeps } from "../../src/core/mcp/runtime.ts";
import { fixtureCommand, tempDir } from "./helpers.ts";

const profile = (home: string, mcp: Record<string, unknown>) =>
  writeFileSync(join(home, "mcp.json"), JSON.stringify({ mcp }));
const fixture = (extra: Record<string, unknown> = {}) => ({
  command: fixtureCommand(),
  startup_timeout_ms: 5000,
  ...extra,
});
const deps = (home: string, extra: Partial<McpRuntimeDeps> = {}): McpRuntimeDeps => ({
  home,
  workspaceRoot: tempDir("nod-ws-"),
  env: process.env,
  openUrl() {},
  interactive: false,
  retryDelayMs: 10,
  graceMs: 50,
  ...extra,
});
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

// One fake server that needs a bearer token and hosts its own authorization server.
const auth = { inits: 0, tokens: 0 };
const authServer = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const origin = url.origin;
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
      return Response.json({ authorization_servers: [origin] });
    if (url.pathname === "/.well-known/oauth-authorization-server")
      return Response.json({
        issuer: origin,
        authorization_endpoint: `${origin}/authorize`,
        token_endpoint: `${origin}/token`,
        registration_endpoint: `${origin}/register`,
      });
    if (url.pathname === "/register") return Response.json({ client_id: "c1" });
    if (url.pathname === "/token") {
      auth.tokens++;
      return Response.json({ access_token: "tok", expires_in: 3600 });
    }
    if (url.pathname === "/mcp") {
      if (req.headers.get("authorization") !== "Bearer tok")
        return new Response("", {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource/mcp"`,
          },
        });
      const m = (await req.json()) as { id?: number; method: string };
      if (m.method === "initialize") {
        auth.inits++;
        return Response.json({
          jsonrpc: "2.0",
          id: m.id,
          result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "auth", version: "1" } },
        });
      }
      if (m.id === undefined) return new Response(null, { status: 202 });
      if (m.method === "tools/list")
        return Response.json({
          jsonrpc: "2.0",
          id: m.id,
          result: { tools: [{ name: "secure", description: "needs auth", inputSchema: { type: "object" } }] },
        });
      return Response.json({
        jsonrpc: "2.0",
        id: m.id,
        result: { content: [{ type: "text", text: "secret-result" }] },
      });
    }
    return new Response("nope", { status: 404 });
  },
});
afterAll(() => authServer.stop(true));
const authUrl = `http://127.0.0.1:${authServer.port}/mcp`;

describe("mcp runtime", () => {
  test("starts profile servers and serves search, select, tools, call, and features", async () => {
    const home = tempDir();
    profile(home, { fix: fixture({ environment: { SECRET: "hunter2" } }) });
    const rt = createMcpRuntime(deps(home, { reservedNames: ["mcp_fix_echo"] }));
    await rt.start();
    await rt.settle();
    const [h] = rt.health();
    expect(h).toMatchObject({
      name: "fix",
      state: "ready",
      transport: "stdio",
      source: "profile",
      protocolVersion: "2025-11-25",
      counts: { tools: 1 },
      restarts: 0,
    });
    expect(JSON.stringify(rt.health())).not.toContain("hunter2");
    expect(rt.serverNames()).toEqual(["fix"]);
    expect(rt.tools()).toEqual([]);

    const search = await rt.search("echo text");
    expect(search.selected).toEqual(["mcp_fix_echo_2"]);
    expect(JSON.parse(search.text).tools[0]).toEqual({
      name: "mcp_fix_echo_2",
      server: "fix",
      description: "Echo text back",
    });
    expect(await rt.search("x", "nope")).toEqual({
      text: JSON.stringify({
        tools: [],
        count: 0,
        total_matches: 0,
        more_available: false,
        next_cursor: null,
        state: "server_not_found",
      }),
      selected: [],
    });
    const [spec] = rt.tools();
    expect(spec?.name).toBe("mcp_fix_echo_2");
    expect(spec?.description).toBe("Echo text back\n\nServer instructions: Fixture instructions");
    expect(spec?.requiresApproval).toBe(true);
    expect(spec?.targets?.({}, {} as never)).toEqual([{ permission: "mcp_fix_echo_2", target: "*", kind: "other" }]);
    expect(spec?.decode([], {} as never)).toEqual({
      ok: false,
      failure: "mcp_fix_echo_2 arguments must be a JSON object",
    });

    const selected = await rt.select("mcp_fix_echo_2");
    expect(selected).toEqual({
      ok: true,
      text: JSON.stringify({
        name: "mcp_fix_echo_2",
        description: "Echo text back\n\nServer instructions: Fixture instructions",
        inputSchema: { type: "object", properties: { text: { type: "string" } } },
      }),
    });
    expect(await rt.select("mcp_fix_missing")).toEqual({ ok: false, error: "Unknown MCP tool: mcp_fix_missing" });

    expect(await rt.call("mcp_fix_echo_2", { text: "hi" })).toEqual({ status: "success", output: "echo:hi" });
    const stale = await rt.call("mcp_fix_nothing", {});
    expect(JSON.parse(stale.output).error.message).toBe("tool no longer available");
    const features = await rt.features({ action: "resource_list", server: "fix" });
    expect(features.status).toBe("failure");
    expect(JSON.parse(features.output).error.message).toContain("Method not found");
    expect(JSON.parse((await rt.features({ action: "resource_list", server: "zzz" })).output).error.message).toBe(
      "Unknown MCP server: zzz",
    );
    await rt.close();
  });

  test("reload keeps the old set when a required server fails, then swaps on success", async () => {
    const home = tempDir();
    profile(home, { fix: fixture() });
    const rt = createMcpRuntime(deps(home));
    await rt.start();
    await rt.settle();
    profile(home, {
      fix: fixture(),
      broken: { command: [process.execPath, "-e", "process.exit(1)"], required: true, startup_timeout_ms: 2000 },
    });
    const failed = await rt.reload();
    expect(failed.ok).toBe(false);
    expect(failed.diagnostics[0]).toContain("required MCP server 'broken' failed");
    expect(rt.health().map((h) => [h.name, h.state])).toEqual([["fix", "ready"]]);
    profile(home, { fix2: fixture(), off: fixture({ enabled: false }) });
    expect((await rt.reload()).ok).toBe(true);
    expect(rt.health().map((h) => [h.name, h.state])).toEqual([
      ["fix2", "ready"],
      ["off", "disabled"],
    ]);
    profile(home, {});
    expect((await rt.reload()).ok).toBe(true);
    expect(rt.health()).toEqual([]);
    await rt.close();
  });

  test("restarts a crashed stdio server up to restart_limit, then reports the limit", async () => {
    const home = tempDir();
    profile(home, { crash: fixture({ environment: { MCP_FIXTURE_CRASH_ON_CALL: "1" } }) });
    const rt = createMcpRuntime(deps(home));
    await rt.start();
    await rt.settle();
    await rt.search("echo");
    const first = await rt.call("mcp_crash_echo", {});
    expect(first.status).toBe("failure");
    await wait(300);
    expect(rt.health()[0]).toMatchObject({ state: "ready", restarts: 1 });
    await rt.call("mcp_crash_echo", {});
    await wait(50);
    expect(rt.health()[0]).toMatchObject({ state: "failed", failure: "MCP restart limit reached", restarts: 1 });
    await rt.close();
  });

  test("project servers stay pending until approved; failures never leak urls", async () => {
    const home = tempDir();
    const workspaceRoot = tempDir("nod-ws-");
    writeFileSync(
      join(workspaceRoot, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          proj: { command: process.execPath, args: [fixtureCommand()[1]] },
          dead: { type: "http", url: "http://127.0.0.1:1/private-path" },
        },
      }),
    );
    profile(home, {});
    const rt = createMcpRuntime(deps(home, { workspaceRoot }));
    await rt.start();
    await rt.settle();
    expect(rt.health().map((h) => [h.name, h.state, h.admission])).toEqual([
      ["proj", "pending", "pending"],
      ["dead", "pending", "pending"],
    ]);
    applyTrust(home, workspaceRoot, "approve-all");
    await rt.reload();
    const dead = rt.health().find((h) => h.name === "dead");
    expect(dead?.state).toBe("failed");
    expect(JSON.stringify(rt.health())).not.toContain("private-path");
    expect(rt.health().find((h) => h.name === "proj")?.state).toBe("ready");
    await rt.close();
  });

  test("401 without interaction is unauthenticated; interactive sessions run OAuth and retry", async () => {
    const home = tempDir();
    profile(home, { auth: { type: "http", url: authUrl } });
    const quiet = createMcpRuntime(deps(home));
    await quiet.start();
    await quiet.settle();
    expect(quiet.health()[0]).toMatchObject({ state: "unauthenticated", failure: "authentication required" });
    const need = JSON.parse((await quiet.search("use the auth server")).text);
    expect(need.authentication_required).toEqual({
      server: "auth",
      interactive: true,
      message: "Run /mcp auth auth --open in an interactive nod session.",
    });
    await quiet.close();

    const rt = createMcpRuntime(
      deps(home, {
        interactive: true,
        openUrl: (url) => {
          const u = new URL(url);
          const redirect = new URL(u.searchParams.get("redirect_uri") ?? "");
          redirect.searchParams.set("state", u.searchParams.get("state") ?? "");
          redirect.searchParams.set("code", "c");
          void fetch(redirect);
        },
      }),
    );
    await rt.start();
    await rt.settle();
    expect(rt.health()[0]).toMatchObject({ state: "ready", protocolVersion: "2025-06-18", counts: { tools: 1 } });
    expect(auth.tokens).toBe(1);
    expect(statSync(join(home, "mcp-credentials.json")).mode & 0o777).toBe(0o600);
    expect(JSON.parse(readFileSync(join(home, "mcp-credentials.json"), "utf8")).auth.access_token).toBe("tok");
    await rt.search("secure");
    expect(await rt.call("mcp_auth_secure", {})).toEqual({ status: "success", output: "secret-result" });
    await rt.close();
    const again = createMcpRuntime(deps(home));
    await again.start();
    await again.settle();
    expect(again.health()[0]?.state).toBe("ready");
    expect(auth.tokens).toBe(1);
    await again.close();
  });
});
