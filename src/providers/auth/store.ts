/** Subscription sessions on disk (~/.nod/<provider>-auth.json, mode 0600) and refresh-on-demand credentials. */
import { chmodSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Session = {
  version: 1;
  access_token: string;
  refresh_token: string;
  expires_at_ms: number;
  account_id: string;
};
export type Credential = { token: string; accountId: string };
/** "force" refreshes even when the token has not expired, e.g. after a 401. */
export type CredentialSource = (mode: "if_needed" | "force") => Promise<Credential>;

/** The provider revoked the refresh token. The session is deleted and the user must sign in again. */
export class RefreshRejected extends Error {}

/** Refresh this long before the token expires. */
const REFRESH_MARGIN_MS = 60_000;

const home = () => process.env.NOD_HOME ?? join(homedir(), ".nod");
export const sessionPath = (provider: string) => join(home(), `${provider}-auth.json`);

export function loadSession(provider: string): Session | undefined {
  const path = sessionPath(provider);
  let stat: ReturnType<typeof lstatSync>;
  try {
    stat = lstatSync(path);
  } catch {
    return undefined;
  }
  if (!stat.isFile() || stat.mode & 0o077)
    throw new Error(`${path} must be a regular file only you can read (chmod 600 ${path}).`);
  return JSON.parse(readFileSync(path, "utf8")) as Session;
}

/** Writes atomically so a crash never leaves a half-written token file. */
export function saveSession(provider: string, session: Session) {
  mkdirSync(home(), { recursive: true, mode: 0o700 });
  chmodSync(home(), 0o700);
  const path = sessionPath(provider);
  const tmp = `${path}.${process.pid}.tmp`;
  rmSync(tmp, { force: true });
  writeFileSync(tmp, JSON.stringify(session), { mode: 0o600 });
  renameSync(tmp, path);
}

/** Returns false when there was no session. */
export function removeSession(provider: string): boolean {
  const path = sessionPath(provider);
  try {
    rmSync(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * Loads the stored session and refreshes it when needed. Concurrent callers share one refresh.
 * Separate nod processes do not coordinate, so two refreshing at once can race.
 */
export function credentials(
  provider: string,
  refresh: (session: Session) => Promise<Session>,
  now = Date.now,
): CredentialSource {
  let pending: Promise<Session> | undefined;
  return async (mode) => {
    let session = loadSession(provider);
    if (!session) throw new Error(`Not signed in. Run: nod login ${provider}`);
    if (mode === "force" || session.expires_at_ms - REFRESH_MARGIN_MS <= now()) {
      const current = session;
      pending ??= refresh(current)
        .then((next) => {
          if (next.account_id !== current.account_id)
            throw new Error(
              `The refreshed ${provider} session belongs to a different account. Run: nod login ${provider}`,
            );
          saveSession(provider, next);
          return next;
        })
        .catch((e: unknown) => {
          if (!(e instanceof RefreshRejected)) throw e;
          removeSession(provider);
          throw new Error(`Your ${provider} session expired. Run: nod login ${provider}`);
        })
        .finally(() => (pending = undefined));
      session = await pending;
    }
    return { token: session.access_token, accountId: session.account_id };
  };
}
