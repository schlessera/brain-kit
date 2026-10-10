import { randomBytes } from "crypto";
import { closeSync, existsSync, fchmodSync, lstatSync, mkdirSync, mkdtempSync, openSync, realpathSync, renameSync, rmSync, writeSync } from "fs";
import type { Stats } from "fs";
import { tmpdir } from "os";
import { basename, dirname, extname, join, relative, resolve, sep } from "path";

import type {
  ImageMaskPayload,
  RequestImageMaskInput,
} from "../../tool-contracts/index.js";
import type { BackendBridge } from "../backend.js";
import { resolveInRepo } from "./resolve-in-repo.js";

/**
 * Options for `handleRequestImageMask`; the adapter owns the mask filename.
 *
 * @experimental Backend toolkit (#1399); may change before 1.0.
 */
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
 *
 * @experimental Backend toolkit (#1399); may change before 1.0.
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
  // The mask's directory is canonicalized (contained, through no link that
  // escapes); the mask's own name is not, so that an entry that is a link is
  // seen as one and refused by the write, rather than followed to whatever
  // it points at.
  const maskParent = resolveInRepo(options.brainPath, dirname(maskRel));
  if (!maskParent) {
    throw new Error(`Cannot write a mask for ${input.imagePath}`);
  }
  const maskAbs = join(maskParent, basename(maskRel));
  if (!resolveInRepo(options.brainPath, maskRel)) {
    throw new Error(`Cannot write a mask for ${input.imagePath}`);
  }
  if (maskInScratch(rootReal, maskRel, maskAbs)) {
    // Beside a draft in the scratch area: the scratch rules, then the host's
    // prune, the way the CLI's own writers prune after a write (#310).
    assertScratchMask(rootReal, maskRel, maskAbs);
    writeScratchMask(rootReal, maskAbs, png);
    await bridge.pruneScratch?.();
  } else {
    writeMaskFile(maskAbs, png);
  }

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
 * held to the scratch rules: not redirected by a symlink, and the directory
 * excluded by git. The write itself goes to a temporary sibling and is
 * renamed onto its name, and the host's prune runs after it.
 *
 * Kept in lockstep with `packages/core/src/lib/scratch.ts` (`SCRATCH_DIR`,
 * `scratchIgnored`, `scratchDir`, `writeScratchFile`): the SDK ports the rule,
 * as it does for `resolveInRepo`, instead of depending on `@schlessera/brain`.
 */
const SCRATCH_DIR = ".brain/scratch";

const under = (dir: string, path: string) => path === dir || path.startsWith(dir + sep);

function isSymlink(path: string): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

let emptyGitDir: string | null = null;

/** An empty repository, so `check-ignore` can be asked about a brain that is not one. */
function emptyRepository(): string {
  if (emptyGitDir && existsSync(emptyGitDir)) return emptyGitDir;
  const dir = mkdtempSync(join(tmpdir(), "brain-scratch-ignore-"));
  const init = Bun.spawnSync(["git", "init", "-q", "--bare", dir], { stderr: "pipe" });
  if (init.exitCode !== 0) {
    throw new Error(`git init failed, so .gitignore cannot be consulted: ${new TextDecoder().decode(init.stderr).trim()}`);
  }
  emptyGitDir = dir;
  return dir;
}

/**
 * Whether git excludes the scratch DIRECTORY (the only exclusion nothing
 * below it can re-include): `check-ignore` on the directory path, which has
 * to exist, and outside a repository the same question through an empty one.
 */
function scratchIgnored(rootReal: string): boolean {
  mkdirSync(join(rootReal, SCRATCH_DIR), { recursive: true });
  const inRepo =
    existsSync(join(rootReal, ".git")) ||
    Bun.spawnSync(["git", "-C", rootReal, "rev-parse", "--git-dir"]).exitCode === 0;
  const argv = inRepo
    ? ["git", "check-ignore", "-q", "--no-index", "--", SCRATCH_DIR]
    : ["git", `--git-dir=${emptyRepository()}`, `--work-tree=${rootReal}`, "check-ignore", "-q", "--no-index", "--", SCRATCH_DIR];
  return Bun.spawnSync(argv, { cwd: rootReal }).exitCode === 0;
}

/** The scratch directory, verified: neither `.brain` nor `.brain/scratch` is a symlink. */
function scratchDir(rootReal: string): string {
  const dir = join(rootReal, SCRATCH_DIR);
  for (const path of [dirname(dir), dir]) {
    if (isSymlink(path)) {
      throw new Error(
        `${SCRATCH_DIR}/ is redirected by a symlink (${relative(rootReal, path)}), so no mask is written there.`
      );
    }
  }
  if (existsSync(dir) && realpathSync(dir) !== dir) {
    throw new Error(`${SCRATCH_DIR}/ resolves to ${realpathSync(dir)}, so no mask is written there.`);
  }
  return dir;
}

/** Whether the mask is asked to go into scratch, or resolves into it. */
export function maskInScratch(rootReal: string, maskRel: string, maskAbs: string): boolean {
  const dir = join(rootReal, SCRATCH_DIR);
  return under(dir, resolve(rootReal, maskRel)) || under(dir, maskAbs);
}

/**
 * Refuse a mask write into the scratch area that the rules would not allow:
 * a redirected scratch, a target resolving out of it, or a directory git
 * does not exclude. A mask asked for outside scratch, and landing outside
 * it, is not its business.
 */
export function assertScratchMask(rootReal: string, maskRel: string, maskAbs: string): void {
  if (!maskInScratch(rootReal, maskRel, maskAbs)) return;
  const dir = scratchDir(rootReal);
  if (!under(dir, maskAbs)) {
    throw new Error(`${maskRel} resolves outside ${SCRATCH_DIR}/, so no mask is written there.`);
  }
  if (!scratchIgnored(rootReal)) {
    throw new Error(
      `${SCRATCH_DIR}/ is not gitignored as a directory, so a mask written there could be committed to the brain. ` +
        "Run `brain doctor --fix` to add it to .gitignore, then try again."
    );
  }
}

/**
 * Create `tmp` exclusively and fill it; when it replaces a regular file it
 * takes that file's exact mode first (the port of core's `writeExclusive`),
 * so a mask never becomes readable more widely than the one it replaces.
 */
function writeMaskExclusive(tmp: string, png: Uint8Array, existing: Stats | undefined): void {
  const mode = existing?.isFile() ? existing.mode & 0o7777 : undefined;
  const fd = openSync(tmp, "wx", mode);
  try {
    if (mode !== undefined) fchmodSync(fd, mode);
    let offset = 0;
    while (offset < png.byteLength) offset += writeSync(fd, png, offset, png.byteLength - offset);
  } finally {
    closeSync(fd);
  }
}

/**
 * Write a mask outside the scratch area, never through a link: the entry
 * itself may not be a symlink or a directory, and the bytes go to a random
 * temporary sibling renamed onto the name once the directory is re-verified
 * to be exactly itself. The port of core's `writeFileSafely`; a mask
 * replaces an earlier mask of the same name, as it always did.
 */
export function writeMaskFile(maskAbs: string, png: Uint8Array): void {
  const parent = dirname(maskAbs);
  mkdirSync(parent, { recursive: true });
  const genuine = (): boolean => {
    try {
      return realpathSync(parent) === parent && lstatSync(parent).isDirectory();
    } catch {
      return false;
    }
  };
  const swapped = () => new Error(`${parent} is not a directory of its own, so no mask is written there.`);
  if (!genuine()) throw swapped();
  const tmp = join(parent, `.${basename(maskAbs)}.${randomBytes(4).toString("hex")}.tmp`);
  writeMaskExclusive(tmp, png, lstatSync(maskAbs, { throwIfNoEntry: false }));
  try {
    if (!genuine()) throw swapped();
    const entry = lstatSync(maskAbs, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) throw new Error(`${maskAbs} is a symlink, so no mask is written through it.`);
    if (entry?.isDirectory()) throw new Error(`${maskAbs} is a directory, so no mask is written there.`);
    renameSync(tmp, maskAbs);
  } catch (error) {
    if (genuine()) rmSync(tmp, { force: true });
    throw error;
  }
}

/**
 * Write a mask into the scratch area: the port of core's `writeScratchFile`.
 * At the moment of the write, the chain is re-verified, the target's
 * directory must be exactly what its path says (no symlink at any segment),
 * the target's own entry must not be a link or a directory, and the bytes go
 * to a random temporary sibling that is renamed onto the name. A rename
 * replaces the directory entry: it never writes through a planted link, nor
 * into an inode a hard link shares with a file elsewhere. A mask replaces an
 * earlier mask of the same name, as it always did.
 */
export function writeScratchMask(rootReal: string, maskAbs: string, png: Uint8Array): void {
  const dir = scratchDir(rootReal);
  if (!scratchIgnored(rootReal)) {
    throw new Error(`${SCRATCH_DIR}/ is not gitignored as a directory; run \`brain doctor --fix\`.`);
  }
  const rel = relative(rootReal, maskAbs);
  if (!under(dir, maskAbs)) throw new Error(`${rel} is outside ${SCRATCH_DIR}/, so no mask is written there.`);
  const parent = dirname(maskAbs);
  let path = dir;
  for (const segment of ["", ...(parent === dir ? [] : relative(dir, parent).split(sep))]) {
    if (segment) path = join(path, segment);
    let s = lstatSync(path, { throwIfNoEntry: false });
    if (!s) {
      mkdirSync(path);
      s = lstatSync(path);
    }
    if (s.isSymbolicLink() || !s.isDirectory()) {
      throw new Error(`${relative(rootReal, path)} is not a directory of its own, so no mask is written there.`);
    }
  }
  // Re-verified immediately before the rename, and before the temporary
  // file is removed on failure: a directory swapped for a link while the
  // temporary file was being written is refused rather than renamed or
  // removed through. The one syscall between the check and the rename
  // remains, as in core's primitive.
  const genuine = (): boolean => {
    try {
      scratchDir(rootReal);
      return realpathSync(parent) === parent && lstatSync(parent).isDirectory();
    } catch {
      return false;
    }
  };
  const swapped = () =>
    new Error(`${relative(rootReal, parent)} is no longer a directory of its own, so no mask is written there.`);
  if (!genuine()) throw swapped();
  const tmp = join(parent, `.${basename(maskAbs)}.${randomBytes(4).toString("hex")}.tmp`);
  writeMaskExclusive(tmp, png, lstatSync(maskAbs, { throwIfNoEntry: false }));
  try {
    if (!genuine()) throw swapped();
    const entry = lstatSync(maskAbs, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) throw new Error(`${rel} is a symlink, so no mask is written there.`);
    if (entry?.isDirectory()) throw new Error(`${rel} is a directory, so no mask is written there.`);
    renameSync(tmp, maskAbs);
  } catch (error) {
    if (genuine()) rmSync(tmp, { force: true });
    throw error;
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
