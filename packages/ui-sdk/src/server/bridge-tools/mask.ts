import { mkdirSync, writeFileSync } from "fs";
import { dirname, extname, relative, resolve, sep } from "path";
import { z } from "zod";

import type { BackendBridge } from "../backend.js";
import { resolveInRepo } from "./resolve-in-repo.js";

export const REQUEST_IMAGE_MASK_TOOL_NAME = "request_image_mask";

export const REQUEST_IMAGE_MASK_DESCRIPTION = [
  "Ask the user to mark the region of an image that should change, by painting over it in their browser.",
  "Use before editing part of an image — replacing an object, changing a background, removing something — when which region is meant is the user's call rather than yours. Writes a mask PNG next to the image and returns its path, which you then pass to `brain image --mask <path>` along with the image as `--ref`.",
  "The user may decline, in which case this returns an error: fall back to describing the change in words instead of retrying.",
  "Only mask-capable models accept it (OpenAI's image models); `brain image` routes there automatically when a mask is present.",
].join("\n");

export const REQUEST_IMAGE_MASK_INPUT_SCHEMA = z.object({
  imagePath: z
    .string()
    .describe(
      "Repo-relative path of the image to mark up, e.g. assets/images/house.png"
    ),
  instruction: z
    .string()
    .optional()
    .describe(
      "What you intend to change, shown to the user as guidance while they paint, e.g. 'mark the sky'"
    ),
});

export type RequestImageMaskInput = z.infer<
  typeof REQUEST_IMAGE_MASK_INPUT_SCHEMA
>;

export interface ImageMaskPayload {
  maskPath: string;
  imagePath: string;
  bytes: number;
  note: string;
}

export interface ImageMaskHandlerOptions {
  brainPath: string;
  maskFilename(
    submittedImagePath: string,
    canonicalImagePath: string
  ): string;
  reportMaskPath(
    brainPath: string,
    maskPath: string,
    absoluteMaskPath: string,
    canonicalMaskPath: string
  ): string;
}

/**
 * The filename is adapter-owned on purpose: Claude derives `x-mask.png` from
 * the submitted path, while pi derives `x.mask.png` from the canonical path.
 * Both overwrite with writeFileSync, so changing either derivation could
 * overwrite a file the previous backend left untouched, and an image rollback
 * cannot restore those bytes. Any future unification needs `wx` writes and a
 * collision test as a separate change.
 */
export async function handleRequestImageMask(
  input: RequestImageMaskInput,
  bridge: BackendBridge,
  options: ImageMaskHandlerOptions
): Promise<ImageMaskPayload> {
  if (!bridge.requestMask) {
    throw new Error(
      "The host does not support request_image_mask in this session."
    );
  }
  const imageAbs = resolveInRepo(options.brainPath, input.imagePath);
  if (!imageAbs) {
    throw new Error(`Path escapes the brain: ${input.imagePath}`);
  }

  const png = await bridge.requestMask(input.imagePath, input.instruction);
  const rootReal = resolveInRepo(options.brainPath, "");
  if (!rootReal) {
    throw new Error(`Cannot write a mask for ${input.imagePath}`);
  }
  const canonicalImagePath = relative(rootReal, imageAbs)
    .split(sep)
    .join("/");
  const maskRel = options.maskFilename(input.imagePath, canonicalImagePath);
  const absoluteMaskPath = resolve(rootReal, maskRel);
  const maskAbs = resolveInRepo(options.brainPath, maskRel);
  if (!maskAbs) {
    throw new Error(`Cannot write a mask for ${input.imagePath}`);
  }
  mkdirSync(dirname(maskAbs), { recursive: true });
  writeFileSync(maskAbs, png);

  // Reporting is adapter-owned and deliberately separate from containment.
  // Claude reports the submitted lexical path through internal symlinks; pi
  // reports from the absolute filename and the configured (possibly symlinked)
  // root. Neither rule may select the filesystem write target.
  const maskPath = options.reportMaskPath(
    options.brainPath,
    maskRel,
    absoluteMaskPath,
    maskAbs
  );
  return {
    maskPath,
    imagePath: input.imagePath,
    bytes: png.byteLength,
    note: "Transparent pixels mark the editable region. Pass this to `brain image --mask`, with the image as `--ref`.",
  };
}

export function claudeMaskFilename(
  submittedImagePath: string,
  _canonicalImagePath: string
): string {
  const extension = extname(submittedImagePath);
  return `${submittedImagePath.slice(0, submittedImagePath.length - extension.length)}-mask.png`;
}

export function piMaskFilename(
  _submittedImagePath: string,
  canonicalImagePath: string
): string {
  // Faithful port, quirk included: pi built the destination by compiling the
  // extension into a RegExp, so an extension carrying regex syntax does not
  // match its own filename and the extension is KEPT ("x.png+" wrote
  // "x.png+.mask.png", not "x.mask.png"). Slicing the extension off instead
  // would redirect those writes onto a different file, which an image rollback
  // cannot undo. Behaviour-preserving beats tidy here; changing it is a
  // separate change with `wx` writes and a collision test.
  const extension = extname(canonicalImagePath);
  return `${canonicalImagePath.replace(new RegExp(`${extension}$`), "")}.mask.png`;
}

export function claudeReportedMaskPath(
  brainPath: string,
  maskPath: string,
  _absoluteMaskPath: string,
  _canonicalMaskPath: string
): string {
  return relative(brainPath, resolve(brainPath, maskPath))
    .split(sep)
    .join("/");
}

export function piReportedMaskPath(
  brainPath: string,
  _maskPath: string,
  absoluteMaskPath: string,
  _canonicalMaskPath: string
): string {
  // Preserve pi's pre-consolidation reporting rule exactly. BrainAccess.root
  // retains the configured path, so a symlinked repo root makes the canonical
  // filename absolute in the result rather than repo-relative. This uses the
  // filename before destination containment, not the canonical write target,
  // because an existing mask-file symlink historically remained visible.
  return absoluteMaskPath.startsWith(brainPath)
    ? absoluteMaskPath.slice(brainPath.length).replace(/^\//, "")
    : absoluteMaskPath;
}
