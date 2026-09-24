/** Local stdio servers: Bun.spawn, NDJSON frames, a stderr ring, and the stdin → SIGTERM → SIGKILL shutdown ladder. */
import { randomBytes } from "node:crypto";
import { existsSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeFrame, JsonRpcFrameError, parseFrame } from "../jsonrpc.ts";
import { MAX_FRAME_BYTES, STDERR_RING_LINES } from "../limits.ts";
import type { McpTransport, TransportHandlers } from "../types.ts";

export type StdioOptions = TransportHandlers & {
  command: string[];
  env: Record<string, string | undefined>;
  cwd?: string;
  /** Delay between shutdown steps; 1 s in production. */
  graceMs?: number;
};

export type StdioTransport = McpTransport & { exited: Promise<number | null>; stderrTail(): string[] };

/** `docker run` without --cidfile gets one so the container can be removed after shutdown. */
export function injectCidfile(command: string[], cidfile: string): string[] {
  if (command[0] !== "docker" || command[1] !== "run") return command;
  if (command.some((a) => a === "--cidfile" || a.startsWith("--cidfile="))) return command;
  return [command[0], command[1], "--cidfile", cidfile, ...command.slice(2)];
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export function spawnStdio(o: StdioOptions): StdioTransport {
  const graceMs = o.graceMs ?? 1000;
  const cidfile = join(tmpdir(), `nod-mcp-${randomBytes(6).toString("hex")}.cid`);
  const command = injectCidfile(o.command, cidfile);
  const ownsContainer = command !== o.command;
  const stderr: string[] = [];
  let closing = false;
  let failure: Error | undefined;

  const proc = Bun.spawn(command, {
    cwd: o.cwd,
    env: { ...o.env } as Record<string, string>,
    stdin: "pipe",
    stdout: "pipe",
    stderr: "pipe",
  });

  const readLines = async (stream: ReadableStream<Uint8Array>, onLine: (line: string) => void, cap?: number) => {
    const decoder = new TextDecoder();
    let buffer = "";
    try {
      for await (const chunk of stream) {
        buffer += decoder.decode(chunk, { stream: true });
        let nl = buffer.indexOf("\n");
        while (nl >= 0) {
          onLine(buffer.slice(0, nl).replace(/\r$/, ""));
          buffer = buffer.slice(nl + 1);
          nl = buffer.indexOf("\n");
        }
        if (cap !== undefined && buffer.length > cap) {
          failure = new JsonRpcFrameError("request frame too large");
          proc.kill("SIGKILL");
          return;
        }
      }
      if (buffer.length > 0) onLine(buffer);
    } catch {
      // Stream closed with the process.
    }
  };

  void readLines(
    proc.stdout,
    (line) => {
      if (!line.trim()) return;
      try {
        o.onMessage(parseFrame(line));
      } catch (e) {
        if (e instanceof JsonRpcFrameError && e.message === "request frame too large") {
          failure = e;
          proc.kill("SIGKILL");
        }
        // Other malformed lines (server chatter on stdout) are ignored.
      }
    },
    MAX_FRAME_BYTES,
  );
  void readLines(proc.stderr, (line) => {
    stderr.push(line);
    if (stderr.length > STDERR_RING_LINES) stderr.shift();
  });

  const exited = proc.exited.then((code) => {
    if (ownsContainer && existsSync(cidfile)) {
      try {
        const cid = readFileSync(cidfile, "utf8").trim();
        if (cid) Bun.spawn(["docker", "rm", "-f", cid], { stdout: "ignore", stderr: "ignore" });
      } catch {
        // Nothing to clean.
      }
      try {
        unlinkSync(cidfile);
      } catch {
        // Already gone.
      }
    }
    o.onClose(closing && !failure ? undefined : (failure ?? new Error(`MCP server exited with code ${code}`)));
    return code;
  });

  return {
    exited,
    stderrTail: () => [...stderr],
    async send(message) {
      const sink = proc.stdin;
      sink.write(encodeFrame(message));
      await sink.flush();
    },
    async close() {
      if (closing) return void (await exited);
      closing = true;
      const done = exited.then(() => true);
      const timer = () => sleep(graceMs).then(() => false);
      try {
        proc.stdin.end();
      } catch {
        // Already closed.
      }
      if (await Promise.race([done, timer()])) return;
      // ponytail: signals the child only, not its process group; add detached spawn + kill(-pid) if grandchildren linger.
      proc.kill("SIGTERM");
      if (await Promise.race([done, timer()])) return;
      proc.kill("SIGKILL");
      await exited;
    },
  };
}
