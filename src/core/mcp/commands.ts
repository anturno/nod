/** `/mcp ...` and `nod mcp ...`: one command handler, text output. */
import {
  loadProfile,
  McpConfigError,
  profilePath,
  removeProfileServer,
  renderProfileWarning,
  saveProfileServer,
} from "./config.ts";
import { readCredentials } from "./oauth.ts";
import { applyTrust, loadProjectServers, type TrustAction } from "./project.ts";
import { authenticateServer, createMcpRuntime, logoutServer, type McpRuntimeDeps } from "./runtime.ts";
import type { McpRuntime, McpServerHealth } from "./types.ts";

export type McpCommandContext = {
  home: string;
  workspaceRoot: string;
  env: Record<string, string | undefined>;
  openUrl(url: string): void | Promise<void>;
  interactive: boolean;
  /** The live runtime of an interactive session; commands that change configuration reload it. */
  runtime?: McpRuntime;
  fetch?: typeof fetch;
  version?: string;
};

export type McpCommandResult = { ok: boolean; text: string };

export const MCP_USAGE = "usage: /mcp [list|resource|prompt|add|remove|path|reload|auth|logout|trust]";
const ADD_USAGE = "usage: /mcp add <name> <command> [args...] or /mcp add --transport http <name> <url>";

const line = (ok: boolean, text: string): McpCommandResult => ({ ok, text });
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const errorText = (e: unknown) => (e instanceof Error ? e.message : String(e));

function runtimeDeps(ctx: McpCommandContext): McpRuntimeDeps {
  return {
    home: ctx.home,
    workspaceRoot: ctx.workspaceRoot,
    env: ctx.env,
    openUrl: ctx.openUrl,
    interactive: ctx.interactive,
    fetch: ctx.fetch,
    version: ctx.version,
  };
}

/** Uses the live runtime, or starts a temporary one that is closed afterwards. */
async function withRuntime<T>(ctx: McpCommandContext, fn: (runtime: McpRuntime) => Promise<T>): Promise<T> {
  if (ctx.runtime) return fn(ctx.runtime);
  const runtime = createMcpRuntime(runtimeDeps(ctx));
  try {
    await runtime.start();
    await runtime.settle();
    return await fn(runtime);
  } finally {
    await runtime.close();
  }
}

function authLabel(ctx: McpCommandContext, h: Pick<McpServerHealth, "name" | "state">, bearerEnv?: string): string {
  if (h.state === "unauthenticated") return "required";
  if (bearerEnv) return "env";
  return readCredentials(ctx.home).entries[h.name] ? "stored" : "none";
}

export function renderHealth(ctx: McpCommandContext, runtime: McpRuntime): string {
  const health = runtime.health();
  const diagnostics = runtime.diagnostics();
  if (health.length === 0 && diagnostics.length === 0) return "No MCP servers configured.";
  const bearer = new Map(
    [
      ...loadProfile(ctx.home).servers,
      ...loadProjectServers({ home: ctx.home, workspaceRoot: ctx.workspaceRoot, env: ctx.env }).servers,
    ].map((c) => [c.name, c.bearer_token_env]),
  );
  const out: string[] = [];
  if (health.length > 0) out.push(`MCP health (${plural(health.length, "server")}):`);
  for (const h of health) {
    out.push(
      `  ${h.name} source=${h.source} policy=${h.required ? "required" : "optional"} transport=${h.transport} state=${h.state} auth=${authLabel(ctx, h, bearer.get(h.name))}`,
    );
    if (h.admission) out.push(`    admission=${h.admission}`);
    out.push(
      `    negotiated_name=${h.serverName ?? "unavailable"} negotiated_version=${h.serverVersion ?? "unavailable"} protocol=${h.protocolVersion ?? "unavailable"}`,
    );
    const count = (n?: number) => (n === undefined ? "unavailable" : String(n));
    out.push(
      `    tools=${count(h.counts.tools)} resources=${count(h.counts.resources)} templates=${count(h.counts.templates)} prompts=${count(h.counts.prompts)}`,
    );
    out.push(`    retry_attempt=${h.restarts} retry_in_ms=${h.retryInMs ?? "none"}`);
    if (h.failure) out.push(`    failure=${h.failure}`);
  }
  if (diagnostics.length > 0) out.push("Project MCP configuration errors:", ...diagnostics.map((d) => `  ${d}`));
  return out.join("\n");
}

/** Configuration and stored authentication without connecting anything. */
export function renderConfiguration(ctx: McpCommandContext): string {
  const profile = loadProfile(ctx.home);
  const project = loadProjectServers({ home: ctx.home, workspaceRoot: ctx.workspaceRoot, env: ctx.env });
  const names = new Set(profile.servers.map((s) => s.name));
  const servers = [...profile.servers, ...project.servers.filter((s) => !names.has(s.name))];
  const issues = [
    ...(profile.error ? [`MCP config error: ${profile.error}`] : []),
    ...profile.issues,
    ...project.issues,
  ];
  const out: string[] = [];
  if (servers.length === 0 && issues.length === 0 && !profile.warning) return "No MCP servers configured.";
  if (servers.length > 0) out.push(`MCP configuration (${plural(servers.length, "server")}):`);
  for (const c of servers) {
    const state = !c.enabled ? "disabled" : (c.admission ?? "configured");
    out.push(
      `  ${c.name} source=${c.source} policy=${c.required ? "required" : "optional"} transport=${c.type} state=${state} auth=${authLabel(ctx, { name: c.name, state: "starting" }, c.bearer_token_env)} connection=not_checked`,
    );
    if (c.admission) out.push(`    admission=${c.admission}`);
  }
  if (issues.length > 0) out.push("Project MCP configuration errors:", ...issues.map((d) => `  ${d}`));
  if (profile.warning) out.push(renderProfileWarning(profile.warning));
  return out.join("\n");
}

async function reloadIfLive(ctx: McpCommandContext, text: string): Promise<McpCommandResult> {
  if (!ctx.runtime) return line(true, text);
  const result = await ctx.runtime.reload();
  return result.ok
    ? line(true, text)
    : line(
        false,
        `${text}\nMCP reload kept the previous servers:\n${result.diagnostics.map((d) => `  ${d}`).join("\n")}`,
      );
}

export async function runMcpCommand(argv: string[], ctx: McpCommandContext): Promise<McpCommandResult> {
  const [command = "list", ...rest] = argv;
  switch (command) {
    case "list": {
      const connect = rest.includes("--connect");
      if (rest.some((a) => a !== "--connect")) return line(false, "usage: /mcp list [--connect]");
      if (!connect && !ctx.runtime) return line(true, renderConfiguration(ctx));
      return line(true, await withRuntime(ctx, async (runtime) => renderHealth(ctx, runtime)));
    }
    case "path":
      return line(true, profilePath(ctx.home));
    case "add": {
      try {
        let warning: ReturnType<typeof saveProfileServer>;
        let name: string;
        if (rest[0] === "--transport") {
          const [, transport, n, url, ...extra] = rest;
          if (transport !== "http" || !n || !url || extra.length) return line(false, ADD_USAGE);
          name = n;
          warning = saveProfileServer(ctx.home, { name, url });
        } else {
          const [n, ...command] = rest;
          if (!n || command.length === 0) return line(false, ADD_USAGE);
          name = n;
          warning = saveProfileServer(ctx.home, { name, command });
        }
        const saved = `Saved MCP server '${name}'.`;
        return reloadIfLive(ctx, warning ? `${renderProfileWarning(warning)}\n${saved}` : saved);
      } catch (e) {
        return line(false, `Failed to save MCP server config: ${errorText(e)}`);
      }
    }
    case "remove": {
      const [name, ...extra] = rest;
      if (!name || extra.length) return line(false, "usage: /mcp remove <name>");
      try {
        if (!removeProfileServer(ctx.home, name)) return line(false, `MCP server '${name}' not found.`);
      } catch (e) {
        return line(false, `Failed to remove MCP server '${name}': ${errorText(e)}.`);
      }
      return reloadIfLive(ctx, `Removed MCP server '${name}'.`);
    }
    case "reload": {
      if (!ctx.runtime) return line(true, await withRuntime(ctx, async (runtime) => renderHealth(ctx, runtime)));
      const result = await ctx.runtime.reload();
      if (result.ok) return line(true, `Reloaded MCP configuration.\n${renderHealth(ctx, ctx.runtime)}`);
      return line(
        false,
        `MCP reload kept the previous servers:\n${result.diagnostics.map((d) => `  ${d}`).join("\n")}`,
      );
    }
    case "auth": {
      const [name, ...flags] = rest;
      if (!name || flags.some((f) => f !== "--open")) return line(false, "usage: /mcp auth <name> [--open]");
      if (!flags.includes("--open"))
        return line(false, `Run /mcp auth ${name} --open to confirm opening your browser.`);
      if (!ctx.interactive) return line(false, "Interactive MCP authentication is unavailable here.");
      try {
        await withRuntime(ctx, (runtime) => authenticateServer(runtime, name, runtimeDeps(ctx)));
        return line(true, `MCP authentication for '${name}' completed.`);
      } catch (e) {
        return line(false, `MCP authentication for '${name}' failed: ${errorText(e)}.`);
      }
    }
    case "logout": {
      const [name, ...extra] = rest;
      if (!name || extra.length) return line(false, "usage: /mcp logout <name>");
      const result = await logoutServer(ctx.home, name, ctx.fetch);
      if (!result.found) return line(false, `No stored MCP credentials found for '${name}'.`);
      const base = result.revoked
        ? `Logged out of MCP server '${name}'.`
        : `Logged out of MCP server '${name}' locally; remote revocation failed.`;
      const purged =
        result.purged > 0
          ? ` Removed ${result.purged} unreadable MCP credential ${result.purged === 1 ? "entry" : "entries"}.`
          : "";
      if (ctx.runtime) await ctx.runtime.reload();
      return line(true, base + purged);
    }
    case "trust": {
      const [action, name, ...extra] = rest;
      const usage = "usage: /mcp trust approve|reject <server> | approve-all | reset";
      if (!action || extra.length) return line(false, usage);
      if (action === "approve-all" || action === "reset") {
        if (name) return line(false, `usage: /mcp trust ${action}`);
        applyTrust(ctx.home, ctx.workspaceRoot, action);
        return reloadIfLive(
          ctx,
          action === "approve-all"
            ? "Approving all project MCP servers for this workspace."
            : "Resetting project MCP choices for this workspace.",
        );
      }
      if (action !== "approve" && action !== "reject") return line(false, usage);
      if (!name) return line(false, "usage: /mcp trust approve|reject <server>");
      try {
        applyTrust(ctx.home, ctx.workspaceRoot, action as TrustAction, name);
      } catch (e) {
        return line(false, e instanceof McpConfigError ? e.message : errorText(e));
      }
      return reloadIfLive(ctx, `${action === "approve" ? "Approving" : "Rejecting"} project MCP server '${name}'.`);
    }
    case "resource":
    case "prompt":
      return featureCommand(command, rest, ctx);
    default:
      return line(false, MCP_USAGE);
  }
}

async function featureCommand(
  kind: "resource" | "prompt",
  rest: string[],
  ctx: McpCommandContext,
): Promise<McpCommandResult> {
  const [action, server, ...args] = rest;
  const usage =
    kind === "resource"
      ? "usage: /mcp resource [list|templates|read|complete] ..."
      : "usage: /mcp prompt [list|get|complete] ...";
  let request: Record<string, unknown> | undefined;
  let label = "";
  if (kind === "resource") {
    if (action === "list" || action === "templates") {
      if (!server || args.length)
        return line(false, "usage: /mcp resource list <server> or /mcp resource templates <server>");
      request = { action: action === "list" ? "resource_list" : "resource_templates", server };
      label = "MCP resource listing";
    } else if (action === "read") {
      if (!server || args.length !== 1) return line(false, "usage: /mcp resource read <server> <uri>");
      request = { action: "resource_read", server, uri: args[0] };
      label = "MCP resource read";
    } else if (action === "complete") {
      if (!server || args.length < 2 || args.length > 3)
        return line(false, "usage: /mcp resource complete <server> <uri-template> <variable> [value]");
      request = { action: "resource_complete", server, uri_template: args[0], argument: args[1], value: args[2] ?? "" };
      label = "MCP resource completion";
    } else return line(false, usage);
  } else {
    if (action === "list") {
      if (!server || args.length) return line(false, "usage: /mcp prompt list <server>");
      request = { action: "prompt_list", server };
      label = "MCP prompt listing";
    } else if (action === "get") {
      if (!server || args.length < 1 || args.length > 2)
        return line(false, "usage: /mcp prompt get <server> <name> [arguments-json]");
      let parsed: unknown = {};
      if (args[1] !== undefined) {
        try {
          parsed = JSON.parse(args[1]);
        } catch {
          return line(false, "MCP prompt invocation failed: arguments must be a JSON object.");
        }
      }
      request = { action: "prompt_get", server, prompt: args[0], arguments: parsed };
      label = "MCP prompt invocation";
    } else if (action === "complete") {
      if (!server || args.length < 2 || args.length > 3)
        return line(false, "usage: /mcp prompt complete <server> <name> <argument> [value]");
      request = { action: "prompt_complete", server, prompt: args[0], argument: args[1], value: args[2] ?? "" };
      label = "MCP prompt completion";
    } else return line(false, usage);
  }
  const req = request;
  const result = await withRuntime(ctx, (runtime) => runtime.features(req));
  if (result.status !== "success") {
    let reason = result.output;
    try {
      reason = (JSON.parse(result.output) as { error?: { message?: string } }).error?.message ?? reason;
    } catch {
      // Plain text already.
    }
    return line(false, `${label} failed: ${reason}`);
  }
  return line(true, JSON.stringify(JSON.parse(result.output), null, 2));
}
