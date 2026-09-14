/** Sound notifications: afplay of a bundled cue on macOS, terminal bell everywhere else. */

export type Cue = "success" | "error";
export type Kind = "turn_end" | "attention_required";
export type SoundPrefs = {
  turn_end: boolean;
  attention_required: boolean;
  max: boolean;
  /** Absolute paths of the cue files the integrator bundles (materialized in $TMPDIR). */
  cueFiles?: Partial<Record<Cue, string>>;
};
export type Sink = {
  platform: NodeJS.Platform;
  /** Fire-and-forget; throw to signal the player is unavailable. */
  spawn(cmd: string, args: string[]): void;
  bell(): void;
};

const AFPLAY = "/usr/bin/afplay";

/** turn_end: chime or bell. attention_required: always bell (multiplexers mark the pane) plus the chime on macOS. */
export function notify(kind: Kind, cue: Cue, prefs: SoundPrefs, sink: Sink) {
  if (!prefs[kind]) return;
  const chime = () => {
    const file = prefs.cueFiles?.[cue];
    if (!file) return false;
    try {
      sink.spawn(AFPLAY, [file]);
      return true;
    } catch {
      return false;
    }
  };
  if (kind === "attention_required") {
    sink.bell();
    if (sink.platform === "darwin") chime();
    return;
  }
  if (sink.platform !== "darwin" || !chime()) sink.bell();
}

export type NotificationSettings = { turn_end?: boolean; attention_required?: boolean; max?: boolean };

/** Settings with the NOD_SOUND override (0/false/off, max, anything else = on). Defaults on only on macOS. */
export function soundPrefs(
  settings: NotificationSettings | undefined,
  env: Record<string, string | undefined>,
  platform: NodeJS.Platform = process.platform,
): SoundPrefs {
  const raw = env.NOD_SOUND?.trim() ?? "";
  const level =
    raw === "" ? undefined : raw.toLowerCase() === "max" ? "max" : /^(0|false|off)$/i.test(raw) ? "off" : "on";
  const on = level === undefined ? undefined : level !== "off";
  const defaultEnabled = platform === "darwin";
  return {
    turn_end: on ?? settings?.turn_end ?? defaultEnabled,
    attention_required: on ?? settings?.attention_required ?? defaultEnabled,
    max: level === undefined ? (settings?.max ?? false) : level === "max",
  };
}

/** Production sink: detached afplay, bell on stdout. */
export const processSink = (): Sink => ({
  platform: process.platform,
  spawn(cmd, args) {
    Bun.spawn([cmd, ...args], { stdio: ["ignore", "ignore", "ignore"] }).unref();
  },
  bell() {
    process.stdout.write("\x07");
  },
});
