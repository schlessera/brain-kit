import { randomBytes } from "crypto";
import { closeSync, constants, existsSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, realpathSync, renameSync, rmSync, writeSync } from "fs";
import type { Stats } from "fs";
import { basename, dirname, extname, join, parse, relative, resolve, sep } from "path";

import type {
  ImageMaskPayload,
  RequestImageMaskInput,
} from "../../tool-contracts/index.js";
import type { BackendBridge } from "../backend.js";
import { resolveInRepo } from "./resolve-in-repo.js";
import { brainGitSync } from "../maintenance-worker.js";

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
 * Both replace the same existing mask filename, so changing either derivation could
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
  if (bridge.applyImageMask) {
    const result = await bridge.applyImageMask({ imagePath: input.imagePath, maskPath: maskRel, png });
    if (!result.ok) throw new Error(result.message);
  } else if (maskInScratch(rootReal, maskRel, maskAbs)) {
    // Beside a draft in the scratch area: the scratch rules, then the host's
    // prune, the way the CLI's own writers prune after a write (#310).
    assertScratchMask(rootReal, maskRel, maskAbs);
    writeScratchMask(rootReal, maskAbs, png);
    await bridge.pruneScratch?.([relative(rootReal, maskAbs).split(sep).join("/")]);
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

/**
 * Whether git excludes the scratch DIRECTORY (the only exclusion nothing
 * below it can re-include): `check-ignore` on the directory path, which has
 * to exist, and outside a repository the same question through an empty one.
 */
function scratchIgnored(rootReal: string): boolean {
  requireScratchDescriptors();
  // Creating the directory is a write too: a scratch/.brain replacement must
  // not redirect even this setup step outside the held directory chain.
  const directory = openMaskDirectory(join(rootReal, SCRATCH_DIR));
  try { directory.verify(); } finally { directory.close(); }
  // Git reads the brain's configuration and ignore files, so it answers from
  // a maintenance worker (#1648); one that cannot run refuses the mask.
  const inRepo =
    existsSync(join(rootReal, ".git")) ||
    brainGitSync(rootReal, ["rev-parse", "--git-dir"]) === 0;
  const query = ["check-ignore", "-q", "--no-index", "--", SCRATCH_DIR];
  return brainGitSync(rootReal, query, inRepo ? {} : { emptyRepository: true }) === 0;
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

/** Scratch fallback never substitutes a path-only write on an unqualified host. */
function requireScratchDescriptors(): void {
  if (process.platform !== "linux") {
    throw new Error("Scratch mask fallback requires Linux descriptor paths; provide bridge.applyImageMask on another host.");
  }
}

/** A held directory chain: every mkdir/open goes through its parent's descriptor. */
function openMaskDirectory(directory: string) {
  const absolute = resolve(directory);
  const root = parse(absolute).root;
  const parts = relative(root, absolute).split(sep).filter(Boolean);
  const chain: Array<{ fd: number; visible: string; dev: number; ino: number }> = [];
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  const changed = () => new Error(`${absolute} is no longer a directory of its own, so no mask is written there.`);
  const close = () => { for (const entry of chain.reverse()) closeSync(entry.fd); };
  try {
    let visible = root;
    let at = root;
    for (const segment of ["", ...parts]) {
      if (segment) {
        at = `/proc/self/fd/${chain.at(-1)!.fd}/${segment}`;
        visible = join(visible, segment);
      }
      let fd: number;
      try { fd = openSync(at, flags); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try { mkdirSync(at); } catch (mkdirError) {
          if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError;
        }
        fd = openSync(at, flags);
      }
      try {
        const info = fstatSync(fd);
        chain.push({ fd, visible, dev: info.dev, ino: info.ino });
      } catch (error) { closeSync(fd); throw error; }
    }
    return {
      at: `/proc/self/fd/${chain.at(-1)!.fd}`,
      verify() {
        for (const entry of chain) {
          const current = lstatSync(entry.visible, { throwIfNoEntry: false });
          if (!current?.isDirectory() || current.isSymbolicLink() || current.dev !== entry.dev || current.ino !== entry.ino) throw changed();
        }
      },
      close,
    };
  } catch (error) {
    close();
    if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) {
      throw new Error(`${absolute} is not a directory of its own, so no mask is written there.`);
    }
    throw error;
  }
}

/** A Linux fallback write that never resolves an untrusted parent path after opening it. */
function writeAnchoredMaskFile(maskAbs: string, png: Uint8Array): void {
  const directory = openMaskDirectory(dirname(maskAbs));
  const target = join(directory.at, basename(maskAbs));
  const tmp = join(directory.at, `.${basename(maskAbs)}.${randomBytes(4).toString("hex")}.tmp`);
  let temporary = false;
  try {
    directory.verify();
    writeMaskExclusive(tmp, png, lstatSync(target, { throwIfNoEntry: false }), true);
    temporary = true;
    directory.verify();
    const entry = lstatSync(target, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) throw new Error(`${maskAbs} is a symlink, so no mask is written through it.`);
    if (entry?.isDirectory()) throw new Error(`${maskAbs} is a directory, so no mask is written there.`);
    renameSync(tmp, target);
    temporary = false;
    // A swap at rename cannot redirect the syscall; still refuse a stale
    // visible destination rather than return a successful lexical mask path.
    directory.verify();
  } finally {
    try { if (temporary) rmSync(tmp, { force: true }); } finally { directory.close(); }
  }
}

/**
 * Create `tmp` exclusively and fill it; when it replaces a regular file it
 * takes that file's exact mode first (the port of core's `writeExclusive`),
 * so a mask never becomes readable more widely than the one it replaces.
 */
function writeMaskExclusive(tmp: string, png: Uint8Array, existing: Stats | undefined, anchored = false): void {
  const mode = existing?.isFile() ? existing.mode & 0o7777 : undefined;
  const fd = openSync(tmp, "wx", mode);
  try {
    if (mode !== undefined) fchmodSync(fd, mode);
    let offset = 0;
    while (offset < png.byteLength) offset += writeSync(fd, png, offset, png.byteLength - offset);
  } catch (error) {
    // The exclusive open succeeded. Only the held-parent path permits
    // cleanup here: the legacy non-scratch branch retains its old behavior.
    if (anchored) rmSync(tmp, { force: true });
    throw error;
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
  if (process.platform === "linux") return writeAnchoredMaskFile(maskAbs, png);
  const parts = resolve(maskAbs).split(sep);
  if (parts.some((part, i) => part === ".brain" && parts[i + 1] === "scratch")) requireScratchDescriptors();
  // Ordinary non-scratch toolkit writes retain their existing behavior on
  // platforms without Linux descriptor paths. Hosted scratch already needs
  // Linux maintenance workers; it never uses this path-only branch.
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
 * Every directory is opened with O_NOFOLLOW | O_DIRECTORY from a held
 * parent descriptor, including mkdir, temp open, rename and error cleanup.
 * The visible chain is re-verified so a changed destination is refused;
 * every syscall still targets the held directory if it changes after a check.
 * The target's directory must be exactly what its path says (no symlink at any segment),
 * the target's own entry must not be a link or a directory, and the bytes go
 * to a random temporary sibling that is renamed onto the name. A rename
 * replaces the directory entry: it never writes through a planted link, nor
 * into an inode a hard link shares with a file elsewhere. A mask replaces an
 * earlier mask of the same name, as it always did.
 */
export function writeScratchMask(rootReal: string, maskAbs: string, png: Uint8Array): void {
  requireScratchDescriptors();
  const dir = scratchDir(rootReal);
  if (!scratchIgnored(rootReal)) {
    throw new Error(`${SCRATCH_DIR}/ is not gitignored as a directory; run \`brain doctor --fix\`.`);
  }
  const absolute = resolve(maskAbs);
  const rel = relative(rootReal, absolute);
  if (!under(dir, absolute)) throw new Error(`${rel} is outside ${SCRATCH_DIR}/, so no mask is written there.`);
  if (absolute === dir) throw new Error(`${SCRATCH_DIR}/ is a directory, so no mask is written there.`);
  writeAnchoredMaskFile(absolute, png);
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
