import { describe, expect, test } from "bun:test";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  loadProfile,
  mergeServers,
  normalizeServer,
  profilePath,
  removeProfileServer,
  saveProfileServer,
} from "../../src/core/mcp/config.ts";
import { tempDir } from "./helpers.ts";

const write = (home: string, json: unknown) => writeFileSync(join(home, "mcp.json"), JSON.stringify(json));

describe("mcp profile", () => {
  test("mcp wins over the mcpServers alias and the alias is reported", () => {
    const home = tempDir();
    write(home, { mcp: { a: { command: "x" } }, mcpServers: { b: { command: "y" } } });
    const doc = loadProfile(home);
    expect(doc.servers.map((s) => s.name)).toEqual(["a"]);
    expect(doc.warning).toEqual({ cause: "ignored_mcp_servers_alias", key: "mcpServers", additionalMatches: 0 });
    write(home, { mcpServers: { b: { command: "y" } } });
    expect(loadProfile(home).servers[0]?.name).toBe("b");
    expect(loadProfile(tempDir()).servers).toEqual([]);
  });

  test("normalizes the compatibility shapes", () => {
    const s = normalizeServer("fs", { command: "node", args: ["s.js", "--ro"], env: { A: "1" } }, "profile");
    expect(s.type).toBe("stdio");
    expect(s.command).toEqual(["node", "s.js", "--ro"]);
    expect(s.environment).toEqual({ A: "1" });
    expect([s.enabled, s.required, s.startup_timeout_ms, s.operation_timeout_ms, s.restart_limit]).toEqual([
      true,
      false,
      30000,
      60000,
      1,
    ]);
    const local = normalizeServer(
      "l",
      { type: "local", command: ["a"], environment: { X: "y" }, env: { X: "z" } },
      "profile",
    );
    expect(local.environment).toEqual({ X: "y" });
    expect(normalizeServer("r", { url: "https://h/mcp" }, "profile").type).toBe("http");
    expect(normalizeServer("r", { type: "sse", url: "https://h/sse", required: true }, "profile").required).toBe(true);
    expect(normalizeServer("p", { url: "https://h", required: true }, "project").required).toBe(false);
    expect(() => normalizeServer("bad name", { command: "x" }, "profile")).toThrow("letters, numbers, _, or -");
    expect(() => normalizeServer("x", { command: "a", env: { A: 1 } }, "profile")).toThrow(
      "environment.A must be a string",
    );
    expect(() => normalizeServer("x", { command: "a", startup_timeout_ms: 0 }, "profile")).toThrow("positive integer");
    expect(() => normalizeServer("x", { type: "ftp", url: "https://h" }, "profile")).toThrow(
      "stdio, local, http, or sse",
    );
    expect(() => normalizeServer("x", { type: "http" }, "profile")).toThrow("requires a url");
    expect(() => normalizeServer("x", {}, "profile")).toThrow("requires a command");
  });

  test("rejects literal Authorization headers and insecure URLs", () => {
    expect(() => normalizeServer("x", { url: "https://h", headers: { Authorization: "Bearer t" } }, "profile")).toThrow(
      "literal Authorization header",
    );
    expect(() => normalizeServer("x", { url: "https://h", headers: { authorization: "t" } }, "profile")).toThrow();
    expect(
      normalizeServer("x", { url: "https://h", headers: { Authorization: "Bearer ${T}" } }, "project").headers,
    ).toEqual({
      Authorization: "Bearer ${T}",
    });
    expect(() => normalizeServer("x", { url: "http://example.com/mcp" }, "profile")).toThrow("explicit port");
    expect(() => normalizeServer("x", { url: "http://localhost/mcp" }, "profile")).toThrow("explicit port");
    expect(() => normalizeServer("x", { url: "https://u@h/mcp" }, "profile")).toThrow("credentials");
    expect(() => normalizeServer("x", { url: "https://h/mcp#f" }, "profile")).toThrow("fragment");
    expect(() => normalizeServer("x", { url: "nope" }, "profile")).toThrow("valid URL");
    for (const url of ["http://localhost:4321/mcp", "http://127.0.0.1:1/x", "http://[::1]:8080/mcp", "https://h/x?y=1"])
      expect(normalizeServer("x", { url }, "profile").url).toBe(url);
    const remote = normalizeServer(
      "x",
      {
        url: "https://h",
        header_env: { "X-W": "W" },
        bearer_token_env: "TOK",
        oauth: { scopes: ["a"], client_id: "c" },
      },
      "profile",
    );
    expect(remote.header_env).toEqual({ "X-W": "W" });
    expect(remote.bearer_token_env).toBe("TOK");
    expect(remote.oauth).toEqual({ scopes: ["a"], client_id: "c" });
    expect(() => normalizeServer("x", { url: "https://h", oauth: { scopes: "a" } }, "profile")).toThrow("oauth.scopes");
  });

  test("ambiguous keys warn and block mutations", () => {
    const home = tempDir();
    write(home, { "MCP-Servers": { a: { command: "x" } } });
    const doc = loadProfile(home);
    expect(doc.warning).toEqual({ cause: "suspicious_server_key", key: "MCP-Servers", additionalMatches: 0 });
    expect(doc.servers).toEqual([]);
    expect(() => saveProfileServer(home, { name: "n", command: ["x"] })).toThrow("profile mutations are blocked");
    expect(readFileSync(join(home, "mcp.json"), "utf8")).toContain("MCP-Servers");
  });

  test("add, remove, migration of the alias, and file mode", () => {
    const home = tempDir();
    write(home, { mcpServers: { old: { command: "o" } }, other: 1 });
    expect(saveProfileServer(home, { name: "local-tools", command: ["npx", "-y", "srv"] })).toBeUndefined();
    const raw = JSON.parse(readFileSync(profilePath(home), "utf8"));
    expect(raw).toEqual({
      other: 1,
      mcp: { old: { command: "o" }, "local-tools": { type: "local", command: ["npx", "-y", "srv"] } },
    });
    expect(statSync(profilePath(home)).mode & 0o777).toBe(0o600);
    saveProfileServer(home, { name: "remote", url: "https://mcp.example.com/mcp" });
    expect(loadProfile(home).servers.map((s) => s.name)).toEqual(["old", "local-tools", "remote"]);
    expect(() => saveProfileServer(home, { name: "r2", url: "http://example.com" })).toThrow();
    expect(() => saveProfileServer(home, { name: "bad name", command: ["x"] })).toThrow();
    expect(removeProfileServer(home, "old")).toBe(true);
    expect(removeProfileServer(home, "old")).toBe(false);
    expect(loadProfile(home).servers.map((s) => s.name)).toEqual(["local-tools", "remote"]);
    write(home, "[]");
    expect(loadProfile(home).error).toBe("root must be an object");
    writeFileSync(join(home, "mcp.json"), "{bad");
    expect(loadProfile(home).error).toContain("invalid JSON");
    expect(() => saveProfileServer(home, { name: "n", command: ["x"] })).toThrow("cannot update");
  });

  test("per-entry issues keep the rest and profile wins on merge", () => {
    const home = tempDir();
    write(home, { mcp: { good: { command: "x" }, bad: { url: "http://example.com" } } });
    const doc = loadProfile(home);
    expect(doc.servers.map((s) => s.name)).toEqual(["good"]);
    expect(doc.issues[0]).toContain("MCP server 'bad' url");
    const merged = mergeServers(doc.servers, [
      normalizeServer("good", { url: "https://h" }, "project"),
      normalizeServer("p", { url: "https://h" }, "project"),
    ]);
    expect(merged.map((s) => `${s.name}:${s.source}`)).toEqual(["good:profile", "p:project"]);
  });
});
