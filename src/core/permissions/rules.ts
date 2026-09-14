/** Persistent permission rules: parsing, matching, and the `nod permissions` snapshot. */
import path from "node:path";
import type { PermissionMode } from "../agent/types.ts";
import { isStaticCommand } from "./commands.ts";
import type { Grant } from "./grants.ts";

export type RuleAction = "allow" | "ask" | "deny";
export type RuleSource = "user" | "workspace";
export type Rule = { permission: string; pattern: string; action: RuleAction; source?: RuleSource };
export type RuleDecision = "none" | "allow" | "ask" | "deny";

export const WEB_FETCH_PERMISSION = "web_fetch";

/** read_file→read, write_file|edit_file→edit, glob_files→glob, grep_files→grep, shell→bash, skill|install_skill→skill. */
export function permissionName(toolName: string): string {
  switch (toolName) {
    case "read_file":
      return "read";
    case "write_file":
    case "edit_file":
      return "edit";
    case "glob_files":
      return "glob";
    case "grep_files":
      return "grep";
    case "shell":
    case "run_command":
      return "bash";
    case "skill":
    case "install_skill":
      return "skill";
    default:
      return toolName;
  }
}

function parseAction(raw: unknown): RuleAction | null {
  if (typeof raw !== "string") return null;
  const lower = raw.toLowerCase();
  return lower === "allow" || lower === "ask" || lower === "deny" ? lower : null;
}

/**
 * Parses the `"permission"` settings value: a bare action, or `{perm: action | {pattern: action}}`.
 * Invalid entries are skipped and reported in `diagnostics` instead of failing the whole file.
 */
export function parseRules(json: unknown, source?: RuleSource): { rules: Rule[]; diagnostics: string[] } {
  const rules: Rule[] = [];
  const diagnostics: string[] = [];
  const push = (permission: string, pattern: string, action: RuleAction) => {
    rules.push(source ? { permission, pattern, action, source } : { permission, pattern, action });
  };
  if (json === undefined || json === null) return { rules, diagnostics };
  if (typeof json === "string") {
    const action = parseAction(json);
    if (action) push("*", "*", action);
    else diagnostics.push(`permission: invalid action "${json}"`);
    return { rules, diagnostics };
  }
  if (typeof json !== "object" || Array.isArray(json)) {
    diagnostics.push("permission: expected a string or an object");
    return { rules, diagnostics };
  }
  for (const [rawPermission, value] of Object.entries(json)) {
    const permission = rawPermission.trim();
    if (permission.length === 0) {
      diagnostics.push("permission: empty permission name");
      continue;
    }
    if (typeof value === "string") {
      const action = parseAction(value);
      if (action) push(permission, "*", action);
      else diagnostics.push(`permission.${permission}: invalid action "${value}"`);
      continue;
    }
    if (typeof value !== "object" || value === null || Array.isArray(value)) {
      diagnostics.push(`permission.${permission}: expected an action or a pattern map`);
      continue;
    }
    for (const [rawPattern, rawAction] of Object.entries(value)) {
      const action = parseAction(rawAction);
      if (action) push(permission, rawPattern.trim(), action);
      else diagnostics.push(`permission.${permission}.${rawPattern}: invalid action "${String(rawAction)}"`);
    }
  }
  return { rules, diagnostics };
}

/** User rules first, workspace rules last: last-match-wins gives the workspace precedence. */
export function effectiveRules(user: Rule[], workspace: Rule[]): Rule[] {
  return [...user, ...workspace];
}

/** `*` and `?` glob with backtracking. */
export function wildcardMatch(pattern: string, candidate: string): boolean {
  let p = 0;
  let c = 0;
  let star = -1;
  let starCandidate = 0;
  while (c < candidate.length) {
    if (p < pattern.length && (pattern[p] === "?" || pattern[p] === candidate[c])) {
      p++;
      c++;
      continue;
    }
    if (p < pattern.length && pattern[p] === "*") {
      star = p;
      p++;
      starCandidate = c;
      continue;
    }
    if (star < 0) return false;
    starCandidate++;
    c = starCandidate;
    p = star + 1;
  }
  while (p < pattern.length && pattern[p] === "*") p++;
  return p === pattern.length;
}

/** `dir/**` matches `dir` itself and everything below it. */
export function directoryTreeMatch(pattern: string, candidate: string): boolean {
  if (!pattern.endsWith("/**")) return false;
  if (pattern === "/**") return candidate.startsWith("/");
  const dir = pattern.slice(0, -"/**".length);
  return (
    candidate === dir || (candidate.length > dir.length && candidate.startsWith(dir) && candidate[dir.length] === "/")
  );
}

export function targetMatches(pattern: string, candidate: string): boolean {
  return directoryTreeMatch(pattern, candidate) || wildcardMatch(pattern, candidate);
}

/** A rule's permission matches the permission name or the tool name. */
export function permissionMatches(rulePermission: string, permission: string, toolName?: string): boolean {
  if (wildcardMatch(rulePermission, permission)) return true;
  return toolName !== undefined && wildcardMatch(rulePermission, toolName);
}

/** Wildcard match where `*`/`?` inside single quotes are literal. */
export function staticCommandWildcardMatch(pattern: string, candidate: string): boolean {
  let p = 0;
  let c = 0;
  let quoted = false;
  let star = -1;
  let starCandidate = 0;
  while (c < candidate.length) {
    if (p < pattern.length) {
      const char = pattern[p]!;
      if (!quoted && char === "*") {
        star = p;
        p++;
        starCandidate = c;
        continue;
      }
      if ((!quoted && char === "?") || char === candidate[c]) {
        if (char === "'") quoted = !quoted;
        p++;
        c++;
        continue;
      }
    }
    if (star < 0) return false;
    starCandidate++;
    c = starCandidate;
    p = star + 1;
    quoted = false;
  }
  while (p < pattern.length && !quoted && pattern[p] === "*") p++;
  return p === pattern.length;
}

const hasWildcard = (pattern: string) => pattern.includes("*") || pattern.includes("?");

/** bash allow rules are strict: no wildcard → exact; with wildcards both sides must be static commands. */
function ruleTargetMatches(permission: string, action: RuleAction, pattern: string, candidate: string): boolean {
  if (action !== "allow" || permission !== "bash") return targetMatches(pattern, candidate);
  if (!hasWildcard(pattern)) return pattern === candidate;
  if (!isStaticCommand(pattern, true) || !isStaticCommand(candidate, false)) return false;
  return staticCommandWildcardMatch(pattern, candidate);
}

/**
 * Last matching rule wins. `target` is the rule-facing form: workspace-relative or absolute path,
 * the command text, `domain:host` for web_fetch, the skill location, or the tool name.
 */
export function ruleDecision(rules: Rule[], permission: string, toolName: string, target: string): RuleDecision {
  if (permission === WEB_FETCH_PERMISSION) return webFetchDecision(rules, target);
  let matched: RuleDecision = "none";
  for (const rule of rules) {
    if (!permissionMatches(rule.permission, permission, toolName)) continue;
    if (!ruleTargetMatches(permission, rule.action, rule.pattern, target)) continue;
    matched = rule.action;
  }
  return matched;
}

function webFetchDecision(rules: Rule[], target: string): RuleDecision {
  if (!isCanonicalDomain(target)) return "none";
  let matched: RuleDecision = "none";
  for (const rule of rules) {
    if (rule.permission !== WEB_FETCH_PERMISSION) continue;
    // ponytail: stored patterns are normally canonical; nod also accepts a bare host.
    if (canonicalDomain(rule.pattern) !== target) continue;
    matched = rule.action;
  }
  return matched;
}

const isGlobalPattern = (pattern: string) => pattern.length > 0 && /^\*+$/.test(pattern);

/** True when a global deny is the last word for every target: the tool can be hidden from the model. */
export function rulesDenyAllTargets(rules: Rule[], permission: string, toolName?: string): boolean {
  if (permission === WEB_FETCH_PERMISSION) return false;
  let lastGlobalDeny = -1;
  rules.forEach((rule, index) => {
    if (!permissionMatches(rule.permission, permission, toolName)) return;
    if (!isGlobalPattern(rule.pattern)) return;
    lastGlobalDeny = rule.action === "deny" ? index : -1;
  });
  if (lastGlobalDeny < 0) return false;
  for (const rule of rules.slice(lastGlobalDeny + 1)) {
    if (!permissionMatches(rule.permission, permission, toolName) || rule.action === "deny") continue;
    const decision = ruleDecision(rules, permission, toolName ?? permission, rule.pattern);
    if (decision === "allow" || decision === "ask") return false;
  }
  return true;
}

/** `domain:host` in lowercase, or null when the host is not a canonicalizable DNS name / IPv6 literal. */
export function canonicalDomain(raw: string): string | null {
  const hostRaw = raw.startsWith("domain:") ? raw.slice("domain:".length) : raw;
  if (hostRaw.includes("://") || /[/*?]/.test(hostRaw)) return null;
  const host = hostRaw.length > 1 && hostRaw.endsWith(".") ? hostRaw.slice(0, -1) : hostRaw;
  if (!canonicalizableHost(host)) return null;
  return `domain:${host.toLowerCase()}`;
}

export function isCanonicalDomain(pattern: string): boolean {
  if (!pattern.startsWith("domain:")) return false;
  const host = pattern.slice("domain:".length);
  return canonicalizableHost(host) && !host.endsWith(".") && host === host.toLowerCase();
}

function canonicalizableHost(host: string): boolean {
  if (host.length === 0) return false;
  if (host.startsWith("[")) {
    if (host.length < 3 || !host.endsWith("]")) return false;
    const inner = host.slice(1, -1);
    return /^[0-9a-f:.]+$/i.test(inner) && inner.includes(":");
  }
  if (host.includes(":")) return false;
  return /^[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*$/.test(host);
}

/** The web_fetch permission target for a URL: `domain:host`, or null for URLs without a usable host. */
export function canonicalHost(url: string): string | null {
  const schemeEnd = url.indexOf("://");
  if (schemeEnd < 0) return null;
  const start = schemeEnd + 3;
  let end = url.length;
  for (let i = start; i < url.length; i++) {
    const char = url[i];
    if (char === "/" || char === "?" || char === "#") {
      end = i;
      break;
    }
  }
  const authority = url.slice(start, end);
  if (authority.length === 0 || authority.includes("@")) return null;
  let host: string;
  if (authority.startsWith("[")) {
    const close = authority.indexOf("]");
    if (close <= 1) return null;
    if (close + 1 < authority.length && authority[close + 1] !== ":") return null;
    host = authority.slice(0, close + 1);
  } else {
    const colon = authority.lastIndexOf(":");
    if (colon === 0) return null;
    host = colon < 0 ? authority : authority.slice(0, colon);
  }
  return canonicalDomain(host);
}

export type PermissionsSnapshot = { mode: PermissionMode; rules: Rule[]; grants: Grant[]; workspaceRoot: string };

function displayGrantTarget(workspaceRoot: string, grant: Grant): string {
  if (grant.permission === "bash" || grant.permission === "run_command") return grant.pattern;
  if (path.isAbsolute(grant.pattern)) return path.relative(workspaceRoot, grant.pattern) || ".";
  return grant.pattern;
}

/** The `nod permissions --json` object, plus `source` on each rule. */
export function describePermissions(snapshot: PermissionsSnapshot) {
  return {
    kind: "permissions" as const,
    mode: snapshot.mode,
    grant_count: snapshot.grants.length,
    grant_scope: "session" as const,
    runtime_grants_available: true,
    rules_scope: "persistent_config" as const,
    rules: snapshot.rules.map((rule) => ({
      permission: rule.permission,
      pattern: rule.pattern,
      action: rule.action,
      ...(rule.source ? { source: rule.source } : {}),
    })),
    grants: snapshot.grants.map((grant) => ({
      tool_name: grant.permission,
      target_path: grant.pattern,
      display_target: displayGrantTarget(snapshot.workspaceRoot, grant),
    })),
  };
}

/** The `nod permissions` text form. */
export function formatPermissions(
  snapshot: PermissionsSnapshot,
  displayMode: (mode: PermissionMode) => string,
): string {
  let out = `[permissions] mode=${displayMode(snapshot.mode)}\n`;
  if (snapshot.rules.length === 0) out += "[permissions] configured rules: (none)\n";
  else {
    out += "[permissions] configured rules:\n";
    for (const rule of snapshot.rules) out += ` - ${rule.action} ${rule.permission} -> ${rule.pattern}\n`;
  }
  if (snapshot.grants.length === 0) return `${out}[permissions] session grants: (none)\n`;
  out += "[permissions] session grants:\n";
  for (const grant of snapshot.grants) {
    out += ` - ${grant.permission} -> ${displayGrantTarget(snapshot.workspaceRoot, grant)}\n`;
  }
  return out;
}
