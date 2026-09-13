import { afterAll, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  authorize,
  credentialsPath,
  discoverAuthorizationServer,
  needsRefresh,
  parseWwwAuthenticate,
  readCredentials,
  refreshCredentials,
  revokeCredentials,
  storeCredentials,
} from "../../src/core/mcp/oauth.ts";
import { httpConfig, tempDir } from "./helpers.ts";

const hits: string[] = [];
const state = { registered: 0, tokens: 0, lastToken: {} as Record<string, string>, challenge: "", revoked: 0 };
const server = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    hits.push(url.pathname);
    const origin = url.origin;
    if (url.pathname === "/.well-known/oauth-protected-resource/mcp")
      return Response.json({
        resource: `${origin}/mcp`,
        authorization_servers: [`${origin}/as`],
        scopes_supported: ["res.read"],
      });
    if (url.pathname === "/.well-known/oauth-authorization-server/as")
      return Response.json({
        issuer: `${origin}/as`,
        authorization_endpoint: `${origin}/as/authorize`,
        token_endpoint: `${origin}/as/token`,
        registration_endpoint: `${origin}/as/register`,
        revocation_endpoint: `${origin}/as/revoke`,
        scopes_supported: ["as.scope"],
        code_challenge_methods_supported: ["S256"],
      });
    if (url.pathname === "/.well-known/oauth-authorization-server/wrong")
      return Response.json({ issuer: `${origin}/other`, authorization_endpoint: "x", token_endpoint: "y" });
    if (url.pathname === "/.well-known/oauth-authorization-server/plain")
      return Response.json({
        issuer: `${origin}/plain`,
        authorization_endpoint: "x",
        token_endpoint: "y",
        code_challenge_methods_supported: ["plain"],
      });
    if (url.pathname === "/bare/.well-known/openid-configuration")
      return Response.json({
        issuer: `${origin}/bare`,
        authorization_endpoint: `${origin}/a`,
        token_endpoint: `${origin}/t`,
        client_id_metadata_document_supported: true,
      });
    if (url.pathname === "/as/register") {
      state.registered++;
      const body = (await req.json()) as Record<string, unknown>;
      expect(body.client_name).toBe("nod");
      expect(body.token_endpoint_auth_method).toBe("none");
      expect((body.redirect_uris as string[])[0]).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/callback$/);
      return Response.json({ client_id: "dyn-client" }, { status: 201 });
    }
    if (url.pathname === "/as/token") {
      state.tokens++;
      const form = Object.fromEntries(new URLSearchParams(await req.text()));
      state.lastToken = form;
      if (form.grant_type === "authorization_code") {
        const expected = createHash("sha256")
          .update(form.code_verifier ?? "")
          .digest("base64url");
        if (expected !== state.challenge || form.code !== "the-code")
          return Response.json({ error: "invalid_grant" }, { status: 400 });
        return Response.json({ access_token: "at1", refresh_token: "rt1", expires_in: 3600, scope: "granted" });
      }
      if (form.grant_type === "refresh_token" && form.refresh_token === "rt1")
        return Response.json({ access_token: "at2", expires_in: 10 });
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    }
    if (url.pathname === "/as/revoke") {
      state.revoked++;
      return new Response(null, { status: 200 });
    }
    return new Response("nope", { status: 404 });
  },
});
afterAll(() => server.stop(true));
const origin = `http://127.0.0.1:${server.port}`;

describe("mcp oauth", () => {
  test("parses WWW-Authenticate challenges", () => {
    expect(
      parseWwwAuthenticate('Bearer resource_metadata="https://r/.well-known/x", scope="a b", error="invalid_token"'),
    ).toEqual({
      resource_metadata: "https://r/.well-known/x",
      scope: "a b",
      error: "invalid_token",
    });
    expect(parseWwwAuthenticate("Bearer error=insufficient_scope")).toEqual({ error: "insufficient_scope" });
    expect(parseWwwAuthenticate(null)).toEqual({});
  });

  test("discovers metadata in order, validates the issuer, and requires S256", async () => {
    hits.length = 0;
    const as = await discoverAuthorizationServer(fetch, `${origin}/as`);
    expect(hits).toEqual(["/.well-known/oauth-authorization-server/as"]);
    expect(as.token_endpoint).toBe(`${origin}/as/token`);
    await expect(discoverAuthorizationServer(fetch, `${origin}/wrong`)).rejects.toThrow("issuer mismatch");
    await expect(discoverAuthorizationServer(fetch, `${origin}/plain`)).rejects.toThrow("S256");
    hits.length = 0;
    const bare = await discoverAuthorizationServer(fetch, `${origin}/bare`);
    expect(hits).toEqual([
      "/.well-known/oauth-authorization-server/bare",
      "/.well-known/openid-configuration/bare",
      "/bare/.well-known/openid-configuration",
    ]);
    expect(bare.client_id_metadata_document_supported).toBe(true);
    await expect(discoverAuthorizationServer(fetch, `${origin}/missing`)).rejects.toThrow("metadata not found");
  });

  test("runs DCR + PKCE + state through the loopback callback and stores tokens with mode 0600", async () => {
    const home = tempDir();
    hits.length = 0;
    let opened = "";
    const cfg = httpConfig("remote", `${origin}/mcp`, { oauth: { scopes: ["cfg.scope"] } });
    const creds = await authorize(
      cfg,
      { scope: "chal.scope" },
      {
        fetch,
        env: {},
        now: () => 1_000_000,
        timeoutMs: 5000,
        openUrl: (url) => {
          opened = url;
          const u = new URL(url);
          state.challenge = u.searchParams.get("code_challenge") ?? "";
          const redirect = new URL(u.searchParams.get("redirect_uri") ?? "");
          redirect.searchParams.set("state", "wrong");
          redirect.searchParams.set("code", "bad");
          void fetch(redirect).then((r) => {
            expect(r.status).toBe(404);
            redirect.searchParams.set("state", u.searchParams.get("state") ?? "");
            redirect.searchParams.set("code", "the-code");
            void fetch(redirect);
          });
        },
      },
    );
    expect(hits.slice(0, 3)).toEqual([
      "/.well-known/oauth-protected-resource/mcp",
      "/.well-known/oauth-authorization-server/as",
      "/as/register",
    ]);
    const u = new URL(opened);
    expect(u.origin + u.pathname).toBe(`${origin}/as/authorize`);
    expect(u.searchParams.get("client_id")).toBe("dyn-client");
    expect(u.searchParams.get("code_challenge_method")).toBe("S256");
    expect(u.searchParams.get("response_type")).toBe("code");
    expect(u.searchParams.get("resource")).toBe(`${origin}/mcp`);
    expect(u.searchParams.get("scope")?.split(" ").sort()).toEqual(["as.scope", "cfg.scope", "chal.scope", "res.read"]);
    expect(state.lastToken.resource).toBe(`${origin}/mcp`);
    expect(state.lastToken.client_id).toBe("dyn-client");
    expect(creds).toMatchObject({
      access_token: "at1",
      refresh_token: "rt1",
      expires_at_ms: 1_000_000 + 3_600_000,
      scope: "granted",
      issuer: `${origin}/as`,
      client_id: "dyn-client",
      resource: `${origin}/mcp`,
    });
    storeCredentials(home, "remote", creds);
    expect(statSync(credentialsPath(home)).mode & 0o777).toBe(0o600);
    expect(readCredentials(home).entries.remote?.access_token).toBe("at1");

    expect(needsRefresh(creds, 1_000_000 + 3_600_000 - 60_001)).toBe(false);
    expect(needsRefresh(creds, 1_000_000 + 3_600_000 - 60_000)).toBe(true);
    const refreshed = await refreshCredentials(creds, cfg, { fetch, env: {}, now: () => 5, openUrl() {} });
    expect(refreshed).toMatchObject({
      access_token: "at2",
      refresh_token: "rt1",
      expires_at_ms: 10_005,
      scope: "granted",
    });
    await expect(
      refreshCredentials({ ...creds, refresh_token: undefined }, cfg, { fetch, env: {}, now: () => 5, openUrl() {} }),
    ).rejects.toThrow("cannot be refreshed");
    expect(await revokeCredentials(creds, { fetch })).toBe(true);
    expect(state.revoked).toBe(1);
    expect(await revokeCredentials({ ...creds, revocation_endpoint: undefined }, { fetch })).toBe(false);
  });

  test("uses a configured client id and secret env without registration", async () => {
    const before = state.registered;
    const cfg = httpConfig("r2", `${origin}/mcp`, { oauth: { client_id: "fixed", client_secret_env: "SECRET" } });
    const creds = await authorize(
      cfg,
      {},
      {
        fetch,
        env: { SECRET: "s3" },
        now: () => 0,
        openUrl: (url) => {
          const u = new URL(url);
          state.challenge = u.searchParams.get("code_challenge") ?? "";
          const redirect = new URL(u.searchParams.get("redirect_uri") ?? "");
          redirect.searchParams.set("state", u.searchParams.get("state") ?? "");
          redirect.searchParams.set("code", "the-code");
          void fetch(redirect);
        },
      },
    );
    expect(state.registered).toBe(before);
    expect(creds.client_id).toBe("fixed");
    expect(state.lastToken.client_secret).toBe("s3");
  });

  test("malformed credential entries are ignored and purged on the next write", () => {
    const home = tempDir();
    writeFileSync(
      join(home, "mcp-credentials.json"),
      JSON.stringify({
        good: { access_token: "a", issuer: "i", client_id: "c", resource: "r", token_endpoint: "t" },
        bad: { nope: 1 },
        worse: "x",
      }),
    );
    const read = readCredentials(home);
    expect(Object.keys(read.entries)).toEqual(["good"]);
    expect(read.malformed).toEqual(["bad", "worse"]);
    expect(storeCredentials(home, "good", undefined)).toBe(2);
    expect(JSON.parse(readFileSync(join(home, "mcp-credentials.json"), "utf8"))).toEqual({});
    writeFileSync(join(home, "mcp-credentials.json"), "not json");
    expect(readCredentials(home)).toEqual({ entries: {}, malformed: [] });
  });
});
