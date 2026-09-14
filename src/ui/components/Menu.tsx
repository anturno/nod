/** A framed list with a cursor, optional title and tab bar: the shape every picker shares. Stateless. */
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { C } from "../theme.ts";

export type Row = { key: string; left: ReactNode; right?: ReactNode; disabled?: boolean };

export const MAX_ROWS = 8;

export function Tabs({ tabs, active }: { tabs: string[]; active: string }) {
  return (
    <Text wrap="truncate-end">
      {tabs.map((t, i) => (
        <Text key={t} color={t === active ? C.accent : C.muted} bold={t === active}>
          {i > 0 ? "  " : ""}
          {t}
        </Text>
      ))}
    </Text>
  );
}

export function Menu({
  rows,
  index,
  title,
  tabs,
  footer,
  docked = false,
  borderColor = C.border,
  maxRows = MAX_ROWS,
  empty = "nothing to choose",
}: {
  rows: Row[] | null;
  index: number;
  title?: ReactNode;
  tabs?: ReactNode;
  footer?: ReactNode;
  docked?: boolean;
  borderColor?: string;
  maxRows?: number;
  empty?: string;
}) {
  const total = rows?.length ?? 0;
  const start = Math.max(0, Math.min(index - Math.floor(maxRows / 2), total - maxRows));
  const visible = rows?.slice(start, start + maxRows) ?? [];
  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      marginX={1}
      marginTop={docked ? 0 : 1}
      borderStyle="round"
      borderBottom={!docked}
      borderColor={borderColor}
      paddingX={1}
      paddingTop={docked ? 0 : 1}
      paddingBottom={docked ? 0 : 1}
    >
      {title !== undefined && (
        <Text bold color={C.accent}>
          {title}
        </Text>
      )}
      {tabs}
      {!visible.length && <Text color={C.mutedForeground}>{rows ? empty : "loading…"}</Text>}
      {visible.map((row, i) => {
        const cursor = start + i === index;
        return (
          <Text key={row.key} wrap="truncate-end">
            <Text color={C.accent}>{cursor ? "› " : "  "}</Text>
            <Text bold={cursor} color={row.disabled ? C.muted : cursor ? C.accent : C.foreground}>
              {row.left}
            </Text>
            {row.right !== undefined && (
              <Text color={C.mutedForeground}>
                {"  "}
                {row.right}
              </Text>
            )}
          </Text>
        );
      })}
      {rows && total > visible.length && <Text color={C.muted}>{`  ${index + 1}/${total}`}</Text>}
      {footer}
    </Box>
  );
}
