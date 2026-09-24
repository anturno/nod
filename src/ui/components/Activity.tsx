/** `• Thinking (12s) (↑10 ↓20)`: re-rendered every second while a turn runs. */
import { Box, Text, useAnimation } from "ink";
import type { Usage } from "../../core/agent/types.ts";
import { type Activity as ActivityState, activityLabel } from "../core/activity.ts";
import { C } from "../theme.ts";
import { Spinner } from "./ToolCall.tsx";

export function Activity({ activity, usage, now }: { activity: ActivityState; usage: Usage; now: () => number }) {
  useAnimation({ interval: 1000 });
  const label = activityLabel(activity, now(), usage);
  return (
    <Box flexShrink={0} paddingX={2}>
      {activity.phase === "asking" ? (
        <Text color={C.accent}>{label}</Text>
      ) : (
        <Text color={C.mutedForeground}>
          <Spinner />
          {label.slice(1)}
        </Text>
      )}
    </Box>
  );
}
