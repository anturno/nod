/** recovery.json: the in-flight turn a crash or provider failure left behind; removed once continued or archived. */
import { readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import type { UserTurn } from "../agent/types.ts";
import { RECOVERY_FILE, writeAtomic } from "./layout.ts";

export type RecoveryCheckpoint = {
  version: 2;
  disposition: "continuable" | "history_only";
  turn_id: number;
  user: UserTurn;
  /** Assistant text streamed before the failure. */
  assistant_source: string;
  cause: string;
  action: string;
  tool_state: "none" | "pending" | "completed";
  fast_mode: boolean;
  max_provider_attempts: number;
  consumed_provider_attempts: number;
};

export const recoveryPath = (dir: string) => join(dir, RECOVERY_FILE);

export function writeRecovery(dir: string, checkpoint: RecoveryCheckpoint) {
  writeAtomic(recoveryPath(dir), `${JSON.stringify(checkpoint)}\n`);
}

export function readRecovery(dir: string): RecoveryCheckpoint | undefined {
  try {
    const parsed = JSON.parse(readFileSync(recoveryPath(dir), "utf8")) as RecoveryCheckpoint;
    return parsed?.version === 2 && parsed.user && typeof parsed.user.text === "string" ? parsed : undefined;
  } catch {
    return undefined;
  }
}

export function clearRecovery(dir: string) {
  rmSync(recoveryPath(dir), { force: true });
}

/** The interrupted turn a history-only checkpoint archives. */
export const interruptedTurn = (c: RecoveryCheckpoint) =>
  ({
    kind: "interrupted",
    user: c.user,
    ...(c.assistant_source ? { assistant: c.assistant_source } : {}),
    completedToolNames: [],
    execution: { steps: [], steering: [] },
    reason: "failed",
    origin: "turn",
  }) as const;
