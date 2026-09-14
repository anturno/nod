/** Clipboard access: pbcopy / wl-copy / xclip for text, osascript / wl-paste / xclip for a pasted image. */
import { mkdirSync } from "node:fs";
import { join } from "node:path";

type Spawn = typeof Bun.spawn;

function firstAvailable(candidates: string[][]): string[] | null {
  for (const c of candidates) if (Bun.which(c[0] as string)) return c;
  return null;
}

export function createClipboard(o: { platform?: NodeJS.Platform; spawn?: Spawn; now?: () => number } = {}) {
  const platform = o.platform ?? process.platform;
  const spawn = o.spawn ?? Bun.spawn;
  const now = o.now ?? Date.now;
  return {
    async copy(text: string): Promise<boolean> {
      const cmd =
        platform === "darwin" ? ["pbcopy"] : firstAvailable([["wl-copy"], ["xclip", "-selection", "clipboard"]]);
      if (!cmd || !Bun.which(cmd[0] as string)) return false;
      try {
        const proc = spawn(cmd, { stdin: "pipe", stdout: "ignore", stderr: "ignore" });
        proc.stdin.write(text);
        await proc.stdin.end();
        return (await proc.exited) === 0;
      } catch {
        return false;
      }
    },
    /** Writes the clipboard image to `<dir>/<timestamp>.png`; null when there is none. */
    async pasteImage(dir: string): Promise<string | null> {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const path = join(dir, `${now()}.png`);
      const cmd =
        platform === "darwin"
          ? [
              "osascript",
              "-e",
              `set p to POSIX file "${path}"`,
              "-e",
              "set f to open for access p with write permission",
              "-e",
              "write (the clipboard as «class PNGf») to f",
              "-e",
              "close access f",
            ]
          : firstAvailable([
              ["wl-paste", "--type", "image/png"],
              ["xclip", "-selection", "clipboard", "-t", "image/png", "-o"],
            ]);
      if (!cmd || !Bun.which(cmd[0] as string)) return null;
      try {
        const proc = spawn(cmd, {
          stdout: platform === "darwin" ? "ignore" : Bun.file(path),
          stderr: "ignore",
        });
        if ((await proc.exited) !== 0) return null;
        return (await Bun.file(path).size) > 0 ? path : null;
      } catch {
        return null;
      }
    },
  };
}

export type Clipboard = ReturnType<typeof createClipboard>;
