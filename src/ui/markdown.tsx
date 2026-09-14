/** The Markdown a coding agent writes: headings, lists, quotes, rules, fenced code, box-drawn tables, OSC 8 links. */
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { C } from "./theme.ts";

const INLINE = /(\*\*(.+?)\*\*|\*(.+?)\*|`(.+?)`|\[(.+?)\]\((.+?)\))/g;

/** OSC 8 hyperlink: terminals that support it make the text clickable, others show the text. */
export const osc8 = (text: string, url: string) => `\x1b]8;;${url}\x07${text}\x1b]8;;\x07`;

/** One text node per line, so a paragraph with a bold word in it still wraps as one paragraph. */
export function Inline({ line, color = C.foreground }: { line: string; color?: string }) {
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
    else if (full.startsWith("`"))
      runs.push(
        <Text key={key} color={C.mutedForeground}>
          {match[4]}
        </Text>,
      );
    else
      runs.push(
        <Text key={key} color={C.accent} underline>
          {osc8(match[5] as string, match[6] as string)}
        </Text>,
      );
    last = match.index + full.length;
  }
  if (last < line.length) runs.push(line.slice(last));
  return <Text color={color}>{runs}</Text>;
}

const isTableRow = (line: string) => /^\s*\|.*\|\s*$/.test(line);
const isSeparator = (line: string) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(line);
const cells = (line: string) =>
  line
    .trim()
    .replace(/^\||\|$/g, "")
    .split("|")
    .map((c) => c.trim());

/** Box-drawn table: header, a rule, then rows; columns sized to the widest cell. */
export function renderTable(lines: string[]): string[] {
  const rows = lines.filter((l) => !isSeparator(l)).map(cells);
  const width = Math.max(...rows.map((r) => r.length));
  const widths = Array.from({ length: width }, (_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
  const line = (l: string, m: string, r: string) => l + widths.map((w) => "─".repeat(w + 2)).join(m) + r;
  const row = (r: string[]) => `│${widths.map((w, i) => ` ${(r[i] ?? "").padEnd(w)} `).join("│")}│`;
  const out = [line("┌", "┬", "┐"), row(rows[0] ?? [])];
  if (rows.length > 1) out.push(line("├", "┼", "┤"), ...rows.slice(1).map(row));
  out.push(line("└", "┴", "┘"));
  return out;
}

export function Markdown({ text }: { text: string }) {
  const lines = text.split("\n");
  const blocks: ReactNode[] = [];
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;
    const key = blocks.length;
    if (/^\s*```/.test(line)) {
      const body: string[] = [];
      while (++i < lines.length && !/^\s*```\s*$/.test(lines[i] as string)) body.push(lines[i] as string);
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
    if (isTableRow(line)) {
      const table = [line];
      while (i + 1 < lines.length && isTableRow(lines[i + 1] as string)) table.push(lines[++i] as string);
      blocks.push(
        <Text key={key} color={C.foreground}>
          {renderTable(table).join("\n")}
        </Text>,
      );
      continue;
    }
    const heading = line.match(/^(#{1,6})\s+(.*)$/);
    const item = line.match(/^(\s*)([-*+]|\d+[.)])\s+(.*)$/);
    const quote = line.match(/^\s*>\s?(.*)$/);
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line))
      blocks.push(
        <Text key={key} color={C.border}>
          {"─".repeat(40)}
        </Text>,
      );
    else if (heading) {
      const title = heading[2] as string;
      blocks.push(
        <Box key={key} flexDirection="column">
          <Text bold color={C.foreground}>
            {title}
          </Text>
          {heading[1]!.length <= 2 && <Text color={C.border}>{"─".repeat(Math.min(60, title.length))}</Text>}
        </Box>,
      );
    } else if (quote)
      blocks.push(
        <Box key={key}>
          <Text color={C.border}>{"▎ "}</Text>
          <Inline line={quote[1] as string} color={C.mutedForeground} />
        </Box>,
      );
    else if (item) {
      const marker = /\d/.test(item[2] as string) ? (item[2] as string) : "•";
      blocks.push(
        <Box key={key} paddingLeft={(item[1] as string).length >= 2 ? 2 : 0}>
          <Box width={marker.length + 1} flexShrink={0}>
            <Text color={C.mutedForeground}>{marker}</Text>
          </Box>
          <Inline line={item[3] as string} />
        </Box>,
      );
    } else if (!line.trim()) blocks.push(<Box key={key} height={1} />);
    else blocks.push(<Inline key={key} line={line} />);
  }
  return <Box flexDirection="column">{blocks}</Box>;
}
