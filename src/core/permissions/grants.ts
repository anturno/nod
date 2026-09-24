/** Session grants ("Yes, and don't ask again"). Memory only: never persisted, cleared by /permissions reset. */
import { statSync } from "node:fs";
import path from "node:path";
import type { PermissionTarget } from "../tools/spec.ts";
import { canonicalDomain, isCanonicalDomain, permissionMatches, targetMatches, WEB_FETCH_PERMISSION } from "./rules.ts";

export type Grant = { permission: string; pattern: string };

const PATH_ALWAYS_PERMISSIONS = ["edit", "read", "glob", "grep"];

export function pathInside(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(root.endsWith("/") ? root : `${root}/`);
}

const directoryTreePattern = (dir: string) => (dir.endsWith("/") ? `${dir}**` : `${dir}/**`);

/** bash grants match the exact command, web_fetch the exact canonical host, everything else tree/wildcard. */
export function grantAllows(grants: Grant[], permission: string, toolName: string, target: string): boolean {
  if (permission === WEB_FETCH_PERMISSION) {
    if (!isCanonicalDomain(target)) return false;
    return grants.some((g) => g.permission === WEB_FETCH_PERMISSION && canonicalDomain(g.pattern) === target);
  }
  for (const grant of grants) {
    if (!permissionMatches(grant.permission, permission, toolName)) continue;
    if (permission === "bash" ? grant.pattern === target : targetMatches(grant.pattern, target)) return true;
  }
  return false;
}

/** The grant-facing target: absolute path for path targets, otherwise the rule-facing target. */
export function grantTarget(target: PermissionTarget): string {
  return target.kind === "path" ? (target.absolute ?? target.target) : target.target;
}

export function grantsAllowAll(grants: Grant[], toolName: string, targets: PermissionTarget[]): boolean {
  return targets.every((t) => grantAllows(grants, t.permission, toolName, grantTarget(t)));
}

function externalGrantRoot(workspaceRoot: string, absolute: string): string | null {
  if (!path.isAbsolute(absolute)) return null;
  if (workspaceRoot.length > 0 && pathInside(workspaceRoot, absolute)) return null;
  try {
    if (statSync(absolute).isDirectory()) return absolute;
  } catch {}
  return path.dirname(absolute);
}

/**
 * What "Yes, and don't ask again" would grant: the exact command for bash; edit/read/glob/grep over
 * `<workspace>/**` for workspace paths; `<dir>/**` for external paths; the target itself otherwise.
 */
export function suggestedGrants(workspaceRoot: string, targets: PermissionTarget[]): Grant[] {
  const grants: Grant[] = [];
  const add = (permission: string, pattern: string) => {
    if (!grants.some((g) => g.permission === permission && g.pattern === pattern)) grants.push({ permission, pattern });
  };
  for (const target of targets) {
    if (target.permission === "bash") {
      add("bash", target.target);
      continue;
    }
    if (target.kind === "path") {
      const absolute = target.absolute ?? target.target;
      if (workspaceRoot.length > 0 && pathInside(workspaceRoot, absolute)) {
        for (const permission of PATH_ALWAYS_PERMISSIONS) add(permission, directoryTreePattern(workspaceRoot));
        continue;
      }
      const root = externalGrantRoot(workspaceRoot, absolute);
      if (root) {
        add(target.permission, directoryTreePattern(root));
        continue;
      }
    }
    add(target.permission, grantTarget(target));
  }
  return grants;
}
