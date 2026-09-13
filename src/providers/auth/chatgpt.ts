/** Sign in with a ChatGPT subscription: OpenAI's Codex OAuth client, PKCE, callback on localhost:1455. After vercel-labs/fx. */
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
import { credentials, RefreshRejected, type Session } from "./store.ts";

export const PROVIDER = "codex";
export const CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";
export const ORIGINATOR = "nod";
const ISSUER = "https://auth.openai.com";
const TOKEN_URL = `${ISSUER}/oauth/token`;
const SCOPE = "openid profile email offline_access api.connectors.read api.connectors.invoke";
const AUTH_CLAIM = "https://api.openai.com/auth";
const TERMINAL_REFRESH_ERRORS = /refresh_token_expired|refresh_token_reused|refresh_token_invalidated|invalid_grant/;

function jwtClaims(token: string): Record<string, unknown> {
  const payload = token.split(".")[1];
  if (!payload) throw new Error("The ChatGPT access token is not a JWT.");
  return JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Record<string, unknown>;
}

export function accountIdFromJwt(token: string): string {
  const id = (jwtClaims(token)[AUTH_CLAIM] as { chatgpt_account_id?: unknown } | undefined)?.chatgpt_account_id;
  // The id is sent as a header, so reject anything that could split it.
  if (!isNonEmptyString(id) || /[\r\n]/.test(id)) throw new Error("The ChatGPT access token has no account id.");
  return id;
}

function toSession(json: TokenResponse, previous?: Session): Session {
  const refresh = isNonEmptyString(json.refresh_token) ? json.refresh_token : previous?.refresh_token;
  if (!isNonEmptyString(json.access_token) || !refresh) throw new Error("ChatGPT sign-in returned no tokens.");
  const exp = jwtClaims(json.access_token).exp;
  const expiresAt =
    typeof json.expires_in === "number" && json.expires_in > 0
      ? Date.now() + json.expires_in * 1000
      : typeof exp === "number"
        ? exp * 1000
        : undefined;
  if (!expiresAt) throw new Error("ChatGPT sign-in returned no expiry.");
  return {
    version: 1,
    access_token: json.access_token,
    refresh_token: refresh,
    expires_at_ms: expiresAt,
    account_id: accountIdFromJwt(json.access_token),
  };
}

export async function login({
  onUrl,
  fetcher = fetch,
}: {
  onUrl: (url: string) => void;
  fetcher?: typeof fetch;
}): Promise<Session> {
  const { verifier, challenge, state } = await pkce();
  const callback = listenForCallback({ ports: [1455, 1457], path: "/auth/callback", state, redirectHost: "localhost" });
  try {
    const url = new URL(`${ISSUER}/oauth/authorize`);
    url.search = new URLSearchParams({
      response_type: "code",
      client_id: CLIENT_ID,
      redirect_uri: callback.redirectUri,
      scope: SCOPE,
      code_challenge: challenge,
      code_challenge_method: "S256",
      id_token_add_organizations: "true",
      codex_cli_simplified_flow: "true",
      state,
      originator: ORIGINATOR,
    }).toString();
    onUrl(url.href);
    const code = await withTimeout(callback.code, LOGIN_TIMEOUT_MS, "Timed out waiting for ChatGPT sign-in.");
    const params = {
      grant_type: "authorization_code",
      client_id: CLIENT_ID,
      code,
      code_verifier: verifier,
      redirect_uri: callback.redirectUri,
    };
    return toSession(await tokenRequest(fetcher, TOKEN_URL, new URLSearchParams(params)));
  } finally {
    callback.stop();
  }
}

/** The token endpoint takes JSON for refresh, unlike the form-encoded code exchange. */
export async function refresh(session: Session, fetcher: typeof fetch = fetch): Promise<Session> {
  try {
    const json = await tokenRequest(fetcher, TOKEN_URL, {
      client_id: CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: session.refresh_token,
    });
    return toSession(json, session);
  } catch (e) {
    if (e instanceof OAuthError && TERMINAL_REFRESH_ERRORS.test(e.body)) throw new RefreshRejected(e.message);
    throw e;
  }
}

export const credential = (fetcher: typeof fetch = fetch) => credentials(PROVIDER, (s) => refresh(s, fetcher));
