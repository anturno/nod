import { describe, expect, test } from "bun:test";
import { baseToolName, createNameRegistry } from "../../src/core/mcp/names.ts";

describe("mcp tool names", () => {
  test("sanitizes, caps at 64, and suffixes collisions", () => {
    expect(baseToolName("my-server", "read.file")).toBe("mcp_my-server_read_file");
    expect(baseToolName("", "")).toBe("mcp_server_tool");
    const r = createNameRegistry(["mcp_a_b"]);
    expect(r.name("a", "b")).toBe("mcp_a_b_2");
    expect(r.name("a", "b")).toBe("mcp_a_b_2");
    expect(r.name("a/b", "c")).toBe("mcp_a_b_c");
    expect(r.name("a.b", "c")).toBe("mcp_a_b_c_2");
    expect(r.identity("mcp_a_b_c_2")).toEqual({ server: "a.b", tool: "c" });
    const long = r.name("s", "t".repeat(100));
    expect(long.length).toBe(64);
    const long2 = r.name("s", `${"t".repeat(100)}x`);
    expect(long2.length).toBe(64);
    expect(long2.endsWith("_2")).toBe(true);
    expect(r.identity("nope")).toBeUndefined();
  });
});
