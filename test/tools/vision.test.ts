import { describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ImageRef } from "../../src/core/agent/types.ts";
import { call, decode } from "../../src/core/tools/vision.ts";
import { decodeFail, decodeOk, makeCtx, tempWorkspace } from "./helpers.ts";

describe("vision", () => {
  test("decode requires exactly one source and a focus", () => {
    expect(decodeFail(decode({ focus: "f" }))).toBe("vision arguments are invalid: InvalidVisionRequest");
    expect(decodeFail(decode({ image_ids: [1], paths: ["a.png"], focus: "f" }))).toBe(
      "vision arguments are invalid: InvalidVisionRequest",
    );
    expect(decodeFail(decode({ image_ids: [], focus: "f" }))).toBe("vision arguments are invalid: EmptyImageIds");
    expect(decodeFail(decode({ image_ids: [1, 1], focus: "f" }))).toBe(
      "vision arguments are invalid: DuplicateImageId",
    );
    expect(decodeFail(decode({ paths: [], focus: "f" }))).toBe("vision arguments are invalid: EmptyPaths");
    expect(decodeFail(decode({ paths: [" "], focus: "f" }))).toBe("vision arguments are invalid: InvalidImagePath");
    expect(decodeFail(decode({ paths: ["a.png", "a.png"], focus: "f" }))).toBe(
      "vision arguments are invalid: DuplicateImagePath",
    );
    expect(decodeFail(decode({ paths: ["a.png"], focus: " " }))).toBe("vision arguments are invalid: EmptyFocus");
    expect(decodeOk(decode({ paths: ["a.png"], focus: "text" }))).toEqual({ paths: ["a.png"], focus: "text" });
  });

  test("loads local images, resolves attached ids, and forwards to the vision service", async () => {
    const ws = tempWorkspace();
    mkdirSync(join(ws, "img"));
    writeFileSync(join(ws, "img", "shot.png"), Buffer.from("png-bytes"));
    writeFileSync(join(ws, "img", "notes.txt"), "text");
    const seen: [ImageRef[], string][] = [];
    const attached: ImageRef = { id: 4, mime: "image/png", data: "QUFB" };
    const ctx = makeCtx(ws, {
      images: [attached],
      vision: async (images, focus) => {
        seen.push([images, focus]);
        return "evidence";
      },
    });
    expect(await call(decodeOk(decode({ paths: ["img/shot.png"], focus: "text" })), ctx)).toEqual({
      status: "success",
      output: "evidence",
    });
    expect(seen[0]).toEqual([
      [
        {
          id: 1,
          mime: "image/png",
          data: Buffer.from("png-bytes").toString("base64"),
          path: join(ws, "img", "shot.png"),
        },
      ],
      "text",
    ]);
    expect(await call(decodeOk(decode({ image_ids: [4], focus: "ui" })), ctx)).toEqual({
      status: "success",
      output: "evidence",
    });
    expect(seen[1]![0]).toEqual([attached]);
    expect((await call(decodeOk(decode({ image_ids: [9], focus: "ui" })), ctx)).output).toBe(
      "vision failed: UnauthorizedImageId",
    );
    expect((await call(decodeOk(decode({ paths: ["img/notes.txt"], focus: "ui" })), ctx)).output).toBe(
      "vision failed: UnsupportedImageType",
    );
    expect((await call(decodeOk(decode({ paths: ["img/missing.png"], focus: "ui" })), ctx)).output).toBe(
      "vision failed: FileNotFound",
    );
    expect((await call(decodeOk(decode({ paths: ["/etc/shot.png"], focus: "ui" })), ctx)).output).toBe(
      "vision failed: PathOutsideWorkspace",
    );
    expect((await call(decodeOk(decode({ paths: ["img/shot.png"], focus: "ui" })), makeCtx(ws))).output).toBe(
      "Vision is unavailable in this runtime.",
    );
  });
});
