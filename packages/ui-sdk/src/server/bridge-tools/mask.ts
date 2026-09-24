import { existsSync, lstatSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { dirname, extname, join, relative, resolve, sep } from "path";

import type {
  ImageMaskPayload,
  RequestImageMaskInput,
} from "../../tool-contracts/index.js";
import type { BackendBridge } from "../backend.js";
import { resolveInRepo } from "./resolve-in-repo.js";

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
  assertScratchMask(rootReal, maskRel, maskAbs);
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

/**
 * The brain's scratch area, `.brain/scratch/` (#310). A mask sits beside its
 * image, so an image in scratch puts the mask there too, and the write is
 * held to the scratch rules: not redirected by a symlink, and ignored by git
 * for that very path. Pruning is the server's hourly pass.
 *
 * Kept in lockstep with `packages/core/src/lib/scratch.ts` (`SCRATCH_DIR`,
 * `scratchIgnored`, `scratchDir`): the SDK ports the rule, as it does for
 * `resolveInRepo`, instead of depending on `@schlessera/brain`.
 */
const SCRATCH_DIR = ".brain/scratch";
const SCRATCH_IGNORE_LINE = /^\/?\.brain(\/scratch)?\/?$/;

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function scratchIgnored(rootReal: string, rel: string): boolean {
  const inRepo =
    existsSync(join(rootReal, ".git")) ||
    Bun.spawnSync(["git", "-C", rootReal, "rev-parse", "--git-dir"]).exitCode === 0;
  if (!inRepo) {
    // Outside a repository the line is required all the same: a later
    // `git init` would commit an unignored scratch.
    const ignore = join(rootReal, ".gitignore");
    if (!existsSync(ignore)) return false;
    return readFileSync(ignore, "utf8")
      .split("\n")
      .some((line) => SCRATCH_IGNORE_LINE.test(line.trim()));
  }
  return (
    Bun.spawnSync(["git", "-C", rootReal, "check-ignore", "-q", "--no-index", "--", rel]).exitCode === 0
  );
}

/**
 * Refuse a mask write into the scratch area that the rules would not allow.
 * A mask asked for outside scratch, and landing outside it, is not its
 * business.
 */
export function assertScratchMask(rootReal: string, maskRel: string, maskAbs: string): void {
  const dir = join(rootReal, SCRATCH_DIR);
  const under = (path: string) => path === dir || path.startsWith(dir + sep);
  const asked = under(resolve(rootReal, maskRel));
  const lands = under(maskAbs);
  if (!asked && !lands) return;
  for (const path of [dirname(dir), dir]) {
    if (isSymlink(path)) {
      throw new Error(
        `${SCRATCH_DIR}/ is redirected by a symlink (${relative(rootReal, path)}), so no mask is written there.`
      );
    }
  }
  if (!lands) {
    throw new Error(`${maskRel} resolves outside ${SCRATCH_DIR}/, so no mask is written there.`);
  }
  const rel = relative(rootReal, maskAbs).split(sep).join("/");
  if (!scratchIgnored(rootReal, rel)) {
    throw new Error(
      `${rel} is not gitignored, so a mask written there could be committed to the brain. ` +
        "Run `brain doctor --fix` to add it to .gitignore, then try again."
    );
  }
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
