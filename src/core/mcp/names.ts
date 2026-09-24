/** mcp_<server>_<tool> aliases: sanitized, at most 64 chars, collisions suffixed _2, _3, ... */
const MAX_NAME_LEN = 64;

export const isIdentifierChar = (c: string): boolean => /^[A-Za-z0-9_-]$/.test(c);
const sanitize = (text: string): string => [...text].map((c) => (isIdentifierChar(c) ? c : "_")).join("");

export const baseToolName = (server: string, tool: string): string =>
  `mcp_${server ? sanitize(server) : "server"}_${tool ? sanitize(tool) : "tool"}`;

export type NameRegistry = {
  /** Stable alias for one (server, tool) identity; new identities never retarget an existing alias. */
  name(server: string, tool: string): string;
  identity(alias: string): { server: string; tool: string } | undefined;
};

export function createNameRegistry(reserved: Iterable<string> = []): NameRegistry {
  const taken = new Set(reserved);
  const byIdentity = new Map<string, string>();
  const byAlias = new Map<string, { server: string; tool: string }>();
  return {
    name(server, tool) {
      const key = `${server.length}:${server}${tool}`;
      const existing = byIdentity.get(key);
      if (existing) return existing;
      const base = baseToolName(server, tool);
      let candidate = base.slice(0, MAX_NAME_LEN);
      for (let suffix = 2; taken.has(candidate) || byAlias.has(candidate); suffix++) {
        const tail = `_${suffix}`;
        candidate = base.slice(0, MAX_NAME_LEN - tail.length) + tail;
      }
      byIdentity.set(key, candidate);
      byAlias.set(candidate, { server, tool });
      return candidate;
    },
    identity: (alias) => byAlias.get(alias),
  };
}
