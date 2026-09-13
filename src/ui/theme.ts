/**
 * The anturno CLI's palette (tui-kit's `anturnoTheme`). Structure is a hairline border and a neutral ramp;
 * gold marks only what is live or interactive, and green, amber and red are kept for approval and failure.
 */
export const C = {
  accent: "#E3B756",
  foreground: "#E6E6E6",
  mutedForeground: "#989898",
  muted: "#666666",
  border: "#3A3A3A",
  success: "#58C283",
  warning: "#E8AF4F",
  error: "#EE5C5F",
};

export const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
/** 12 fps, as the anturno spinners run. */
export const SPINNER_INTERVAL = 83;

export type Risk = "low" | "medium" | "high";
export const RISK_COLOR: Record<Risk, string> = { low: C.success, medium: C.warning, high: C.error };

/** Mistakes the terminal cannot undo. */
const DESTRUCTIVE =
  /\brm\s+-[a-z]*[rf]|\bsudo\b|\bdd\b|\bmkfs|\bchmod\s+777|\bgit\s+push\b.*--force|\bgit\s+reset\s+--hard|\bgit\s+clean\s+-[a-z]*f|\bkill(all)?\b|>\s*\/dev\/|\bcurl\b[^|]*\|\s*(ba)?sh|\bnpm\s+publish\b/;
/** Reaches the network or changes what is installed. */
const ELEVATED =
  /\b(npm|bun|pnpm|yarn)\s+(install|add|remove)\b|\b(curl|wget)\b|\bgit\s+(push|commit|checkout|merge|rebase)\b|\bdocker\b/;

// ponytail: regex heuristic, only so `rm -rf` and `git status` look different; not a sandbox or a policy.
export const assessRisk = (command: string): Risk =>
  DESTRUCTIVE.test(command) ? "high" : ELEVATED.test(command) ? "medium" : "low";
