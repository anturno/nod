/** vision: describe attached or local images through the session model. */
import { readFile, stat } from "node:fs/promises";
import { extname } from "node:path";
import type { ImageRef } from "../agent/types.ts";
import { errorName, fail, isRecord, ok } from "./args.ts";
import { canonical, type PathError, pathInside, resolvePath } from "./paths.ts";
import { truncateWithMarker } from "./result_store.ts";
import type { DecodeResult, ToolContext, ToolResult } from "./spec.ts";

export type Input = { imageIds?: number[]; paths?: string[]; focus: string };

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 20 * 1024;
const MAX_FOCUS_BYTES = 4096;
const MIME_BY_EXT: Record<string, string> = {
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
};

const invalid = (name: string) => fail<Input>(`vision arguments are invalid: ${name}`);

export function decode(args: unknown): DecodeResult<Input> {
  if (!isRecord(args)) return invalid("InvalidVisionRequest");
  const hasIds = "image_ids" in args;
  const hasPaths = "paths" in args;
  if (hasIds === hasPaths) return invalid("InvalidVisionRequest");
  const input: Input = { focus: "" };
  if (hasIds) {
    const ids = args.image_ids;
    if (!Array.isArray(ids)) return invalid("InvalidVisionRequest");
    if (ids.length === 0) return invalid("EmptyImageIds");
    for (const id of ids) if (!Number.isInteger(id) || (id as number) < 0) return invalid("InvalidImageId");
    if (new Set(ids).size !== ids.length) return invalid("DuplicateImageId");
    input.imageIds = ids as number[];
  } else {
    const paths = args.paths;
    if (!Array.isArray(paths)) return invalid("InvalidVisionRequest");
    if (paths.length === 0) return invalid("EmptyPaths");
    for (const p of paths)
      if (typeof p !== "string" || p.trim().length === 0 || p.includes("\0")) return invalid("InvalidImagePath");
    if (new Set(paths).size !== paths.length) return invalid("DuplicateImagePath");
    input.paths = paths as string[];
  }
  if (!("focus" in args) || typeof args.focus !== "string") return invalid("InvalidVisionRequest");
  if (args.focus.trim().length === 0) return invalid("EmptyFocus");
  if (Buffer.byteLength(args.focus) > MAX_FOCUS_BYTES) return invalid("FocusTooLong");
  input.focus = args.focus;
  return ok(input);
}

async function loadImage(path: string, id: number, ctx: ToolContext): Promise<ImageRef | string> {
  let absolute: string;
  let external: boolean;
  try {
    ({ absolute, external } = resolvePath(ctx.workspaceRoot, path, ctx.home, ctx.additionalDirectories));
  } catch (err) {
    return (err as PathError).message;
  }
  if (external && !(ctx.home && pathInside(canonical(ctx.home), absolute))) return "PathOutsideWorkspace";
  const mime = MIME_BY_EXT[extname(absolute).toLowerCase()];
  if (!mime) return "UnsupportedImageType";
  try {
    const info = await stat(absolute);
    if (!info.isFile()) return "NotRegularFile";
    if (info.size > MAX_IMAGE_BYTES) return "ImageTooLarge";
    return { id, mime, data: (await readFile(absolute)).toString("base64"), path: absolute };
  } catch (err) {
    return errorName(err);
  }
}

export async function call(input: Input, ctx: ToolContext): Promise<ToolResult> {
  if (!ctx.vision) return { status: "failure", output: "Vision is unavailable in this runtime." };
  const images: ImageRef[] = [];
  if (input.imageIds) {
    for (const id of input.imageIds) {
      const image = ctx.images.find((i) => i.id === id);
      if (!image) return { status: "failure", output: "vision failed: UnauthorizedImageId" };
      images.push(image);
    }
  } else {
    for (const [index, path] of (input.paths ?? []).entries()) {
      const loaded = await loadImage(path, index + 1, ctx);
      if (typeof loaded === "string") return { status: "failure", output: `vision failed: ${loaded}` };
      images.push(loaded);
    }
  }
  try {
    const text = await ctx.vision(images, input.focus, ctx.signal);
    return { status: "success", output: truncateWithMarker("vision", text, MAX_OUTPUT_BYTES).text };
  } catch (err) {
    return { status: "failure", output: `vision failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

export const readsOnly = (): boolean => true;
export const label = (): string => "vision images";
