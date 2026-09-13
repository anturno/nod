/** The multi-line draft with its cursor; `[Pasted text #1, 12 lines]` and `[Image #1]` tokens stand out. */
import { basename } from "node:path";
import { Box, Text } from "ink";
import type { ReactNode } from "react";
import type { Editor } from "../core/composer.ts";
import { C } from "../theme.ts";

const TOKEN = /\[(?:Pasted text #\d+, \d+ lines?|Image #\d+)\]|\$[\w-]+/g;

function colored(text: string, keyBase: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const m of text.matchAll(TOKEN)) {
    if (m.index > last) out.push(text.slice(last, m.index));
    out.push(
      <Text key={`${keyBase}-${m.index}`} color={C.accent}>
        {m[0]}
      </Text>,
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

export function Composer({
  editor,
  cwd,
  borderColor,
  docked,
  showCursor,
}: {
  editor: Editor;
  cwd: string;
  borderColor: string;
  docked: boolean;
  showCursor: boolean;
}) {
  const before = editor.text.slice(0, editor.cursor);
  const at = editor.text[editor.cursor];
  const after = editor.text.slice(editor.cursor + 1);
  const cursorChar = at === undefined || at === "\n" ? " " : at;
  return (
    <Box flexShrink={0} borderStyle="round" borderTop={!docked} borderColor={borderColor} marginX={1} paddingX={1}>
      <Text bold color={C.accent}>
        {"> "}
      </Text>
      <Text color={C.foreground}>
        {colored(before, "b")}
        {showCursor && <Text inverse>{cursorChar}</Text>}
        {at === "\n" && showCursor ? "\n" : ""}
        {showCursor ? colored(after, "a") : colored(editor.text.slice(editor.cursor), "a")}
        {!editor.text && <Text color={C.muted}>{`Ask about ${basename(cwd)}...`}</Text>}
      </Text>
    </Box>
  );
}
