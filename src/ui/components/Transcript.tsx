/** The scrolling transcript: welcome, user lines, markdown, reasoning tail, tool calls and groups, notices. */
import { homedir } from "node:os";
import { Box, type DOMElement, measureElement, Text } from "ink";
import { useRef } from "react";
import { SLASH } from "../../cli/commands.ts";
import { type DisplayItem, groupItems, NOTICE_GLYPH, REASONING_TAIL, type TranscriptItem } from "../core/transcript.ts";
import { Markdown } from "../markdown.tsx";
import { C } from "../theme.ts";
import { ToolCall, ToolGroup } from "./ToolCall.tsx";

const home = homedir();
export const tildify = (path: string) =>
  path === home || path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;

export function Welcome({ cwd, branch, version }: { cwd: string; branch: string | null; version: string }) {
  const welcome = SLASH.filter((s) => s.welcome)
    .map((s) => s.command)
    .join(" · ");
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box flexDirection="column" borderStyle="round" borderColor={C.border} paddingX={2}>
        <Text color={C.mutedForeground}>
          <Text color={C.accent}>{"✻ "}</Text>
          <Text bold color={C.foreground}>
            nod
          </Text>
          {`  v${version}`}
        </Text>
        <Text color={C.mutedForeground}>
          {tildify(cwd)}
          {branch && <Text color={C.muted}>{`  on ${branch}`}</Text>}
        </Text>
      </Box>
      <Box marginTop={1}>
        <Text color={C.muted}>{welcome}</Text>
      </Box>
    </Box>
  );
}

function Marked({ marker, color, children }: { marker: string; color: string; children: string }) {
  return (
    <Box>
      <Box width={2} flexShrink={0}>
        <Text color={color}>{marker}</Text>
      </Box>
      <Text color={color === C.muted ? C.mutedForeground : color}>{children}</Text>
    </Box>
  );
}

const NOTICE_COLOR = { success: C.success, error: C.error, info: C.muted, warning: C.warning, denied: C.warning };

export function Item({ item }: { item: DisplayItem }) {
  switch (item.type) {
    case "group":
      return <ToolGroup calls={item.calls} />;
    case "user":
      return (
        <Box>
          <Box width={2} flexShrink={0}>
            <Text color={C.muted}>{">"}</Text>
          </Box>
          <Text color={item.queued ? C.muted : C.mutedForeground}>
            {item.text}
            {item.queued && <Text color={C.muted}>{"  queued"}</Text>}
          </Text>
        </Box>
      );
    case "notice":
      return (
        <Marked marker={NOTICE_GLYPH[item.tone]} color={NOTICE_COLOR[item.tone]}>
          {item.topic ? `${item.topic}: ${item.text}` : item.text}
        </Marked>
      );
    case "text":
      return <Markdown text={item.text} />;
    case "reasoning": {
      if (!item.streaming) return null;
      const shown = item.text.slice(-REASONING_TAIL);
      return <Text color={C.muted}>{shown.length < item.text.length ? `…${shown}` : shown}</Text>;
    }
    case "tool":
      return <ToolCall call={item.call} />;
    case "done":
      return null;
  }
}

export function Transcript({
  items,
  collapse,
  scroll,
  cwd,
  branch,
  version,
}: {
  items: TranscriptItem[];
  collapse: boolean;
  scroll: number;
  cwd: string;
  branch: string | null;
  version: string;
}) {
  const viewport = useRef<DOMElement>(null);
  const content = useRef<DOMElement>(null);
  const visible = groupItems(items, collapse).filter(
    (i) => i.type !== "done" && !(i.type === "reasoning" && !i.streaming),
  );
  const max =
    viewport.current && content.current
      ? Math.max(0, measureElement(content.current).height - measureElement(viewport.current).height)
      : scroll;
  const offset = Math.min(scroll, max);
  return (
    <Box
      ref={viewport}
      flexGrow={1}
      flexShrink={1}
      minHeight={1}
      overflow="hidden"
      flexDirection="column"
      justifyContent="flex-end"
      paddingX={2}
    >
      <Box ref={content} flexDirection="column" flexShrink={0} marginBottom={-offset}>
        <Welcome cwd={cwd} branch={branch} version={version} />
        {visible.map((item, i) => {
          const next = visible[i + 1];
          const tight =
            (item.type === "tool" || item.type === "group") && (next?.type === "tool" || next?.type === "group");
          return (
            <Box key={item.id} flexDirection="column" marginBottom={tight ? 0 : 1}>
              <Item item={item} />
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}
