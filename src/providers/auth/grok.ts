/** Sign in with a SuperGrok or X Premium subscription: xAI's Grok CLI OAuth client, PKCE, callback on a random port. */
import {
  isNonEmptyString,
  LOGIN_TIMEOUT_MS,
  listenForCallback,
  OAuthError,
  pkce,
  type TokenResponse,
  tokenRequest,
  withTimeout,
} from "./oauth.ts";
import { credentials, loadSession, RefreshRejected, removeSession, type Session } from "./store.ts";

export const PROVIDER = "grok";
export const CLIENT_ID = "b1a00492-073a-47ea-816f-4c329264a828";
const ISSUER = "https://auth.x.ai";
const TOKEN_URL = `${ISSUER}/oauth2/token`;
const USERINFO_URL = `${ISSUER}/oauth2/userinfo`;
const REVOKE_URL = `${ISSUER}/oauth2/revoke`;
const SCOPE = "openid profile email offline_access grok-cli:access api:access";

/** The account id is the userinfo subject. */
export async function userinfo(token: string, fetcher: typeof fetch = fetch): Promise<string> {
  const res = await fetcher(USERINFO_URL, {
    headers: { authorization: `Bearer ${token}`, accept: "application/json" },
  });
  if (!res.ok) throw new OAuthError(res.status, await res.text());
  const { sub } = (await res.json()) as { sub?: unknown };
  if (!isNonEmptyString(sub) || /[\r\n]/.test(sub)) throw new Error("xAI userinfo returned no account id.");
  return sub;
}

async function toSession(json: TokenResponse, fetcher: typeof fetch, previous?: Session): Promise<Session> {
  const refresh = isNonEmptyString(json.refresh_token) ? json.refresh_token : previous?.refresh_token;
  if (!isNonEmptyString(json.access_token) || !refresh) throw new Error("Grok sign-in returned no tokens.");
  if (typeof json.expires_in !== "number" || json.expires_in <= 0) throw new Error("Grok sign-in returned no expiry.");
  const accountId = await userinfo(json.access_token, fetcher);
  return {
    version: 1,
    access_token: json.access_token,
    refresh_token: refresh,
    expires_at_ms: Date.now() + json.expires_in * 1000,
    account_id: accountId,
  };
}

/** manualCode is for when the browser cannot reach the callback: the user pastes the code xAI shows. */
export async function login({
  onUrl,
  manualCode,
  fetcher = fetch,
}: {
  onUrl: (url: string) => void;
  manualCode?: Promise<string>;
  fetcher?: typeof fetch;
}): Promise<Session> {
  const { verifier, challenge, state } = await pkce();
  const callback = listenForCallback({
    ports: [0],
    path: "/callback",
    state,
    redirectHost: "127.0.0.1",
    corsOrigin: "https://accounts.x.ai",
  });
  try {
    const url = new URL(`${ISSUER}/oauth2/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: callback.redirectUri,
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      state,
      referrer: "nod",
    }).toString();
    onUrl(url.href);
    const pasted = manualCode?.then((c) => {
      if (!c || c.length > 4096 || !/^[\x21-\x7e]+$/.test(c))
        throw new Error("That does not look like a sign-in code.");
      return c;
    });
    const code = await withTimeout(
      pasted ? Promise.race([callback.code, pasted]) : callback.code,
      LOGIN_TIMEOUT_MS,
      "Timed out waiting for Grok sign-in.",
    );
    const params = {
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: callback.redirectUri,
    };
    return await toSession(await tokenRequest(fetcher, TOKEN_URL, new URLSearchParams(params)), fetcher);
  } finally {
    callback.stop();
  }
}

export async function refresh(session: Session, fetcher: typeof fetch = fetch): Promise<Session> {
  try {
    const params = new URLSearchParams({
      grant_type: "refresh_token",
      client_id: CLIENT_ID,
      refresh_token: session.refresh_token,
    });
    return await toSession(await tokenRequest(fetcher, TOKEN_URL, params), fetcher, session);
  } catch (e) {
    if (e instanceof OAuthError && e.body.includes("invalid_grant")) throw new RefreshRejected(e.message);
    throw e;
  }
}

/** Revokes the refresh token, then deletes the session even if revoking failed. */
export async function logout(fetcher: typeof fetch = fetch): Promise<{ removed: boolean; revoked: boolean }> {
  let revoked = false;
  let session: Session | undefined;
  try {
    session = loadSession(PROVIDER);
  } catch {
    // An unreadable file is still removed below.
  }
  if (session) {
    const body = new URLSearchParams({ token: session.refresh_token, client_id: CLIENT_ID });
    revoked = await fetcher(REVOKE_URL, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: body.toString(),
    }).then(
      (res) => res.ok,
      () => false,
    );
  }
  return { removed: removeSession(PROVIDER), revoked };
}

export const credential = (fetcher: typeof fetch = fetch) => credentials(PROVIDER, (s) => refresh(s, fetcher));
