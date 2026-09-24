/** `<mode> · <model> [· <effort>] [· Fast]   / commands · @ files · $ skills · ctrl+o transcript` */
import { Box, Text } from "ink";
import type { Effort, PermissionMode } from "../../core/agent/types.ts";
import { displayPermissionMode } from "../../core/permissions/index.ts";
import { CTRL_C_HINT, FULL_ACCESS_HINT } from "../core/terminal.ts";
import { C } from "../theme.ts";

export const DEFAULT_HINT = "/ commands · @ files · $ skills · ctrl+o transcript";

export function hintLeft(mode: PermissionMode, model: string, effort: Effort, fast: boolean): string {
  const parts = [displayPermissionMode(mode), model];
  if (effort !== "auto") parts.push(effort);
  if (fast) parts.push("Fast");
  return parts.join(" · ");
}

export function hintRight(o: { ctrlCArmed: boolean; mode: PermissionMode; updateLabel?: string | null }): string {
  if (o.ctrlCArmed) return CTRL_C_HINT;
  if (o.updateLabel) return o.updateLabel;
  if (o.mode === "yolo") return FULL_ACCESS_HINT;
  return DEFAULT_HINT;
}

export function HintRow(o: {
  mode: PermissionMode;
  model: string;
  effort: Effort;
  fast: boolean;
  ctrlCArmed: boolean;
  updateLabel?: string | null;
}) {
  const right = hintRight(o);
  return (
    <Box flexShrink={0} paddingX={2} justifyContent="space-between">
      <Text color={o.mode === "yolo" ? C.error : C.mutedForeground}>{hintLeft(o.mode, o.model, o.effort, o.fast)}</Text>
      <Text color={o.ctrlCArmed ? C.warning : o.mode === "yolo" ? C.error : C.muted}>{right}</Text>
    </Box>
  );
}
