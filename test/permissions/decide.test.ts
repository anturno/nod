import { expect, test } from "bun:test";
import {
  type ApprovalRequest,
  type DecisionInput,
  decidePermission,
  permissionDeniedJson,
  type ReviewInput,
  type ReviewResult,
  sensitiveAutoWriteTarget,
} from "../../src/core/permissions/index.ts";
import type { PermissionTarget } from "../../src/core/tools/spec.ts";

const ws = "/tmp/ws";
const reviewInput: ReviewInput = {
  origin: "root",
  callId: "c1",
  action: { kind: "tool", name: "x", argumentsJson: "{}" },
  priorResults: [],
  rootRequests: { current: "do it" },
  feedback: [],
};

function reviewer(result: ReviewResult, max = 2) {
  const calls: ReviewInput[] = [];
  return {
    calls,
    reviewer: {
      budget: { attempts: 0, max },
      review: async (input: ReviewInput) => {
        calls.push(input);
        return result;
      },
    },
  };
}

const base = (overrides: Partial<DecisionInput> = {}): DecisionInput => ({
  toolName: "edit_file",
  spec: { activity: "edit", requiresApproval: true, permissionTarget: "path_existing" },
  targets: [{ permission: "edit", target: "src/a.ts", kind: "path", absolute: `${ws}/src/a.ts`, external: false }],
  readsOnly: false,
  mode: "auto",
  rules: [],
  grants: [],
  interactive: false,
  workspaceRoot: ws,
  origin: "root",
  reviewInput: () => reviewInput,
  ...overrides,
});

const shell = (command: string, overrides: Partial<DecisionInput> = {}): DecisionInput =>
  base({
    toolName: "shell",
    spec: { activity: "command", requiresApproval: true, permissionTarget: "none" },
    targets: [{ permission: "bash", target: command, kind: "command" }],
    command,
    cwdInsideWorkspace: true,
    ...overrides,
  });

const external: PermissionTarget = {
  permission: "edit",
  target: "/etc/hosts",
  kind: "path",
  absolute: "/etc/hosts",
  external: true,
};

test("yolo allows everything, including policy-denied targets", async () => {
  expect(
    await decidePermission(base({ mode: "yolo", rules: [{ permission: "edit", pattern: "*", action: "deny" }] })),
  ).toEqual({
    decision: "once",
  });
});

test("deny rules produce policy_denied with the denial JSON", async () => {
  const outcome = await decidePermission(base({ rules: [{ permission: "edit", pattern: "src/**", action: "deny" }] }));
  expect(outcome.decision).toBe("policy_denied");
  expect(outcome.reason).toBe("policy_denied");
  expect(JSON.parse(outcome.resultJson!)).toEqual({
    error: {
      type: "tool_permission_denied",
      tool_name: "edit_file",
      message: "Tool access was denied by configured policy",
      reason: "policy_denied",
      denied: true,
      suggestion:
        "The tool did not run. Do not retry unchanged; explain the configured policy blocker or use an allowed alternative.",
    },
  });
});

test("allow rules and grants short-circuit before the reviewer", async () => {
  const held = reviewer({ kind: "caution", rationale: "no" });
  expect(
    await decidePermission(
      base({ rules: [{ permission: "edit", pattern: "*", action: "allow" }], reviewer: held.reviewer }),
    ),
  ).toEqual({
    decision: "once",
  });
  expect(
    await decidePermission(
      base({
        grants: [{ permission: "edit", pattern: `${ws}/**` }],
        reviewer: held.reviewer,
        targets: [external, base().targets[0]!],
      }),
    ),
  ).toMatchObject({
    decision: "deny",
  });
  expect(
    await decidePermission(base({ grants: [{ permission: "edit", pattern: "/**" }], reviewer: held.reviewer })),
  ).toEqual({ decision: "once" });
  expect(held.calls).toHaveLength(1);
});

test("configured ask: grant covers → once; otherwise prompt, or permission_required without a prompter", async () => {
  const rules = [{ permission: "edit", pattern: "*", action: "ask" as const }];
  expect(await decidePermission(base({ rules, grants: [{ permission: "edit", pattern: `${ws}/**` }] }))).toEqual({
    decision: "once",
  });
  const blocked = await decidePermission(base({ rules }));
  expect(blocked).toMatchObject({ decision: "permission_required", reason: "permission_required" });
  expect(JSON.parse(blocked.resultJson!).error.suggestion).toBe(
    "The tool did not run. Noninteractive mode cannot show an approval prompt. Rerun interactively to approve, or configure a narrow permission rule before retrying.",
  );
  const requests: ApprovalRequest[] = [];
  const outcome = await decidePermission(
    base({
      rules,
      interactive: true,
      preparation: {
        title: "edit src/a.ts",
        diff: { path: "src/a.ts", before: "a", after: "b", additions: 1, deletions: 1 },
      },
      prompter: async (request) => {
        requests.push(request);
        return { outcome: "always", note: "keep it small" };
      },
    }),
  );
  expect(outcome).toEqual({
    decision: "always",
    feedback: "keep it small",
    grants: ["edit", "read", "glob", "grep"].map((permission) => ({ permission, pattern: `${ws}/**` })),
  });
  expect(requests[0]).toMatchObject({
    toolName: "edit_file",
    kind: "file",
    label: "edit_file src/a.ts",
    targets: base().targets,
  });
  expect(requests[0]!.preparation?.diff?.additions).toBe(1);
  const deniedByUser = await decidePermission(
    base({ rules, interactive: true, prompter: async () => ({ outcome: "deny" }) }),
  );
  expect(deniedByUser).toMatchObject({ decision: "deny", reason: "user_denied" });
  expect(JSON.parse(deniedByUser.resultJson!).error.message).toBe("Permission denied by user");
});

test("shell: direct read-only commands run without authority; user profile and clean profile in ask need it", async () => {
  const held = reviewer({ kind: "caution", rationale: "no" });
  expect(await decidePermission(shell("git status", { reviewer: held.reviewer }))).toEqual({ decision: "once" });
  expect(await decidePermission(shell("git status", { mode: "ask" }))).toEqual({ decision: "once" });
  expect(await decidePermission(shell("git status", { mode: "ask", profile: "clean" }))).toMatchObject({
    decision: "permission_required",
  });
  expect(await decidePermission(shell("git status", { profile: "clean", reviewer: held.reviewer }))).toEqual({
    decision: "once",
  });
  // knownReversibleAutoCommand ignores the environment, so auto still runs it without review.
  expect(await decidePermission(shell("git status", { profile: "user", reviewer: held.reviewer }))).toEqual({
    decision: "once",
  });
  expect(await decidePermission(shell("rm -rf x", { profile: "user", reviewer: held.reviewer }))).toMatchObject({
    decision: "deny",
    reason: "review_caution",
  });
  expect(await decidePermission(shell("git status", { profile: "user", mode: "ask" }))).toMatchObject({
    decision: "permission_required",
  });
  const json = JSON.parse((await decidePermission(shell("rm -rf x", { mode: "ask" }))).resultJson!);
  expect(json.error.message).toBe("Shell command approval is required before this tool can run");
});

test("auto: reversible commands inside the workspace skip review; other commands go to the reviewer", async () => {
  const clear = reviewer({ kind: "clear", rationale: "fine" });
  expect(await decidePermission(shell("bun test", { reviewer: clear.reviewer }))).toEqual({ decision: "once" });
  expect(clear.calls).toHaveLength(0);
  expect(await decidePermission(shell("bun test", { reviewer: clear.reviewer, cwdInsideWorkspace: false }))).toEqual({
    decision: "once",
    advice: "fine",
  });
  expect(clear.calls).toHaveLength(1);
  expect(await decidePermission(shell("rm -rf dist", { reviewer: clear.reviewer }))).toEqual({
    decision: "once",
    advice: "fine",
  });
});

test("reviewer outcomes map to held results", async () => {
  const caution = await decidePermission(
    shell("rm -rf dist", { reviewer: reviewer({ kind: "caution", rationale: "deletes build" }).reviewer }),
  );
  expect(caution).toMatchObject({ decision: "deny", reason: "review_caution", advice: "deletes build" });
  expect(JSON.parse(caution.resultJson!)).toEqual({
    error: {
      type: "tool_review_held",
      tool_name: "shell",
      message: "Action held after safety review",
      reason: "review_caution",
      held: true,
      advice: "deletes build",
      suggestion:
        "The action did not run. Use the review advice to choose a materially different safe action, or explain why no safe path remains.",
    },
  });
  const incomplete = await decidePermission(
    shell("rm -rf dist", { reviewer: reviewer({ kind: "evidence_incomplete" }).reviewer }),
  );
  expect(incomplete).toMatchObject({ decision: "deny", reason: "review_evidence_incomplete" });
  const invalid = await decidePermission(
    shell("rm -rf dist", { reviewer: reviewer({ kind: "invalid", reason: "transport_transient" }).reviewer }),
  );
  expect(invalid).toMatchObject({ decision: "deny", reason: "review_unavailable", cause: "transport_transient" });
  expect(JSON.parse(invalid.resultJson!).error.review_cause).toBe("transport_transient");
  const unconfigured = await decidePermission(shell("rm -rf dist"));
  expect(unconfigured).toMatchObject({
    decision: "deny",
    reason: "review_unavailable",
    cause: "reviewer_unconfigured",
  });
  expect(
    await decidePermission(
      shell("rm -rf dist", { reviewer: reviewer({ kind: "clear", rationale: "" }).reviewer, reviewInput: undefined }),
    ),
  ).toMatchObject({
    cause: "invalid_context",
  });
});

test("review budget: one attempt per call, two per turn", async () => {
  const clear = reviewer({ kind: "clear", rationale: "ok" });
  await decidePermission(shell("rm -rf a", { reviewer: clear.reviewer }));
  await decidePermission(shell("rm -rf b", { reviewer: clear.reviewer }));
  const third = await decidePermission(shell("rm -rf c", { reviewer: clear.reviewer }));
  expect(clear.calls).toHaveLength(2);
  expect(third).toMatchObject({
    decision: "deny",
    reason: "review_unavailable",
    cause: "turn_review_budget_exhausted",
  });
});

test("ask_only tools: auto runs, ask prompts", async () => {
  const vision = base({
    toolName: "vision",
    spec: { activity: "read", requiresApproval: true, approvalPolicy: "ask_only", permissionTarget: "none" },
    targets: [],
  });
  expect(await decidePermission(vision)).toEqual({ decision: "once" });
  expect(await decidePermission({ ...vision, mode: "ask" })).toMatchObject({ decision: "permission_required" });
  const requests: ApprovalRequest[] = [];
  expect(
    await decidePermission({
      ...vision,
      mode: "ask",
      interactive: true,
      prompter: async (r) => {
        requests.push(r);
        return { outcome: "once" };
      },
    }),
  ).toEqual({ decision: "once" });
  expect(requests[0]).toMatchObject({ kind: "confirm", label: "vision vision" });
});

test("read-only calls in auto and tools without approval run directly", async () => {
  const interact = base({
    toolName: "shell",
    spec: { activity: "command", requiresApproval: true, permissionTarget: "none" },
    targets: [],
    readsOnly: true,
  });
  expect(await decidePermission(interact)).toEqual({ decision: "once" });
  expect(await decidePermission({ ...interact, mode: "ask" })).toMatchObject({ decision: "permission_required" });
  const read = base({
    toolName: "read_file",
    spec: { activity: "read", requiresApproval: false, permissionTarget: "path_existing" },
    mode: "ask",
  });
  expect(await decidePermission(read)).toEqual({ decision: "once" });
});

test("file mutations in auto: workspace or new files bypass review; external and sensitive paths are reviewed; ask prompts", async () => {
  const held = reviewer({ kind: "caution", rationale: "no" });
  expect(await decidePermission(base({ reviewer: held.reviewer }))).toEqual({ decision: "once" });
  expect(await decidePermission(base({ reviewer: held.reviewer, targets: [external] }))).toMatchObject({
    decision: "deny",
    reason: "review_caution",
  });
  expect(
    await decidePermission(
      base({
        reviewer: held.reviewer,
        targets: [external],
        preparation: {
          title: "write",
          diff: { path: "/etc/hosts", before: null, after: "x", additions: 1, deletions: 0 },
        },
      }),
    ),
  ).toEqual({ decision: "once" });
  const hooks: PermissionTarget = {
    permission: "edit",
    target: ".git/hooks/pre-commit",
    kind: "path",
    absolute: `${ws}/.git/hooks/pre-commit`,
    external: false,
  };
  expect(await decidePermission(base({ reviewer: held.reviewer, targets: [hooks] }))).toMatchObject({
    decision: "deny",
  });
  expect(await decidePermission(base({ mode: "ask" }))).toMatchObject({ decision: "permission_required" });
  expect(
    await decidePermission(base({ mode: "ask", interactive: true, prompter: async () => ({ outcome: "once" }) })),
  ).toEqual({ decision: "once" });
});

test("sensitive path list", () => {
  for (const p of [
    "/ws/.git/hooks/pre-commit",
    "/ws/.git/config",
    "/home/u/.ssh/authorized_keys",
    "/home/u/.ssh/config",
    "/Users/u/Library/LaunchAgents/x.plist",
    "/Users/u/Library/LaunchDaemons/x.plist",
    "/home/u/.config/autostart/x.desktop",
    "/home/u/.config/fish/config.fish",
    "/home/u/.zshrc",
    "/home/u/.bashrc",
    "/home/u/.bash_profile",
    "/home/u/.profile",
  ]) {
    expect(sensitiveAutoWriteTarget(p)).toBe(true);
  }
  expect(sensitiveAutoWriteTarget("/ws/src/.git/hooks")).toBe(true);
  expect(sensitiveAutoWriteTarget("/ws/git/hooks/x")).toBe(false);
  expect(sensitiveAutoWriteTarget("/ws/.gitignore")).toBe(false);
  expect(sensitiveAutoWriteTarget("/ws/.ssh/known_hosts")).toBe(false);
});

test("permissionDeniedJson covers every reason", () => {
  expect(JSON.parse(permissionDeniedJson("web_search", "policy_denied")).error.message).toBe(
    "Network or browser access was denied by configured policy",
  );
  expect(JSON.parse(permissionDeniedJson("web_search", "permission_required")).error.message).toBe(
    "Network or browser approval is required before this tool can run",
  );
  expect(JSON.parse(permissionDeniedJson("x", "auto_denied")).error.message).toBe("Blocked by automatic safety policy");
  const held = JSON.parse(permissionDeniedJson("x", "review_unavailable", { cause: "transport_timed_out" })).error;
  expect(held).toMatchObject({ type: "tool_review_held", held: true, review_cause: "transport_timed_out" });
  expect(held.advice).toBeUndefined();
  expect(JSON.parse(permissionDeniedJson("x", "review_evidence_incomplete")).error.message).toBe(
    "Safety review evidence incomplete; action held",
  );
});
