/** status, doctor, models, permissions, login, logout, provider: the account and configuration commands. */
import { existsSync } from "node:fs";
import { loadConfig } from "../core/config/resolve.ts";
import { writeUserPatch } from "../core/config/settings-store.ts";
import { describePermissions, displayPermissionMode, formatPermissions } from "../core/permissions/index.ts";
import { scanSessions } from "../core/session/catalog.ts";
import { isSubscription, type Provider, providers, subscriptions } from "../providers/providers.ts";
import { CliUsageError, parseFlags } from "./global-args.ts";
import type { Io } from "./output.ts";
import { renderFailureJson } from "./output.ts";
import { loadRules } from "./runtime.ts";

export const VERSION: string = (await import("../../package.json")).default.version;

const AUTH_HELP = "nod needs a subscription. Run nod login codex (ChatGPT) or nod login grok (Grok).";
const providerLabel = (p: Provider) => subscriptions[p].label;

function jsonFlag(args: string[], usage: string): boolean {
  const { flags, positionals } = parseFlags(args, { "--json": "boolean" }, usage);
  if (positionals.length > 0) throw new CliUsageError("InvalidArgs", `usage: nod ${usage}`);
  return flags["--json"] === true;
}

export function runStatus(args: string[], io: Io): number {
  const json = jsonFlag(args, "status [--json]");
  const config = loadConfig({ workspaceRoot: io.cwd, env: io.env });
  const connected = providers.filter((p) => subscriptions[p].signedIn());
  const signedIn = subscriptions[config.provider].signedIn();
  const sessions = scanSessions({ home: config.home }).summaries.filter((s) => s.workspace_root === io.cwd);
  const latest = sessions.sort((a, b) => b.updated_at_ms - a.updated_at_ms)[0];
  const fields = {
    model: config.model ?? "",
    model_source: providerLabel(config.provider),
    update_channel: config.updateChannel,
    build_channel: "stable",
    build_revision: "",
    auth: signedIn ? `nod login ${config.provider}` : "missing",
    connected_providers: connected,
    auth_refreshable: signedIn,
    ...(signedIn ? {} : { auth_help: AUTH_HELP }),
    permission_mode: config.permissionMode,
    workspace: io.cwd,
    history_turns: latest?.history_len ?? 0,
    session_permission_grants: 0,
    agent_step_limit: config.maxAgentSteps,
  };
  if (json) {
    io.stdout(`${JSON.stringify({ kind: "status", ...fields })}\n`);
    return 0;
  }
  const lines = Object.entries(fields).map(([k, v]) => {
    const value =
      k === "permission_mode"
        ? displayPermissionMode(config.permissionMode)
        : Array.isArray(v)
          ? v.join(",")
          : String(v);
    return `[status] ${k}=${value}`;
  });
  io.stdout(`${lines.join("\n")}\n`);
  return 0;
}

type Check = { name: string; status: "ok" | "warn" | "fail"; detail: string };

export function runDoctor(args: string[], io: Io): number {
  const json = jsonFlag(args, "doctor [--json]");
  const config = loadConfig({ workspaceRoot: io.cwd, env: io.env });
  const checks: Check[] = [];
  checks.push({ name: "workspace", status: existsSync(io.cwd) ? "ok" : "fail", detail: io.cwd });
  const signedIn = subscriptions[config.provider].signedIn();
  checks.push(
    signedIn
      ? { name: "auth", status: "ok", detail: `${providerLabel(config.provider)} session saved in ${config.home}` }
      : { name: "auth", status: "fail", detail: AUTH_HELP },
  );
  const scan = scanSessions({ home: config.home });
  const latest = [...scan.summaries].sort((a, b) => b.updated_at_ms - a.updated_at_ms)[0];
  checks.push(
    scan.summaries.length === 0
      ? { name: "sessions", status: "warn", detail: "no saved sessions yet" }
      : { name: "sessions", status: "ok", detail: `${scan.summaries.length} saved session(s); latest=${latest?.id}` },
  );
  if (scan.skipped_invalid > 0)
    checks.push({ name: "sessions", status: "warn", detail: `${scan.skipped_invalid} unreadable session(s) skipped` });
  const gh = Bun.which("gh");
  checks.push(
    gh
      ? { name: "gh", status: "ok", detail: "GitHub CLI found in PATH" }
      : { name: "gh", status: "warn", detail: "GitHub CLI not found in PATH; publish workflows unavailable" },
  );
  const counts = { ok: 0, warn: 0, fail: 0 };
  for (const c of checks) counts[c.status]++;
  if (json) {
    io.stdout(
      `${JSON.stringify({
        kind: "doctor",
        ok_count: counts.ok,
        warn_count: counts.warn,
        fail_count: counts.fail,
        workspace: io.cwd,
        model: config.model ?? "",
        model_source: providerLabel(config.provider),
        auth: signedIn ? `nod login ${config.provider}` : "missing",
        auth_refreshable: signedIn,
        permission_mode: config.permissionMode,
        agent_step_limit: config.maxAgentSteps,
        checks,
      })}\n`,
    );
  } else {
    const head = [
      `[doctor] ok=${counts.ok} warn=${counts.warn} fail=${counts.fail}`,
      `[doctor] workspace=${io.cwd}`,
      `[doctor] model=${config.model ?? ""}`,
      `[doctor] model_source=${providerLabel(config.provider)}`,
      `[doctor] auth=${signedIn ? `nod login ${config.provider}` : "missing"}`,
      `[doctor] auth_refreshable=${signedIn}`,
      `[doctor] permission_mode=${displayPermissionMode(config.permissionMode)}`,
      `[doctor] agent_step_limit=${config.maxAgentSteps}`,
    ];
    io.stdout(`${[...head, ...checks.map((c) => `[${c.status}] ${c.name}: ${c.detail}`)].join("\n")}\n`);
  }
  return counts.fail > 0 ? 1 : 0;
}

export async function runModels(args: string[], io: Io): Promise<number> {
  const { flags, positionals: rest } = parseFlags(args, { "--json": "boolean" }, "models [codex|grok] [--json]");
  const json = flags["--json"] === true;
  const config = loadConfig({ workspaceRoot: io.cwd, env: io.env });
  const name = rest[0] ?? config.provider;
  if (rest.length > 1 || !isSubscription(name))
    throw new CliUsageError("InvalidArgs", "usage: nod models [codex|grok] [--json]");
  const sub = subscriptions[name];
  let ids: string[];
  try {
    if (!sub.signedIn()) throw new Error(`Not signed in. Run: nod login ${name}`);
    ids = await sub.models();
  } catch (e) {
    const message = `could not list models: ${(e as Error).message}`;
    io.stdout(json ? `${renderFailureJson("models", message, "ModelsUnavailable")}\n` : `[models] ${message}\n`);
    return 1;
  }
  if (json) {
    io.stdout(
      `${JSON.stringify({
        kind: "models",
        count: ids.length,
        shown_count: ids.length,
        more_count: 0,
        private_models_hidden: false,
        ids,
        models: ids.map((id) => ({ id, source: sub.label })),
      })}\n`,
    );
    return 0;
  }
  if (ids.length === 0) {
    io.stdout(`[models] no models returned by ${sub.label}\n`);
    return 0;
  }
  io.stdout(`[models] ${ids.length} available\n${ids.map((id) => ` - ${id} · ${sub.label}`).join("\n")}\n`);
  return 0;
}

export function runPermissions(args: string[], io: Io): number {
  const json = jsonFlag(args, "permissions [--json]");
  const config = loadConfig({ workspaceRoot: io.cwd, env: io.env });
  const snapshot = { mode: config.permissionMode, rules: loadRules(config), grants: [], workspaceRoot: io.cwd };
  io.stdout(
    json ? `${JSON.stringify(describePermissions(snapshot))}\n` : formatPermissions(snapshot, displayPermissionMode),
  );
  return 0;
}

function providerArg(args: string[], command: string): Provider {
  if (args.length > 1) throw new CliUsageError("InvalidArgs", `usage: nod ${command} [codex|grok]`);
  const name = args[0] ?? loadConfig({ workspaceRoot: process.cwd() }).provider;
  if (!isSubscription(name)) throw new CliUsageError("InvalidArgs", `Unknown provider "${name}". Use codex or grok.`);
  return name;
}

export async function runLogin(args: string[], io: Io): Promise<number> {
  const name = providerArg(args, "login");
  await subscriptions[name].login({
    print: (line) => io.stderr(`${line}\n`),
    manualCode: name === "grok" && process.stdin.isTTY ? () => promptLine("Paste the code from xAI: ") : undefined,
  });
  io.stdout(`Signed in with ${name === "codex" ? "Codex" : "Grok"}.\n`);
  return 0;
}

export async function runLogout(args: string[], io: Io): Promise<number> {
  const name = providerArg(args, "logout");
  io.stdout(`${await subscriptions[name].logout()}\n`);
  return 0;
}

export function runProvider(args: string[], io: Io): number {
  if (args.length !== 1 || !isSubscription(args[0] ?? ""))
    throw new CliUsageError("InvalidArgs", "usage: nod provider <codex|grok>");
  const name = args[0] as Provider;
  writeUserPatch(loadConfig({ workspaceRoot: io.cwd, env: io.env }).home, { provider: name });
  io.stdout(`Default provider set to ${providerLabel(name)} (${name}).\n`);
  return 0;
}

function promptLine(question: string): Promise<string> {
  return new Promise((done) => {
    process.stderr.write(question);
    let buf = "";
    const onData = (chunk: Buffer) => {
      buf += chunk.toString();
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        process.stdin.off("data", onData);
        process.stdin.pause();
        done(buf.slice(0, nl).trim());
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}
