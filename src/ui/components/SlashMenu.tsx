/** The `/` menu: `Commands N`, category tabs, command + description rows, docked over the composer. */
import { Text } from "ink";
import { SLASH_TABS, type SlashTab, slashRows, slashTitle, tabLabel } from "../core/commands.ts";
import { C } from "../theme.ts";
import { Menu, Tabs } from "./Menu.tsx";

export function SlashMenu({
  prefix,
  tab,
  index,
  categories,
  borderColor,
}: {
  prefix: string;
  tab: SlashTab;
  index: number;
  categories: boolean;
  borderColor: string;
}) {
  const rows = slashRows(prefix, categories ? tab : null);
  // Column for the descriptions: long help strings (/allowlist …) truncate rather than push them off screen.
  const width = Math.min(28, Math.max(0, ...rows.map((r) => r.help.length)));
  return (
    <Menu
      docked
      borderColor={borderColor}
      title={slashTitle(rows.length)}
      tabs={categories ? <Tabs tabs={SLASH_TABS.map(tabLabel)} active={tabLabel(tab)} /> : undefined}
      index={Math.min(index, Math.max(0, rows.length - 1))}
      rows={rows.map((r) => ({
        key: r.command,
        left: r.help.length > width ? `${r.help.slice(0, width - 1)}…` : r.help.padEnd(width),
        right: <Text color={C.mutedForeground}>{r.description}</Text>,
      }))}
      empty="no matching commands"
    />
  );
}
