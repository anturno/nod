/** A list with a cursor: the slash commands and the model picker. Stateless; the shell owns the keys. */
import { Box, Text } from "ink";
import { C } from "../theme.ts";

export type Row = { value: string; hint?: string; shortcut?: string; disabled?: boolean };

const MAX_ROWS = 8;

/** Moves the cursor, skipping disabled rows and stopping at the ends. */
export function step(rows: Row[], from: number, by: 1 | -1): number {
  let next = from + by;
  while (rows[next]?.disabled) next += by;
  return rows[next] ? next : from;
}

/** `rows` is null while loading. `docked` draws it as the top half of the composer's box. */
export function Menu({
  rows,
  index,
  title,
  docked = false,
  borderColor = C.border,
}: {
  rows: Row[] | null;
  index: number;
  title?: string;
  docked?: boolean;
  borderColor?: string;
}) {
  const start = Math.max(0, Math.min(index - MAX_ROWS / 2, (rows?.length ?? 0) - MAX_ROWS));
  const visible = rows?.slice(start, start + MAX_ROWS) ?? [];
  const width = Math.max(0, ...visible.map((r) => r.value.length));
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
      paddingTop={1}
      paddingBottom={docked ? 0 : 1}
    >
      {title && (
        <Text bold color={C.accent}>
          {title}
        </Text>
      )}
      {!visible.length && <Text color={C.mutedForeground}>{rows ? "nothing to choose" : "loading…"}</Text>}
      {visible.map((row, i) => {
        const cursor = start + i === index;
        return (
          <Box key={row.value}>
            <Text color={C.accent}>{cursor ? "› " : "  "}</Text>
            <Text bold={cursor} color={row.disabled ? C.muted : cursor ? C.accent : C.foreground}>
              {row.value.padEnd(width)}
            </Text>
            <Box flexGrow={1} marginLeft={2}>
              <Text color={C.mutedForeground} wrap="truncate-end">
                {row.hint}
              </Text>
            </Box>
            {row.shortcut && <Text color={C.muted}>{row.shortcut}</Text>}
          </Box>
        );
      })}
      {rows && rows.length > visible.length && <Text color={C.muted}>{`  ${index + 1}/${rows.length}`}</Text>}
    </Box>
  );
}
