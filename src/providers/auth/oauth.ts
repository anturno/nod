/** OAuth pieces shared by the subscription logins: PKCE, the localhost callback, token requests. */

const base64url = (bytes: ArrayBuffer | Uint8Array) =>
  Buffer.from(bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes)).toString("base64url");
const random = () => base64url(crypto.getRandomValues(new Uint8Array(32)));

export const LOGIN_TIMEOUT_MS = 5 * 60_000;

export async function pkce() {
  const verifier = random();
  const challenge = base64url(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)));
  return { verifier, challenge, state: random() };
}

export type Callback = { redirectUri: string; code: Promise<string>; stop(): void };

/**
 * Listens on the first free port for the browser redirect. Requests with another path or state get a 404, so a stray
 * request cannot end or fail the login.
 */
export function listenForCallback(opts: {
  ports: number[];
  path: string;
  state: string;
  redirectHost: string;
  corsOrigin?: string;
}): Callback {
  let resolve!: (code: string) => void;
  let reject!: (e: Error) => void;
  const code = new Promise<string>((res, rej) => ((resolve = res), (reject = rej)));
  code.catch(() => {});

  const page = (text: string, status = 200, headers: Record<string, string> = {}) =>
    new Response(`<!doctype html><title>nod</title><p style="font-family:system-ui;margin:3rem">${text}</p>`, {
      status,
      headers: { ...headers, "content-type": "text/html" },
    });

  const handle = (req: Request) => {
    const url = new URL(req.url);
    const cors: Record<string, string> =
      opts.corsOrigin && req.headers.get("origin") === opts.corsOrigin
        ? {
            "access-control-allow-origin": opts.corsOrigin,
            "access-control-allow-methods": "GET, OPTIONS",
            "access-control-allow-headers": "*",
          }
        : {};
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (url.pathname !== opts.path || url.searchParams.get("state") !== opts.state)
      return new Response("Not found", { status: 404, headers: cors });
    const received = url.searchParams.get("code");
    if (!received) {
      const error = url.searchParams.get("error_description") ?? url.searchParams.get("error") ?? "no code";
      reject(new Error(`Sign-in failed: ${error}`));
      return page("Sign-in failed. Return to the terminal.", 400, cors);
    }
    resolve(received);
    return page("Signed in. You can close this tab and return to nod.", 200, cors);
  };

  let lastError: unknown;
  for (const port of opts.ports) {
    try {
      const server = Bun.serve({ hostname: "127.0.0.1", port, fetch: handle });
      return {
        redirectUri: `http://${opts.redirectHost}:${server.port}${opts.path}`,
        code,
        stop: () => void server.stop(),
      };
    } catch (e) {
      lastError = e;
    }
  }
  throw new Error(
    `Could not listen for the sign-in callback on port ${opts.ports.join(" or ")}: ${(lastError as Error).message}`,
  );
}

export function openBrowser(url: string) {
  if (process.env.NOD_NO_OPEN_BROWSER) return;
  const cmd =
    process.platform === "darwin"
      ? ["open", url]
      : process.platform === "win32"
        ? ["cmd", "/c", "start", "", url]
        : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch {
    // The URL is printed too.
  }
}

export function withTimeout<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => (timer = setTimeout(() => reject(new Error(message)), ms)));
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/** A failed token request. body is kept so providers can spot terminal refresh errors. */
export class OAuthError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`OAuth request failed (${status}): ${body.slice(0, 500)}`);
  }
}

export type TokenResponse = { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };

/** POSTs a form (URLSearchParams) or JSON (plain object) body. */
export async function tokenRequest(
  fetcher: typeof fetch,
  url: string,
  body: URLSearchParams | Record<string, string>,
): Promise<TokenResponse> {
  const form = body instanceof URLSearchParams;
  const res = await fetcher(url, {
    method: "POST",
    headers: {
      "content-type": form ? "application/x-www-form-urlencoded" : "application/json",
      accept: "application/json",
    },
    body: form ? body.toString() : JSON.stringify(body),
  });
  const text = await res.text();
  if (!res.ok) throw new OAuthError(res.status, text);
  return JSON.parse(text) as TokenResponse;
}

export const isNonEmptyString = (v: unknown): v is string => typeof v === "string" && v.length > 0;
