/** Failure JSON for --json commands, and the stdout/stderr sinks the commands write through. */
export type Io = {
  stdout(text: string): void;
  stderr(text: string): void;
  env: Record<string, string | undefined>;
  cwd: string;
  isTTY: boolean;
};

export const renderFailureJson = (kind: string, message: string, code?: string) =>
  JSON.stringify({ kind, error: message, ...(code ? { code } : {}) });

export const processIo = (): Io => ({
  stdout: (t) => process.stdout.write(t),
  stderr: (t) => process.stderr.write(t),
  env: process.env,
  cwd: process.cwd(),
  isTTY: process.stdout.isTTY === true,
});
