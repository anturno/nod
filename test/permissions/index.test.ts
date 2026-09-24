import { expect, test } from "bun:test";
import { displayPermissionMode, parsePermissionModeInput } from "../../src/core/permissions/index.ts";

test("mode parsing and display", () => {
  expect(["ask", "AUTO", "full-access", "Full Access", "yolo", "nope"].map(parsePermissionModeInput)).toEqual([
    "ask",
    "auto",
    "yolo",
    "yolo",
    "yolo",
    null,
  ]);
  expect(displayPermissionMode("yolo")).toBe("full access");
  expect(displayPermissionMode("auto")).toBe("auto");
});
