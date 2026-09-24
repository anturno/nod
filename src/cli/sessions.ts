/** sessions, session, usage, workspace: local records without a model request. */
import { loadConfig } from "../core/config/resolve.ts";
import {
  findLastSession,
  listSessions,
  renderMigration,
  renderRecovery,
  renderSessionDetail,
  renderSessions,
  SESSION_LIST_MAX_LIMIT,
} from "../core/session/catalog.ts";
import { SessionError } from "../core/session/id.ts";
import { migrateSession, readSessionDetail, recoverSession } from "../core/session/store.ts";
import { buildReport, type Period, renderUsage } from "../core/usage/report.ts";
import { loadUsage } from "../core/usage/store.ts";
import { resolveAccess, WorkspaceError } from "../core/workspace/access.ts";
import { runWorkspaceCommand, type WorkspaceAction } from "../core/workspace/commands.ts";
import { renderWorkspace } from "../core/workspace/render.ts";
import { CliUsageError, parseFlags } from "./global-args.ts";
import type { Io } from "./output.ts";
import { renderFailureJson } from "./output.ts";

const fmt = (json: boolean): "json" | "text" => (json ? "json" : "text");

export function runSessions(args: string[], io: Io): number {
  const { flags, positionals: rest } = parseFlags(
    args,
    { "--json": "boolean", "--all": "boolean", "--limit": "string", "--cursor": "string" },
    "sessions [--all] [--limit N] [--cursor C] [--json]",
  );
  if (rest.length > 0)
    throw new CliUsageError("InvalidArgs", "usage: nod sessions [--all] [--limit N] [--cursor C] [--json]");
  const limitRaw = flags["--limit"] as string | undefined;
  const limit = limitRaw === undefined ? undefined : Number(limitRaw);
  if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > SESSION_LIST_MAX_LIMIT))
    throw new CliUsageError("InvalidArgs", `--limit must be an integer between 1 and ${SESSION_LIST_MAX_LIMIT}`);
  const config = loadConfig({ workspaceRoot: io.cwd, env: io.env });
  const page = listSessions(
    { home: config.home, cwd: io.cwd, now: Date.now },
    { scope: flags["--all"] ? "all" : "workspace", limit, cursor: flags["--cursor"] as string | undefined },
  );
  const text = renderSessions(page, fmt(flags["--json"] === true));
  io.stdout(text.endsWith("\n") ? text : `${text}\n`);
  return 0;
}

export function runSession(args: string[], io: Io): number {
  const { flags, positionals: rest } = parseFlags(
    args,
    { "--json": "boolean", "--id": "string" },
    "session <last|id> [--id ID] [--json]",
  );
  const json = flags["--json"] === true;
  const config = loadConfig({ workspaceRoot: io.cwd, env: io.env });
  const deps = { home: config.home, cwd: io.cwd, now: Date.now };
  const sub = rest[0];
  const emit = (text: string) => (io.stdout(text.endsWith("\n") ? text : `${text}\n`), 0);
  try {
    if (sub === "migrate" || sub === "recover") {
      const id = rest[1] ?? (flags["--id"] as string | undefined);
      if (!id || rest.length > 2) throw new CliUsageError("InvalidArgs", `usage: nod session ${sub} <id> [--json]`);
      return emit(
        sub === "migrate"
          ? renderMigration(migrateSession(deps, id), fmt(json))
          : renderRecovery(recoverSession(deps, id), fmt(json)),
      );
    }
    const explicit = flags["--id"] as string | undefined;
    if ((explicit && rest.length > 0) || (!explicit && rest.length !== 1))
      throw new CliUsageError("InvalidArgs", "usage: nod session <last|id> [--id ID] [--json]");
    const id = explicit ?? (sub === "last" ? findLastSession(deps, "workspace")?.id : sub);
    if (!id) throw new SessionError("not_found", "no saved session in this workspace");
    return emit(renderSessionDetail(readSessionDetail(deps, id), fmt(json)));
  } catch (e) {
    if (e instanceof SessionError) {
      io.stdout(json ? `${renderFailureJson("session", e.message, e.code)}\n` : `[session] ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}

export function runUsage(args: string[], io: Io): number {
  const { flags, positionals: rest } = parseFlags(
    args,
    { "--json": "boolean", "--period": "string" },
    "usage [--period 24h|7d|30d] [--json]",
  );
  const period = (flags["--period"] as string | undefined) ?? "30d";
  if (rest.length > 0 || !["24h", "7d", "30d"].includes(period))
    throw new CliUsageError("InvalidArgs", "usage: nod usage [--period 24h|7d|30d] [--json]");
  const config = loadConfig({ workspaceRoot: io.cwd, env: io.env });
  const report = buildReport(loadUsage(config.home), period as Period, Date.now());
  const text = renderUsage(report, fmt(flags["--json"] === true));
  io.stdout(text.endsWith("\n") ? text : `${text}\n`);
  return 0;
}

export function runWorkspace(args: string[], io: Io, global: { addDirs: string[]; noAdditionalDirs: boolean }): number {
  const { flags, positionals: rest } = parseFlags(
    args,
    { "--json": "boolean" },
    "workspace [list|add <path>|remove <path>|clear] [--json]",
  );
  const json = flags["--json"] === true;
  const [verb = "list", path] = rest;
  let action: WorkspaceAction;
  if (verb === "list" && rest.length === 1) action = { kind: "list" };
  else if (verb === "clear" && rest.length === 1) action = { kind: "clear" };
  else if ((verb === "add" || verb === "remove") && rest.length === 2 && path) action = { kind: verb, path };
  else if (rest.length === 0) action = { kind: "list" };
  else throw new CliUsageError("InvalidArgs", "usage: nod workspace [list|add <path>|remove <path>|clear] [--json]");
  const config = loadConfig({ workspaceRoot: io.cwd, env: io.env });
  const scope = resolveAccess({ cwd: io.cwd }, config.additionalDirectories, {
    addDirs: global.addDirs,
    suppressSaved: global.noAdditionalDirs,
  });
  try {
    const result = runWorkspaceCommand({ home: config.home }, action, scope);
    const text = renderWorkspace({ ...result.snapshot, mutation: result.mutation }, fmt(json));
    io.stdout(text.endsWith("\n") ? text : `${text}\n`);
    return 0;
  } catch (e) {
    if (e instanceof WorkspaceError) {
      io.stdout(json ? `${renderFailureJson("workspace", e.message, e.code)}\n` : `[workspace] ${e.message}\n`);
      return 1;
    }
    throw e;
  }
}
