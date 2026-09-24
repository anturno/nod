/**
 * The palette: a hairline border and a neutral ramp; gold marks what is live, green/amber/red approval and failure.
 * Theme detection: NOD_THEME → OSC 11 background query (100 ms) → COLORFGBG → dark.
 */

export type Palette = {
  accent: string;
  foreground: string;
  mutedForeground: string;
  muted: string;
  border: string;
  success: string;
  warning: string;
  error: string;
};

const DARK: Palette = {
  accent: "#E3B756",
  foreground: "#E6E6E6",
  mutedForeground: "#989898",
  muted: "#666666",
  border: "#3A3A3A",
  success: "#58C283",
  warning: "#E8AF4F",
  error: "#EE5C5F",
};

const LIGHT: Palette = {
  accent: "#9A6B00",
  foreground: "#1A1A1A",
  mutedForeground: "#555555",
  muted: "#8A8A8A",
  border: "#C8C8C8",
  success: "#1E7B45",
  warning: "#9A6B00",
  error: "#C0272D",
};

export const palette = (light: boolean): Palette => (light ? LIGHT : DARK);

/** The live palette the components read. runTui sets it once before rendering. */
export const C: Palette = { ...DARK };
export function applyTheme(theme: "dark" | "light") {
  Object.assign(C, palette(theme === "light"));
}

export const SPINNER = "⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏";
/** 12 fps, as the anturno spinners run. */
export const SPINNER_INTERVAL = 83;

export const OSC_BACKGROUND_QUERY = "\x1b]11;?\x07";
export const THEME_QUERY_TIMEOUT_MS = 100;

/** `rgb:RRRR/GGGG/BBBB` (or 8/12-bit variants) → light when luminance > 0.5. */
export function parseOscBackground(reply: string): "dark" | "light" | null {
  const m = reply.match(/\]11;rgb:([0-9a-f]+)\/([0-9a-f]+)\/([0-9a-f]+)/i);
  if (!m) return null;
  const channel = (hex: string) => Number.parseInt(hex, 16) / (16 ** hex.length - 1);
  const [r, g, b] = [channel(m[1] as string), channel(m[2] as string), channel(m[3] as string)];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.5 ? "light" : "dark";
}

/** COLORFGBG is "fg;bg" with ANSI indexes; a bright background index means light. */
export function themeFromColorFgBg(value: string | undefined): "dark" | "light" | null {
  const bg = value?.split(";").at(-1);
  if (bg === undefined || !/^\d+$/.test(bg)) return null;
  const n = Number(bg);
  return n === 7 || n === 15 || (n >= 9 && n <= 15) ? "light" : "dark";
}

export type ThemeDeps = {
  env: Record<string, string | undefined>;
  /** Present only for a real terminal: writes the query and awaits the reply on stdin. */
  query?: (sequence: string, timeoutMs: number) => Promise<string | null>;
};

export async function detectTheme(deps: ThemeDeps): Promise<"dark" | "light"> {
  const forced = deps.env.NOD_THEME?.trim().toLowerCase();
  if (forced === "light" || forced === "dark") return forced;
  if (deps.query) {
    const reply = await deps.query(OSC_BACKGROUND_QUERY, THEME_QUERY_TIMEOUT_MS).catch(() => null);
    const parsed = reply ? parseOscBackground(reply) : null;
    if (parsed) return parsed;
  }
  return themeFromColorFgBg(deps.env.COLORFGBG) ?? "dark";
}
