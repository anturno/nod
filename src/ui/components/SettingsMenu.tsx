/** `/settings`: `Settings N`, tabs All Interface Agent Notifications Advanced, label … value; enter/←/→ change. */
import { Text } from "ink";
import { SETTINGS_TABS, type Surface } from "../core/terminal.ts";
import { C } from "../theme.ts";
import { Menu, Tabs } from "./Menu.tsx";

export function SettingsMenu({ surface }: { surface: Extract<Surface, { kind: "settings" }> }) {
  const rows = surface.rows.filter((r) => !surface.tab || r.category === surface.tab);
  const width = Math.max(0, ...rows.map((r) => r.label.length));
  return (
    <Menu
      title={`Settings ${rows.length}`}
      tabs={<Tabs tabs={SETTINGS_TABS.map((t) => t ?? "All")} active={surface.tab ?? "All"} />}
      index={surface.index}
      rows={rows.map((r) => ({
        key: r.key,
        left: r.label.padEnd(width),
        right: <Text color={C.accent}>{r.value}</Text>,
      }))}
      footer={<Text color={C.muted}>←/→ change · enter toggle · tab category · esc close</Text>}
    />
  );
}
