/** Turn-end and attention cues for the shell, over the core notify module. */
import { type Kind, notify, type Sink, soundPrefs } from "../core/notify/index.ts";

export type Notifier = { turnEnd(success: boolean): void; attention(): void };

export function createNotifier(o: {
  settings:
    | { turnEnd: boolean; attentionRequired: boolean; max: boolean }
    | (() => { turnEnd: boolean; attentionRequired: boolean; max: boolean });
  env: Record<string, string | undefined>;
  sink: Sink;
  platform?: NodeJS.Platform;
}): Notifier {
  const prefs = () => {
    const s = typeof o.settings === "function" ? o.settings() : o.settings;
    return soundPrefs(
      { turn_end: s.turnEnd, attention_required: s.attentionRequired, max: s.max },
      o.env,
      o.platform ?? process.platform,
    );
  };
  const fire = (kind: Kind, cue: "success" | "error") => {
    try {
      notify(kind, cue, prefs(), o.sink);
    } catch {
      // a missing player never breaks the shell
    }
  };
  return {
    turnEnd: (success) => fire("turn_end", success ? "success" : "error"),
    attention: () => fire("attention_required", "success"),
  };
}

/** A sink that bells through the given stream instead of process.stdout. */
export const streamSink = (
  stdout: { write(s: string): unknown },
  platform: NodeJS.Platform = process.platform,
): Sink => ({
  platform,
  spawn(cmd, args) {
    Bun.spawn([cmd, ...args], { stdio: ["ignore", "ignore", "ignore"] }).unref();
  },
  bell() {
    stdout.write("\x07");
  },
});
