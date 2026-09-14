/** The ctrl+o screen: Review (text, tools with output, notices) or Full transcript (everything, raw), scrollable. */
import { Box, Text } from "ink";
import type { TranscriptItem } from "../core/transcript.ts";
import { transcriptLines } from "../core/transcript.ts";
import { C } from "../theme.ts";

export function FullTranscript({
  items,
  depth,
  scroll,
  rows,
}: {
  items: TranscriptItem[];
  depth: "review" | "full";
  scroll: number;
  rows: number;
}) {
  const lines = transcriptLines(items, depth);
  const height = Math.max(1, rows - 3);
  const start = Math.max(0, Math.min(scroll, Math.max(0, lines.length - height)));
  const shown = lines.slice(start, start + height);
  return (
    <Box flexDirection="column" height={rows} paddingX={1}>
      <Box>
        <Text bold color={depth === "review" ? C.accent : C.muted}>
          Review
        </Text>
        <Text color={C.muted}>{"  ·  "}</Text>
        <Text bold color={depth === "full" ? C.accent : C.muted}>
          Full transcript
        </Text>
        <Text
          color={C.muted}
        >{`    ←/→ depth · ↑↓ scroll · pgup/pgdn page · esc close    ${start + 1}-${start + shown.length}/${lines.length}`}</Text>
      </Box>
      <Box flexDirection="column" flexGrow={1} overflow="hidden">
        {shown.map((line, i) => (
          // biome-ignore lint/suspicious/noArrayIndexKey: transcript lines are positional
          <Text key={i} color={C.foreground} wrap="truncate-end">
            {line || " "}
          </Text>
        ))}
      </Box>
    </Box>
  );
}
