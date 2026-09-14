/** Session ids: 9 random bytes as unpadded base64url (12 chars). Also validates ids used in paths. */
import { randomBytes } from "node:crypto";

export class SessionError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
  }
}

export const generateSessionId = () => randomBytes(9).toString("base64url");

/** 1-255 bytes of [A-Za-z0-9._-], never "." or "..". Throws SessionError("invalid_session_id"). */
export function validateSessionId(id: string): string {
  if (id.length === 0 || id.length > 255 || id === "." || id === ".." || !/^[A-Za-z0-9._-]+$/.test(id))
    throw new SessionError("invalid_session_id", `invalid session id: ${JSON.stringify(id)}`);
  return id;
}
