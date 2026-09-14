/** Optional footer: `ctx N% · <title> · <cwd> on <branch>`, each field behind its /statusline toggle. */
import { Box, Text } from "ink";
import { C } from "../theme.ts";
import { tildify } from "./Transcript.tsx";

export function statusText(
  status: { ctx: number | null; title: string | null; cwd: string; branch: string | null },
  toggles: { context: boolean; session: boolean; workspace: boolean },
): string | null {
  const parts: string[] = [];
  if (toggles.context && status.ctx !== null) parts.push(`ctx ${status.ctx}%`);
  if (toggles.session && status.title) parts.push(status.title);
  if (toggles.workspace) parts.push(`${tildify(status.cwd)}${status.branch ? ` on ${status.branch}` : ""}`);
  return parts.length ? parts.join(" · ") : null;
}

export function StatusLine({
  status,
  toggles,
}: {
  status: Parameters<typeof statusText>[0];
  toggles: Parameters<typeof statusText>[1];
}) {
  const text = statusText(status, toggles);
  if (!text) return null;
  return (
    <Box flexShrink={0} paddingX={2}>
      <Text color={C.muted} wrap="truncate-end">
        {text}
      </Text>
    </Box>
  );
}
