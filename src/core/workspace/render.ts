/** Text and JSON output of `nod workspace …`. */
import { MAX_ADDITIONAL_DIRECTORIES } from "./access.ts";
import type { WorkspaceResult } from "./commands.ts";

// ponytail: control characters become U+FFFD; invalid UTF-8 cannot be escaped since JS strings cannot carry it.
const safe = (raw: string) =>
  Array.from(raw, (c) => (c.charCodeAt(0) < 0x20 || c.charCodeAt(0) === 0x7f ? "\uFFFD" : c)).join("");

export function renderWorkspace(result: WorkspaceResult, format: "text" | "json"): string {
  return format === "json" ? renderJson(result) : renderText(result);
}

function renderText({ primary, savedSuppressed, entries, mutation }: WorkspaceResult): string {
  let out = `[workspace] primary=${safe(primary)}\n`;
  out += `[workspace] saved_suppressed=${savedSuppressed} limit=${MAX_ADDITIONAL_DIRECTORIES}\n`;
  if (mutation) {
    out += `[workspace] ${mutation.action}`;
    if (mutation.path !== undefined) out += ` ${safe(mutation.path)}`;
    out += ` saved_changed=${mutation.savedChanged} runtime_changed=${mutation.runtimeChanged} launch_flag_can_restore=${mutation.launchFlagCanRestore}\n`;
    if (mutation.launchFlagCanRestore)
      out += "[workspace] warning: repeating --add-dir can restore removed access on the next launch\n";
  }
  if (entries.length === 0) return `${out}[workspace] additional directories: (none)\n`;
  out += "[workspace] additional directories:\n";
  for (const e of entries)
    out += ` - ${safe(e.path)} saved=${e.saved} command_line=${e.commandLine} available=${e.available} active=${e.active}\n`;
  return out;
}

function renderJson({ primary, savedSuppressed, entries, mutation }: WorkspaceResult): string {
  const json: Record<string, unknown> = {
    kind: "workspace",
    action: mutation?.action ?? "list",
    changed: mutation ? mutation.savedChanged || mutation.runtimeChanged : false,
    primary_directory: primary,
    saved_suppressed: savedSuppressed,
    limit: MAX_ADDITIONAL_DIRECTORIES,
  };
  if (mutation) {
    if (mutation.path !== undefined) json.path = mutation.path;
    json.saved_changed = mutation.savedChanged;
    json.runtime_changed = mutation.runtimeChanged;
    json.launch_flag_can_restore = mutation.launchFlagCanRestore;
  }
  json.additional_directories = entries.map((e) => ({
    path: e.path,
    saved: e.saved,
    command_line: e.commandLine,
    available: e.available,
    active: e.active,
  }));
  return JSON.stringify(json);
}
