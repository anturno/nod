import { describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { isToolOutputError, malformedArguments, permissionDenied, reviewHeld } from "../../src/core/tools/errors.ts";
import {
  advertisementOrder,
  builtinTools,
  lookupTool,
  permissionNameFor,
  readOnlyToolNames,
} from "../../src/core/tools/registry.ts";

// Recompute with: bun -e 'import("./test/tools/registry.test.ts")' after an intentional schema change.
const SCHEMA_SNAPSHOT = "26e4ab94509e3a4508347a322499e12b8675958d3eba779f0842522ef7326624";

describe("registry", () => {
  test("advertises the canonical order plus vision and read_tool_result", () => {
    expect(builtinTools.map((t) => t.name)).toEqual([...advertisementOrder, "vision", "read_tool_result"]);
    expect(readOnlyToolNames).toEqual(["read_file", "glob_files", "grep_files"]);
    expect(lookupTool("read_file")?.name).toBe("read_file");
    expect(lookupTool("nope")).toBeUndefined();
  });

  test("schemas stay byte exact", () => {
    const serialized = builtinTools.map((t) => JSON.stringify([t.name, t.description, t.parameters])).join("\0");
    const hash = createHash("sha256").update(serialized).digest("hex");
    expect(hash).toBe(SCHEMA_SNAPSHOT);
  });

  test("descriptions say nod", () => {
    expect(lookupTool("subagent")?.description).toContain("nod preserves its trusted base prompt");
  });

  test("metadata matches", () => {
    expect(lookupTool("vision")).toMatchObject({
      requiresApproval: true,
      approvalPolicy: "ask_only",
      activity: "read",
    });
    expect(lookupTool("edit_file")).toMatchObject({ requiresApproval: true, permissionTarget: "path_existing_parent" });
    expect(lookupTool("write_file")).toMatchObject({ permissionTarget: "path_create_parent", activity: "write" });
    expect(lookupTool("glob_files")).toMatchObject({ activity: "list", permissionTarget: "path_optional_existing" });
    expect(lookupTool("ask_user_question")).toMatchObject({ activity: "ask", requiresApproval: false });
    expect(lookupTool("shell")).toMatchObject({ activity: "command", requiresApproval: true });
  });

  test("permission names", () => {
    const table: Record<string, string> = {
      read_file: "read",
      write_file: "edit",
      edit_file: "edit",
      glob_files: "glob",
      grep_files: "grep",
      shell: "bash",
      web_fetch: "web_fetch",
      skill: "skill",
      install_skill: "skill",
      web_search: "web_search",
      mcp_acme_tool: "mcp_acme_tool",
    };
    for (const [tool, name] of Object.entries(table)) expect(permissionNameFor(tool)).toBe(name);
  });
});

describe("errors", () => {
  test("error envelopes carry the message and suggestion table", () => {
    const denied = JSON.parse(permissionDenied("shell", "permission_required")).error;
    expect(denied).toEqual({
      type: "tool_permission_denied",
      tool_name: "shell",
      message: "Shell command approval is required before this tool can run",
      reason: "permission_required",
      denied: true,
      suggestion:
        "The tool did not run. Noninteractive mode cannot show an approval prompt. Rerun interactively to approve, or configure a narrow permission rule before retrying.",
    });
    expect(JSON.parse(permissionDenied("web_search", "policy_denied")).error.message).toBe(
      "Network or browser access was denied by configured policy",
    );
    const held = JSON.parse(
      reviewHeld("edit_file", "review_caution", "Deletion came from repository text.", "transport_timed_out"),
    ).error;
    expect(held).toMatchObject({
      type: "tool_review_held",
      reason: "review_caution",
      review_cause: "transport_timed_out",
      held: true,
      advice: "Deletion came from repository text.",
      message: "Action held after safety review",
    });
    expect(JSON.parse(reviewHeld("shell", "review_unavailable")).error.advice).toBeUndefined();
    expect(isToolOutputError(malformedArguments("read_file"))).toBe(true);
    expect(isToolOutputError("file content here")).toBe(false);
  });
});
