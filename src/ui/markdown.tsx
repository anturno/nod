/** The subset of Markdown a coding agent writes, drawn the way the anturno CLI draws it. */
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { C } from "./theme.ts";

const INLINE = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|\[(.+?)\]\((.+?)\))/g;

/** One text node per line, so a paragraph with a bold word in it still wraps as one paragraph. */
function Inline({ line }: { line: string }) {
  const runs: ReactNode[] = [];
  let last = 0;
  for (const match of line.matchAll(INLINE)) {
    if (match.index > last) runs.push(line.slice(last, match.index));
    const [full] = match;
    const key = runs.length;
    if (full.startsWith("**"))
      runs.push(
        <Text key={key} bold>
          {match[2]}
        </Text>,
      );
    else if (full.startsWith("*"))
      runs.push(
        <Text key={key} italic>
          {match[3]}
        </Text>,
      );
    // A step down the neutral ramp, not a hue: answers have enough backticks that coloring them would make code the loudest thing on screen.
    else if (full.startsWith("`"))
      runs.push(
        <Text key={key} color={C.mutedForeground}>
          {match[4]}
        </Text>,
      );
    else
      runs.push(
        <Text key={key} color={C.accent} underline>
          {match[5]}
        </Text>,
      );
    last = match.index + full.length;
  }
  if (last < line.length) runs.push(line.slice(last));
  return <Text color={C.foreground}>{runs}</Text>;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    const key = blocks.length;
    // Fenced code sits on a hairline rail; the language tag is dropped.
    if (/^\s*```[\w-]*\s*$/.test(line)) {
      const body: string[] = [];
      while (++i < lines.length && !/^\s*```\s*$/.test(lines[i]!)) body.push(lines[i]!);
      blocks.push(
        <Box
          key={key}
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderColor={C.border}
          paddingLeft={1}
        >
          <Text color={C.foreground}>{body.join("\n")}</Text>
        </Box>,
      );
      continue;
    }
    const heading = line.match(/^#{1,6}\s+(.*)$/);
    const item = line.match(/^(\s*)([-*+]|\d+\.)\s+(.*)$/);
    if (heading)
      blocks.push(
        <Text key={key} bold color={C.foreground}>
          {heading[1]}
        </Text>,
      );
    else if (item) {
      const marker = /\d/.test(item[2]!) ? item[2]! : "•";
      blocks.push(
        <Box key={key} paddingLeft={item[1]!.length >= 2 ? 2 : 0}>
          <Box width={marker.length + 1} flexShrink={0}>
            <Text color={C.mutedForeground}>{marker}</Text>
          </Box>
          <Inline line={item[3]!} />
        </Box>,
      );
    } else if (!line.trim()) blocks.push(<Box key={key} height={1} />);
    else blocks.push(<Inline key={key} line={line} />);
  }
  return <Box flexDirection="column">{blocks}</Box>;
}
