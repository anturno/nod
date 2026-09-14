/** The approval panel: divider · question · what will run · 1/2/3 options (tab amends) · hint. */
import { Box, Text } from "ink";
import {
  APPROVAL_HINT,
  APPROVAL_SCREEN_HINT,
  type ApprovalState,
  amendPlaceholder,
  approvalOptions,
  approvalQuestion,
  CONFIRM_HINT,
} from "../core/surfaces.ts";
import { diffText } from "../core/terminal.ts";
import { C } from "../theme.ts";

export function Approval({ state, onScreen = false }: { state: ApprovalState; onScreen?: boolean }) {
  const r = state.request;
  const options = approvalOptions(state);
  const diff = r.preparation?.diff;
  const hint = r.kind === "confirm" ? CONFIRM_HINT : onScreen ? APPROVAL_SCREEN_HINT : APPROVAL_HINT;
  return (
    <Box flexDirection="column" flexShrink={0} marginX={1} paddingX={1} borderStyle="round" borderColor={C.warning}>
      <Text bold color={C.foreground}>
        {approvalQuestion(r)}
      </Text>
      {r.kind !== "confirm" && (
        <Text color={C.accent}>{r.kind === "command" ? r.label.replace(/^shell\.run\s*/, "") : r.label}</Text>
      )}
      {r.preparation?.detail && <Text color={C.mutedForeground}>{r.preparation.detail}</Text>}
      {diff && !onScreen && <Diff text={diffText(diff)} />}
      <Box height={1} />
      {options.map((label, i) => {
        const cursor = state.choice === i;
        const amending = state.amend !== null && cursor;
        return (
          <Box key={label}>
            <Text color={C.accent}>{cursor ? "› " : "  "}</Text>
            <Text bold={cursor} color={cursor ? C.accent : C.foreground}>
              {amending ? label.slice(0, label.indexOf(",") + 2) : label}
            </Text>
            {amending && (
              <Text color={state.amend ? C.foreground : C.muted}>{state.amend || amendPlaceholder(state.choice)}</Text>
            )}
          </Box>
        );
      })}
      <Text color={C.muted}>{hint}</Text>
    </Box>
  );
}

export function Diff({ text, scroll = 0, height }: { text: string; scroll?: number; height?: number }) {
  const lines = text.split("\n");
  const shown = height === undefined ? lines : lines.slice(scroll, scroll + height);
  return (
    <Box flexDirection="column">
      {shown.map((line, i) => (
        <Text
          // biome-ignore lint/suspicious/noArrayIndexKey: diff lines are positional
          key={i}
          color={line.startsWith("+") ? C.success : line.startsWith("-") ? C.error : C.mutedForeground}
        >
          {line}
        </Text>
      ))}
    </Box>
  );
}
