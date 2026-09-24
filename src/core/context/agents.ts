/** Gathers AGENTS.md instructions: global, launch ancestors, the workspace, and narrower target scopes. */
import { lstatSync, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { lineSafePrefixLength, type ResolvedLimits } from "./limits.ts";

const GUIDANCE =
  "Direct user instructions take precedence over project instructions. When project instructions conflict, follow the narrowest applicable project scope.";
const MAX_FILE_BYTES = 64 * 1024 * 1024;

export type OmissionReason =
  | "home_unavailable"
  | "home_outside_workspace"
  | "oversized"
  | "unreadable"
  | "non_regular"
  | "symlink";
type Rule = {
  source: string;
  body: string;
  observedBytes: number;
  scope?: string;
  kind: "global" | "ancestor" | "project" | "target";
};
type Omission = { source: string; reason: OmissionReason };

export type ProjectContext = { text: string; delivered: string[]; notices: string[]; omissions: Omission[] };

const escapeAttr = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/\n/g, "&#x0a;");

const inside = (root: string, path: string) => path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

function readRule(
  source: string,
  authorityRoot: string,
): { body: string; observedBytes: number } | { omitted: OmissionReason } {
  let st: ReturnType<typeof lstatSync>;
  try {
    st = lstatSync(source);
  } catch (e) {
    return (e as NodeJS.ErrnoException).code === "ENOENT" ? { omitted: "unreadable" } : { omitted: "unreadable" };
  }
  if (st.isSymbolicLink()) {
    try {
      const real = realpathSync(source);
      if (!inside(realpathSync(authorityRoot), real)) return { omitted: "symlink" };
      if (!statSync(real).isFile()) return { omitted: "non_regular" };
    } catch {
      return { omitted: "unreadable" };
    }
  } else if (!st.isFile()) return { omitted: "non_regular" };
  if (st.size > MAX_FILE_BYTES) return { omitted: "oversized" };
  try {
    const bytes = readFileSync(source);
    return { body: bytes.toString("utf8"), observedBytes: bytes.length };
  } catch {
    return { omitted: "unreadable" };
  }
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

export type GatherOptions = {
  home?: string;
  workspaceRoot: string;
  /** Absolute paths targeted by the current tool call; narrower AGENTS.md files between the workspace and them apply. */
  targets?: string[];
  limits: Pick<ResolvedLimits, "project_instruction_file_bytes" | "project_instructions_total_bytes">;
  enabled: boolean;
};

export function gatherProjectContext(o: GatherOptions): ProjectContext {
  const empty: ProjectContext = { text: "", delivered: [], notices: [], omissions: [] };
  if (!o.enabled) return empty;
  const workspace = resolve(o.workspaceRoot);
  const home = o.home ? resolve(o.home) : undefined;
  const omissions: Omission[] = [];
  const notices: string[] = [];
  const rules: Rule[] = [];
  const fileLimit = o.limits.project_instruction_file_bytes;
  const totalLimit = o.limits.project_instructions_total_bytes;

  const consider = (source: string, authority: string, kind: Rule["kind"], scope?: string) => {
    if (!exists(source)) return;
    const read = readRule(source, authority);
    if ("omitted" in read) {
      omissions.push({ source, reason: read.omitted });
      return;
    }
    if (read.body.trim().length === 0) return;
    rules.push({ source, body: read.body, observedBytes: read.observedBytes, kind, scope });
  };

  // Global.
  if (!home) omissions.push({ source: "~/.nod/AGENTS.md", reason: "home_unavailable" });
  else consider(join(home, ".nod", "AGENTS.md"), home, "global");
  // Launch ancestors, only inside HOME and not HOME itself.
  if (home && inside(home, workspace) && workspace !== home) {
    const chain: string[] = [];
    for (let dir = dirname(workspace); dir !== home && inside(home, dir); dir = dirname(dir)) chain.unshift(dir);
    for (const dir of chain) consider(join(dir, "AGENTS.md"), home, "ancestor", relative(home, dir) || ".");
  } else if (home && workspace !== home && !inside(home, workspace))
    omissions.push({ source: workspace, reason: "home_outside_workspace" });
  // Project.
  consider(join(workspace, "AGENTS.md"), workspace, "project");
  // Target scopes.
  const seen = new Set<string>();
  for (const target of o.targets ?? []) {
    const abs = resolve(target);
    if (!inside(workspace, abs) || abs === workspace) continue;
    const dirs: string[] = [];
    for (
      let dir = exists(abs) && statSync(abs).isDirectory() ? abs : dirname(abs);
      dir !== workspace && inside(workspace, dir);
      dir = dirname(dir)
    )
      dirs.unshift(dir);
    for (const dir of dirs) {
      if (seen.has(dir)) continue;
      seen.add(dir);
      consider(join(dir, "AGENTS.md"), workspace, "target", relative(workspace, dir));
    }
  }

  // Render.
  const sections: { text: string; rule?: Rule }[] = [];
  const bodyOf = (rule: Rule): string => {
    const bytes = Buffer.from(rule.body);
    const cut = lineSafePrefixLength(bytes, fileLimit.bytes);
    return bytes.subarray(0, cut).toString("utf8").replace(/\n+$/, "");
  };
  const marker = (rule: Rule): string =>
    rule.observedBytes > fileLimit.bytes
      ? `\n\n<context_limit name="project_instruction_file_bytes" action="truncated" source_file="${escapeAttr(rule.source)}" observed_bytes="${rule.observedBytes}" effective_bytes="${fileLimit.bytes}" source="${fileLimit.source}" override="--context-limit project_instruction_file_bytes=BYTES|off" />`
      : "";
  for (const rule of rules) {
    if (rule.observedBytes > fileLimit.bytes)
      notices.push(
        `[context] project instruction file "${escapeAttr(rule.source)}" truncated: observed=${rule.observedBytes} bytes effective=${fileLimit.bytes} bytes source=${fileLimit.source}; override with --context-limit project_instruction_file_bytes=BYTES|off`,
      );
    const body = bodyOf(rule);
    const text =
      rule.kind === "global"
        ? `<global-rules from="${escapeAttr(rule.source)}">\n${body}\n</global-rules>`
        : rule.kind === "project"
          ? `<project-rules from="${escapeAttr(rule.source)}">\n${body}\n</project-rules>`
          : `<scoped-rules from="${escapeAttr(rule.source)}" scope="${escapeAttr(rule.scope ?? "")}">\n${body}\n</scoped-rules>`;
    sections.push({ text: text + marker(rule), rule });
  }
  if (sections.length === 0) {
    const omitted = omissions.filter((om) => om.reason !== "home_outside_workspace");
    return {
      text: omissionsText(omissions),
      delivered: [],
      notices: [...notices, ...omissionNotices(omitted)],
      omissions,
    };
  }
  const preamble = `<project-instructions-guidance>\n${GUIDANCE}\n</project-instructions-guidance>`;
  // Total cap: keep the preamble, the global rule, then the narrowest, then the rest in order.
  const bytesOf = (s: string) => Buffer.byteLength(s) + 2;
  const observed = bytesOf(preamble) + sections.reduce((n, s) => n + bytesOf(s.text), 0);
  let kept = sections;
  let omittedCount = 0;
  if (observed > totalLimit.bytes) {
    const order = [...sections.keys()];
    const priority = [order.find((i) => sections[i]?.rule?.kind === "global"), order.at(-1), ...order].filter(
      (i, idx, arr): i is number => i !== undefined && arr.indexOf(i) === idx,
    );
    const retained = new Set<number>();
    let used = bytesOf(preamble);
    for (const i of priority) {
      const size = bytesOf((sections[i] as { text: string }).text);
      if (used + size <= totalLimit.bytes) {
        retained.add(i);
        used += size;
      }
    }
    omittedCount = sections.length - retained.size;
    kept = sections.filter((_, i) => retained.has(i));
    const names = sections.filter((_, i) => !retained.has(i)).map((s) => s.rule?.source ?? "");
    notices.push(
      `[context] project instructions omitted ${omittedCount} source(s) (${names.join(", ")}): observed=${observed} bytes effective=${totalLimit.bytes} bytes source=${totalLimit.source}; override with --context-limit project_instructions_total_bytes=BYTES|off`,
    );
  }
  const parts = [preamble, ...kept.map((s) => s.text)];
  if (omittedCount > 0)
    parts.push(
      `<context_limit name="project_instructions_total_bytes" action="omitted" omitted_count="${omittedCount}" observed_bytes="${observed}" effective_bytes="${totalLimit.bytes}" source="${totalLimit.source}" override="--context-limit project_instructions_total_bytes=BYTES|off" />`,
    );
  const omissionText = omissionsText(omissions);
  if (omissionText) parts.push(omissionText);
  return {
    text: parts.join("\n\n"),
    delivered: kept.map((s) => s.rule?.source ?? "").filter(Boolean),
    notices: [...notices, ...omissionNotices(omissions.filter((om) => om.reason !== "home_outside_workspace"))],
    omissions,
  };
}

const omissionsText = (omissions: Omission[]) =>
  omissions.map((om) => `<project-rules-omitted from="${escapeAttr(om.source)}" reason="${om.reason}" />`).join("\n\n");

const omissionNotices = (omissions: Omission[]) =>
  omissions.map(
    (om) => `[context] project instructions action=omitted reason=${om.reason} source="${escapeAttr(om.source)}"`,
  );
