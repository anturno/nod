/** One tool call: `● Ran bun test` with ≤3 folded output lines, or a collapsed group `● 2 tool calls · 1 read · 1 edit`. */
import { Box, Text, useAnimation } from "ink";
import { foldedOutput, groupSummary, type ToolCallView, toolHeadline } from "../core/transcript.ts";
import { C, SPINNER, SPINNER_INTERVAL } from "../theme.ts";

export function Spinner() {
  const { frame } = useAnimation({ interval: SPINNER_INTERVAL });
  return <Text color={C.accent}>{SPINNER[frame % SPINNER.length]}</Text>;
}

const statusColor = (v: ToolCallView) =>
  v.status === "failed" || v.status === "cancelled" ? C.error : v.status === "denied" ? C.warning : C.mutedForeground;

export function ToolCall({ call }: { call: ToolCallView }) {
  if (call.status === "running")
    return (
      <Text color={C.foreground}>
        <Spinner />
        {` ${call.action} ${call.target}`.trimEnd()}
      </Text>
    );
  const { lines, hidden } = foldedOutput(call);
  return (
    <Box flexDirection="column">
      <Text color={statusColor(call)}>
        {toolHeadline(call).slice(0, 2)}
        <Text color={C.foreground}>{toolHeadline(call).slice(2)}</Text>
      </Text>
      {lines.map((line, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: output lines are positional
        <Text key={i} color={C.muted} wrap="truncate-end">
          {"│ "}
          <Text color={C.mutedForeground}>{line}</Text>
        </Text>
      ))}
      {hidden > 0 && <Text color={C.muted}>{`│ (+${hidden} lines)`}</Text>}
    </Box>
  );
}

export function ToolGroup({ calls }: { calls: ToolCallView[] }) {
  return (
    <Text color={C.mutedForeground}>
      {"● "}
      <Text color={C.foreground}>{groupSummary(calls).slice(2)}</Text>
    </Text>
  );
}
