/** `/sound [on|off|max]`: no argument toggles turn_end; explicit levels set every cue. */

export type SoundSettings = { turnEnd: boolean; attentionRequired: boolean; max: boolean };

export function applySound(current: SoundSettings, arg?: string): SoundSettings | null {
  if (arg === undefined) return { ...current, turnEnd: !current.turnEnd };
  if (arg === "on") return { ...current, turnEnd: true, attentionRequired: true };
  if (arg === "off") return { turnEnd: false, attentionRequired: false, max: false };
  if (arg === "max") return { turnEnd: true, attentionRequired: true, max: true };
  return null;
}

export const soundLevel = (s: SoundSettings) => (s.max ? "max" : s.turnEnd ? "on" : "off");

/** The settings.json shape for `notifications`. */
export const soundPatch = (s: SoundSettings) => ({
  notifications: { turn_end: s.turnEnd, attention_required: s.attentionRequired, max: s.max },
});
