/** The `@` file picker and the `$` skill picker: up to 8 rows, enter inserts. */
import { Text } from "ink";
import type { Skill } from "../../core/skills/types.ts";
import { C } from "../theme.ts";
import { Menu } from "./Menu.tsx";

export function FilePicker({ rows, index, borderColor }: { rows: string[]; index: number; borderColor: string }) {
  return (
    <Menu
      docked
      borderColor={borderColor}
      title="Files"
      index={Math.min(index, Math.max(0, rows.length - 1))}
      rows={rows.map((path) => ({ key: path, left: path }))}
      empty="no matching files"
    />
  );
}

export function SkillPicker({ rows, index, borderColor }: { rows: Skill[]; index: number; borderColor: string }) {
  return (
    <Menu
      docked
      borderColor={borderColor}
      title="Skills"
      index={Math.min(index, Math.max(0, rows.length - 1))}
      rows={rows.map((s) => ({
        key: s.location,
        left: `$${s.name}`,
        right: <Text color={C.mutedForeground}>{s.description}</Text>,
      }))}
      empty="no matching skills"
    />
  );
}
