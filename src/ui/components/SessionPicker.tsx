/** `nod -r` / `/resume`: `Sessions N`, workspace scope toggle, rows `title … workspace · age · N turns`, `d` deletes. */
import { basename } from "node:path";
import { Text } from "ink";
import { FALLBACK_TITLE } from "../../core/session/events.ts";
import type { Surface } from "../core/terminal.ts";
import { C } from "../theme.ts";
import { Menu } from "./Menu.tsx";

/** `8m`, `3h`, `2d`, `5w`. */
export function age(ms: number, now: number): string {
  const s = Math.max(0, Math.floor((now - ms) / 1000));
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h`;
  const d = Math.floor(h / 24);
  return d < 7 ? `${d}d` : `${Math.floor(d / 7)}w`;
}

export function SessionPicker({ surface, now }: { surface: Extract<Surface, { kind: "sessions" }>; now: number }) {
  const rows = surface.rows;
  const meta = rows.map(
    (r) =>
      `${basename(r.workspace_root)} · ${age(r.updated_at_ms, now)} · ${r.history_len} ${r.history_len === 1 ? "turn" : "turns"}`,
  );
  const width = Math.max(0, ...meta.map((m) => m.length));
  const confirm = surface.confirm ? rows.find((r) => r.id === surface.confirm) : undefined;
  return (
    <Menu
      title={`Sessions ${rows.length}`}
      tabs={<Text color={C.mutedForeground}>{surface.scope === "all" ? "All workspaces" : "Current workspace"}</Text>}
      index={surface.index}
      rows={rows.map((r, i) => ({
        key: r.id,
        left: r.title ?? FALLBACK_TITLE,
        right: <Text color={C.mutedForeground}>{(meta[i] as string).padStart(width)}</Text>,
      }))}
      empty="no saved sessions"
      footer={
        confirm ? (
          <Text color={C.warning}>{`Delete ${confirm.title ?? FALLBACK_TITLE}?  1. Confirm  2. Cancel`}</Text>
        ) : (
          <Text color={C.muted}>enter resume · tab scope · d delete · esc close</Text>
        )
      }
    />
  );
}
