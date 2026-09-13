import { describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyTrust, expandTemplate, loadProjectServers, readTrust } from "../../src/core/mcp/project.ts";
import { tempDir } from "./helpers.ts";

const setup = (json: unknown) => {
  const home = tempDir();
  const ws = tempDir("nod-ws-");
  writeFileSync(join(ws, ".mcp.json"), typeof json === "string" ? json : JSON.stringify(json));
  return { home, ws };
};
const file = {
  mcpServers: {
    local: { command: "npx", args: ["-y", "srv", "${PROJECT_ROOT:-.}"], env: { TOKEN: "${PROJECT_TOKEN}" } },
    remote: { type: "http", url: "https://mcp.example.com/mcp", headers: { "X-W": "${WORKSPACE_ID}" } },
  },
};

describe("project .mcp.json", () => {
  test("everything starts pending and nothing is expanded before approval", () => {
    const { home, ws } = setup(file);
    const load = loadProjectServers({ home, workspaceRoot: ws, env: {} });
    expect(load.pending).toEqual(["local", "remote"]);
    expect(load.issues).toEqual([]);
    expect(load.servers.map((s) => [s.name, s.admission, s.source, s.required])).toEqual([
      ["local", "pending", "project", false],
      ["remote", "pending", "project", false],
    ]);
    expect(load.servers[0]?.environment).toEqual({ TOKEN: "${PROJECT_TOKEN}" });
    expect(loadProjectServers({ home, workspaceRoot: tempDir(), env: {} })).toEqual({
      servers: [],
      issues: [],
      pending: [],
    });
  });

  test("trust choices live in settings.workspaces[root] and drive admission", () => {
    const { home, ws } = setup(file);
    applyTrust(home, ws, "approve", "local");
    applyTrust(home, ws, "reject", "remote");
    const saved = JSON.parse(readFileSync(join(home, "settings.json"), "utf8"));
    expect(saved.workspaces[ws]).toEqual({ enabled_servers: ["local"], disabled_servers: ["remote"] });
    const env = { PROJECT_TOKEN: "secret", WORKSPACE_ID: "w1" };
    let load = loadProjectServers({ home, workspaceRoot: ws, env });
    expect(load.servers.map((s) => [s.name, s.admission])).toEqual([
      ["local", "approved"],
      ["remote", "rejected"],
    ]);
    expect(load.servers[0]?.command).toEqual(["npx", "-y", "srv", "."]);
    expect(load.servers[0]?.environment).toEqual({ TOKEN: "secret" });
    expect(load.servers[1]?.headers).toEqual({ "X-W": "${WORKSPACE_ID}" });
    applyTrust(home, ws, "approve", "remote");
    expect(readTrust(home, ws)).toEqual({ enabled: ["local", "remote"], disabled: [], all: false });
    load = loadProjectServers({ home, workspaceRoot: ws, env });
    expect(load.servers[1]?.headers).toEqual({ "X-W": "w1" });
    applyTrust(home, ws, "reset");
    expect(readTrust(home, ws)).toEqual({ enabled: [], disabled: [], all: false });
    expect(JSON.parse(readFileSync(join(home, "settings.json"), "utf8")).workspaces).toEqual({});
    applyTrust(home, ws, "approve-all");
    expect(readTrust(home, ws).all).toBe(true);
    expect(loadProjectServers({ home, workspaceRoot: ws, env }).servers.every((s) => s.admission === "approved")).toBe(
      true,
    );
    expect(() => applyTrust(home, ws, "approve")).toThrow("requires a server name");
  });

  test("missing variables produce the exact diagnostic and skip only that server", () => {
    const { home, ws } = setup(file);
    applyTrust(home, ws, "approve-all");
    const load = loadProjectServers({ home, workspaceRoot: ws, env: { WORKSPACE_ID: "w" } });
    expect(load.issues).toEqual([
      ".mcp.json server 'local' field env.TOKEN requires environment variable 'PROJECT_TOKEN'; set it or use ${PROJECT_TOKEN:-default}.",
    ]);
    expect(load.servers.map((s) => s.name)).toEqual(["remote"]);
    expect(JSON.stringify(load)).not.toContain("secret");
    expect(expandTemplate("a${X}b${Y:-d}${Z:-}", { X: "1" })).toEqual({ ok: true, value: "a1bd" });
    expect(expandTemplate("$X ${1X} ${Y", {})).toEqual({ ok: true, value: "$X ${1X} ${Y" });
    expect(expandTemplate("${MISSING}", {})).toEqual({ ok: false, missing: "MISSING" });
  });

  test("caps, shapes, overlaps, and non-regular files", () => {
    const big = setup({ mcpServers: { a: { command: "x", args: ["${BIG}"] } } });
    applyTrust(big.home, big.ws, "approve-all");
    const oversized = loadProjectServers({
      home: big.home,
      workspaceRoot: big.ws,
      env: { BIG: "x".repeat(1024 * 1024 + 1) },
    });
    expect(oversized.issues).toEqual([".mcp.json server 'a' was skipped: environment_expansion_limit_exceeded."]);
    const huge = setup(`{"mcpServers":{},"pad":"${"x".repeat(1024 * 1024)}"}`);
    expect(loadProjectServers({ home: huge.home, workspaceRoot: huge.ws, env: {} }).issues).toEqual([
      ".mcp.json was skipped: file exceeds 1 MiB.",
    ]);
    const broken = setup("{nope");
    expect(loadProjectServers({ home: broken.home, workspaceRoot: broken.ws, env: {} }).issues).toEqual([
      ".mcp.json was skipped: invalid_json.",
    ]);
    const arr = setup([]);
    expect(loadProjectServers({ home: arr.home, workspaceRoot: arr.ws, env: {} }).issues).toEqual([
      ".mcp.json was skipped: root_must_be_object.",
    ]);
    const bad = setup({ mcpServers: { ok: { command: "x" }, "bad name": { command: "x" }, nourl: { type: "http" } } });
    const load = loadProjectServers({ home: bad.home, workspaceRoot: bad.ws, env: {} });
    expect(load.servers.map((s) => s.name)).toEqual(["ok"]);
    expect(load.issues.map((i) => i.split(" (")[0])).toEqual([
      ".mcp.json server 'bad name' was skipped: invalid_entry",
      ".mcp.json server 'nourl' was skipped: invalid_entry",
    ]);
    writeFileSync(
      join(bad.home, "settings.json"),
      JSON.stringify({ workspaces: { [bad.ws]: { enabled_servers: ["ok"], disabled_servers: ["ok"] } } }),
    );
    const overlap = loadProjectServers({ home: bad.home, workspaceRoot: bad.ws, env: {} });
    expect(overlap.issues[0]).toBe(".mcp.json server 'ok' was skipped: approved_rejected_overlap.");
    expect(overlap.servers[0]?.admission).toBe("pending");
    const link = tempDir("nod-ws-");
    mkdirSync(join(link, "real"));
    writeFileSync(join(link, "real", "cfg.json"), "{}");
    symlinkSync(join(link, "real", "cfg.json"), join(link, ".mcp.json"));
    expect(loadProjectServers({ home: tempDir(), workspaceRoot: link, env: {} }).issues).toEqual([
      ".mcp.json was skipped: not a regular file.",
    ]);
  });
});
