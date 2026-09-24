import { afterEach, beforeEach, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as chatgpt from "../../src/providers/auth/chatgpt.ts";
import * as grok from "../../src/providers/auth/grok.ts";
import { listenForCallback, pkce } from "../../src/providers/auth/oauth.ts";
import {
  credentials,
  loadSession,
  RefreshRejected,
  type Session,
  saveSession,
  sessionPath,
} from "../../src/providers/auth/store.ts";

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "nod-auth-"));
  process.env.NOD_HOME = join(home, ".nod");
});
afterEach(() => {
  delete process.env.NOD_HOME;
  rmSync(home, { recursive: true, force: true });
});

const jwt = (claims: object) => `h.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.s`;
const chatgptToken = (account: string) =>
  jwt({ "https://api.openai.com/auth": { chatgpt_account_id: account }, exp: 2_000_000_000 });
const session = (over: Partial<Session> = {}): Session => ({
  version: 1,
  access_token: "a",
  refresh_token: "r",
  expires_at_ms: Date.now() + 3_600_000,
  account_id: "acct",
  ...over,
});

type Captured = { url: string; init?: RequestInit };
function fakeFetch(respond: (req: Captured) => Response) {
  const requests: Captured[] = [];
  const fetcher = (async (url: RequestInfo | URL, init?: RequestInit) => {
    const req = { url: String(url), init };
    requests.push(req);
    return respond(req);
  }) as typeof fetch;
  return { fetcher, requests };
}

test("pkce challenge is the base64url SHA-256 of the verifier", async () => {
  const { verifier, challenge, state } = await pkce();
  expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(state).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(challenge).toBe(new Bun.CryptoHasher("sha256").update(verifier).digest("base64url"));
});

test("callback ignores other paths and states, then resolves the code", async () => {
  const cb = listenForCallback({ ports: [0], path: "/callback", state: "s1", redirectHost: "127.0.0.1" });
  try {
    expect((await fetch(`${cb.redirectUri.replace("/callback", "/other")}?state=s1&code=x`)).status).toBe(404);
    expect((await fetch(`${cb.redirectUri}?state=wrong&code=x`)).status).toBe(404);
    expect((await fetch(`${cb.redirectUri}?state=s1&code=good`)).status).toBe(200);
    expect(await cb.code).toBe("good");
  } finally {
    cb.stop();
  }
});

test("callback rejects an error with the matching state", async () => {
  const cb = listenForCallback({ ports: [0], path: "/callback", state: "s1", redirectHost: "127.0.0.1" });
  try {
    await fetch(`${cb.redirectUri}?state=s1&error=access_denied`);
    expect(cb.code).rejects.toThrow("access_denied");
  } finally {
    cb.stop();
  }
});

test("sessions are saved 0600 and insecure files are refused", () => {
  saveSession("codex", session());
  expect(statSync(sessionPath("codex")).mode & 0o777).toBe(0o600);
  expect(loadSession("codex")).toEqual(session({ expires_at_ms: loadSession("codex")!.expires_at_ms }));
  chmodSync(sessionPath("codex"), 0o644);
  expect(() => loadSession("codex")).toThrow("chmod 600");
});

test("credentials refresh near expiry, share one refresh, and reject a different account", async () => {
  saveSession("codex", session({ expires_at_ms: Date.now() + 10_000 }));
  let calls = 0;
  const source = credentials(
    "codex",
    async (s) => (calls++, { ...s, access_token: "new", expires_at_ms: Date.now() + 3_600_000 }),
  );
  const [a, b] = await Promise.all([source("if_needed"), source("if_needed")]);
  expect(a).toEqual({ token: "new", accountId: "acct" });
  expect(b.token).toBe("new");
  expect(calls).toBe(1);
  expect((await source("if_needed")).token).toBe("new");
  expect(calls).toBe(1);

  const other = credentials("codex", async (s) => ({ ...s, account_id: "someone-else" }));
  expect(other("force")).rejects.toThrow("different account");
});

test("a rejected refresh deletes the session", async () => {
  saveSession("codex", session());
  const source = credentials("codex", async () => {
    throw new RefreshRejected("gone");
  });
  expect(source("force")).rejects.toThrow("nod login codex");
  await Bun.sleep(0);
  expect(loadSession("codex")).toBeUndefined();
});

test("chatgpt: account id comes from the JWT; refresh posts JSON; terminal errors reject", async () => {
  expect(chatgpt.accountIdFromJwt(chatgptToken("acct-1"))).toBe("acct-1");
  expect(() => chatgpt.accountIdFromJwt(jwt({}))).toThrow("no account id");

  const ok = fakeFetch(() => Response.json({ access_token: chatgptToken("acct-1"), expires_in: 3600 }));
  const next = await chatgpt.refresh(session({ account_id: "acct-1" }), ok.fetcher);
  expect(next).toMatchObject({ account_id: "acct-1", refresh_token: "r" });
  expect(ok.requests[0]!.url).toBe("https://auth.openai.com/oauth/token");
  expect(new Headers(ok.requests[0]!.init!.headers).get("content-type")).toBe("application/json");
  expect(JSON.parse(ok.requests[0]!.init!.body as string)).toEqual({
    client_id: chatgpt.CLIENT_ID,
    grant_type: "refresh_token",
    refresh_token: "r",
  });

  const bad = fakeFetch(() => Response.json({ error: "refresh_token_reused" }, { status: 400 }));
  expect(chatgpt.refresh(session(), bad.fetcher)).rejects.toBeInstanceOf(RefreshRejected);
});

test("chatgpt login exchanges the callback code as a form", async () => {
  const { fetcher, requests } = fakeFetch(() =>
    Response.json({ access_token: chatgptToken("acct-9"), refresh_token: "rt", expires_in: 60 }),
  );
  const result = chatgpt.login({
    fetcher,
    onUrl: (url) => {
      const u = new URL(url);
      expect(u.origin + u.pathname).toBe("https://auth.openai.com/oauth/authorize");
      expect(u.searchParams.get("codex_cli_simplified_flow")).toBe("true");
      void fetch(`${u.searchParams.get("redirect_uri")}?state=${u.searchParams.get("state")}&code=the-code`).catch(
        () => {},
      );
    },
  });
  expect(await result).toMatchObject({ account_id: "acct-9", refresh_token: "rt" });
  const body = new URLSearchParams(requests[0]!.init!.body as string);
  expect(body.get("grant_type")).toBe("authorization_code");
  expect(body.get("code")).toBe("the-code");
  expect(body.get("redirect_uri")).toMatch(/^http:\/\/localhost:\d+\/auth\/callback$/);
});

test("grok: account id from userinfo, manual code, and logout revokes then deletes", async () => {
  const { fetcher, requests } = fakeFetch(({ url }) =>
    url.endsWith("/userinfo")
      ? Response.json({ sub: "user-7" })
      : url.endsWith("/revoke")
        ? new Response("", { status: 500 })
        : Response.json({ access_token: "at", refresh_token: "rt", expires_in: 60 }),
  );
  const s = await grok.login({ fetcher, onUrl: () => {}, manualCode: Promise.resolve("pasted-code") });
  expect(s).toMatchObject({ access_token: "at", account_id: "user-7" });
  expect(new URLSearchParams(requests[0]!.init!.body as string).get("code")).toBe("pasted-code");

  saveSession("grok", s);
  expect(await grok.logout(fetcher)).toEqual({ removed: true, revoked: false });
  expect(new URLSearchParams(requests.at(-1)!.init!.body as string).get("token")).toBe("rt");
  expect(loadSession("grok")).toBeUndefined();

  const rejected = fakeFetch(() => Response.json({ error: "invalid_grant" }, { status: 400 }));
  expect(grok.refresh(session(), rejected.fetcher)).rejects.toBeInstanceOf(RefreshRejected);
});
