/** The contract every tool implements, and the context the runtime hands it. */
import type { ImageRef, ToolCall, ToolResultMemory, ToolStatus } from "../agent/types.ts";

export type Activity = "read" | "list" | "write" | "edit" | "command" | "subagent" | "ask";
export type PermissionTargetKind =
  | "none"
  | "path_existing"
  | "path_optional_existing"
  | "path_create_parent"
  | "path_existing_parent";

/** One thing a permission rule can be matched against. */
export type PermissionTarget = {
  /** The permission name: read, edit, glob, grep, bash, web_fetch, skill, or the tool name. */
  permission: string;
  /** Workspace-relative or absolute path, the command text, a host, or "*". */
  target: string;
  kind: "path" | "command" | "host" | "other";
  /** Absolute path for path targets. */
  absolute?: string;
  external?: boolean;
};

export type DecodeResult<T> = { ok: true; input: T } | { ok: false; failure: string };

export type ToolResult = {
  status: ToolStatus;
  output: string;
  images?: ImageRef[];
  /** complete_skill bypasses the inline result cap (but not the hard limit). */
  kind?: "complete_skill";
  memory?: Partial<ToolResultMemory>;
  /** Set by ask_user_question when the user cancelled, so the turn stops after this batch. */
  cancelTurn?: boolean;
};

/** What an approval prompt shows before a mutation runs. */
export type Preparation = {
  title: string;
  detail?: string;
  diff?: { path: string; before: string | null; after: string; additions: number; deletions: number };
};

export type AskUser = (
  questions: { question: string; options: { label: string; description?: string }[] }[],
  signal?: AbortSignal,
) => Promise<{ answers: { question: string; answer: string }[] } | null>;

export type ToolContext = {
  workspaceRoot: string;
  cwd: string;
  home: string;
  /** Directory for large results of this session. */
  resultDir: string;
  sessionId: string;
  maxToolResultBytes: number;
  signal?: AbortSignal;
  /** Images attached to the current turn, for vision. */
  images: ImageRef[];
  /** Additional directories tools may reach. */
  additionalDirectories: string[];
  /** Services other modules provide. Absent means the capability is unavailable in this host. */
  shell?: import("../shell/manager.ts").ShellManager;
  askUser?: AskUser;
  skills?: import("../skills/types.ts").SkillService;
  mcp?: import("../mcp/types.ts").McpService;
  subagents?: import("../subagent/types.ts").SubagentService;
  vision?: (images: ImageRef[], focus: string, signal?: AbortSignal) => Promise<string>;
  webSearch?: (query: string, allowed: string[], blocked: string[], signal?: AbortSignal) => Promise<string>;
  /** Records file pre-images so /undo can revert. */
  onFileMutation?: (path: string, before: string | null) => void;
};

export type ToolSpec<T = unknown> = {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  activity: Activity;
  requiresApproval: boolean;
  approvalPolicy?: "standard" | "ask_only";
  permissionTarget: PermissionTargetKind;
  decode(args: unknown, ctx: ToolContext): DecodeResult<T>;
  /** Permission targets for this call. Defaults to none. */
  targets?(input: T, ctx: ToolContext): PermissionTarget[];
  /** Work done before the permission decision, so the prompt can show it (edit diffs). */
  prepare?(input: T, ctx: ToolContext): Promise<Preparation>;
  call(input: T, ctx: ToolContext, prepared?: Preparation): Promise<ToolResult>;
  /** True when this particular call cannot change anything (shell interact/stop without input). */
  readsOnly?(input: T): boolean;
  /** A short label for transcripts and approval prompts: "shell.run bun test", "edit_file src/a.ts". */
  label?(input: T, ctx: ToolContext): string;
};

export type AdmittedCall = { call: ToolCall; spec: ToolSpec; input: unknown };
