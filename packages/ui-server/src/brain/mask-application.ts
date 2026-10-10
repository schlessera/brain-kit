/** Server-owned PNG mask application. No worker-selected binary kind or command. */
import { closeSync, constants, fchmodSync, fstatSync, fsyncSync, lstatSync, openSync, readFileSync, realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { BRAIN_LOCK_KEY, BRAIN_MASK_MAX_BYTES, type BrainMaskInput, type BrainApplicationResult, type KeyedLock } from "@schlessera/brain-ui-sdk/server";
import { assertScratchMask, claudeMaskFilename, piMaskFilename } from "@schlessera/brain-ui-sdk/internal";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");
const PNG_SIGNATURE = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
class MaskRefusal extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const refuse = (code: string, message: string): never => { throw new MaskRefusal(code, message); };
interface Dir { fd: number; path: string; dev: number; ino: number }
interface File { at: string; chain: Dir[]; hash: string | null; mode?: number }
export interface MaskBase { imageHash: string; maskHash: string | null }

function validatePath(path: string): void {
  const parts = path.split("/");
  if (path.length > 1024 || parts.some(p => !p || p === "." || p === "..") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path))
    refuse("invalid_target", "Use an exact repository-relative image path without traversal.");
  const folded = parts.map(p => p.normalize("NFKC").toLowerCase());
  if (folded[0] === "context" && (folded.length === 1 || folded[1] === "policies"))
    refuse("policy_denied", "Masks cannot change policy paths, ancestors or aliases.");
  if (parts.some((p, i) => p.startsWith(".") && !(i === 0 && p === ".brain" && parts[1] === "scratch")))
    refuse("invalid_target", "Masks cannot change configuration or repository metadata.");
}
function read(path: string): { hash: string | null; mode?: number } {
  let fd: number;
  try { fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return { hash: null };
    if (code === "ELOOP") return refuse("alias_denied", "A mask or image target is a symlink.");
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) refuse("alias_denied", "Images and masks must be ordinary files with one link.");
    if (info.size > BRAIN_MASK_MAX_BYTES) refuse("payload_too_large", "Image or mask exceeds the PNG application byte cap.");
    const bytes = readFileSync(fd);
    if (bytes.length > BRAIN_MASK_MAX_BYTES) refuse("payload_too_large", "Image or mask exceeds the PNG application byte cap.");
    return { hash: digest(bytes), mode: info.mode & 0o7777 };
  } finally { closeSync(fd); }
}
function close(file: File) { for (const dir of file.chain.reverse()) closeSync(dir.fd); }
function open(root: string, path: string): File {
  validatePath(path);
  const chain: Dir[] = [];
  try {
    const parts = path.split("/");
    let visible = root;
    for (let i = 0; i < parts.length; i++) {
      const anchored = i === 0 ? root : `/proc/self/fd/${chain.at(-1)!.fd}/${parts[i - 1]}`;
      const fd = openSync(anchored, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      const info = fstatSync(fd);
      chain.push({ fd, path: visible, dev: info.dev, ino: info.ino });
      visible = join(visible, parts[i]!);
    }
    const at = `/proc/self/fd/${chain.at(-1)!.fd}/${parts.at(-1)}`;
    return { at, chain, ...read(at) };
  } catch (error) {
    for (const dir of chain.reverse()) closeSync(dir.fd);
    if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) refuse("alias_denied", "A mask directory is redirected or is not a directory.");
    throw error;
  }
}
function verify(file: File, expected: string | null): void {
  for (const dir of file.chain) {
    const info = lstatSync(dir.path, { throwIfNoEntry: false });
    if (!info?.isDirectory() || info.isSymbolicLink() || info.dev !== dir.dev || info.ino !== dir.ino)
      refuse("topology_changed", "The image or mask directory changed during application.");
  }
  if (read(file.at).hash !== expected) refuse("stale_base", "The image or mask changed while its editor was open; no overwrite was applied.");
}
type MaskBackend = "claude" | "pi";
const maskFilename = (backend: MaskBackend, path: string) =>
  (backend === "pi" ? piMaskFilename : claudeMaskFilename)(path, path);

export function readMaskBase(root: string, imagePath: string, backend: MaskBackend = "claude"): MaskBase {
  root = realpathSync(root);
  if (!/\.(png|jpe?g|webp|gif|avif|heic|bmp|tiff?|svg)$/i.test(imagePath)) refuse("invalid_target", "A mask must belong to a submitted image.");
  const image = open(root, imagePath);
  try {
    if (!image.hash) refuse("missing_image", "The submitted image does not exist.");
    const mask = open(root, maskFilename(backend, imagePath));
    try { verify(image, image.hash); verify(mask, mask.hash); return { imageHash: image.hash!, maskHash: mask.hash }; }
    finally { close(mask); }
  } finally { close(image); }
}

export function createMaskApplication(options: {
  root: string;
  /** Trusted host backend identity; never selected by a worker message. */
  backend?: MaskBackend;
  principalId: string;
  turnId: string;
  signal: AbortSignal;
  lock: Pick<KeyedLock, "withLock">;
  isAuthorized(): boolean;
  isAvailable(): boolean;
  record(result: BrainApplicationResult): void;
  /** Internal race fixture only. */
  beforeCommit?(): void;
}) {
  const root = realpathSync(options.root);
  const authority = (principalId: string, turnId: string) => {
    if (principalId !== options.principalId || turnId !== options.turnId || !options.isAuthorized())
      refuse("authority_revoked", "This mask no longer has current turn authority.");
    if (options.signal.aborted) refuse("cancelled", "The mask turn was cancelled.");
    if (!options.isAvailable()) refuse("membership_denied", "This turn's membership does not permit image masks.");
  };
  return async (request: { principalId: string; turnId: string; input: BrainMaskInput; base: MaskBase }): Promise<BrainApplicationResult> => {
    const changes: BrainApplicationResult["changes"] = [];
    let result: BrainApplicationResult;
    try {
      authority(request.principalId, request.turnId);
      const input = { ...request.input }, base = { ...request.base };
      if (Object.keys(input).some(key => !["imagePath", "maskPath", "png"].includes(key)) || typeof input.imagePath !== "string" || typeof input.maskPath !== "string" || !(input.png instanceof Uint8Array))
        refuse("invalid_request", "Use the exact PNG mask operation.");
      if (input.png.byteLength > BRAIN_MASK_MAX_BYTES) refuse("payload_too_large", "Mask PNG exceeds the 8 MiB byte cap.");
      if (input.png.byteLength < PNG_SIGNATURE.length || !Buffer.from(input.png.subarray(0, 8)).equals(PNG_SIGNATURE))
        refuse("invalid_png", "The submitted mask must have the PNG signature.");
      if (input.maskPath !== maskFilename(options.backend ?? "claude", input.imagePath)) refuse("invalid_target", "Only the mask filename for the submitted image may be applied.");
      validatePath(input.maskPath);
      // Own the bytes before lock admission; caller mutation cannot change the
      // signature, bounds or exact effect after validation.
      const png = Uint8Array.from(input.png);
      result = await options.lock.withLock(BRAIN_LOCK_KEY, async () => {
        authority(request.principalId, request.turnId);
        const current = readMaskBase(root, input.imagePath, options.backend);
        if (current.imageHash !== base.imageHash || current.maskHash !== base.maskHash) refuse("stale_base", "The image or mask changed while its editor was open.");
        const image = open(root, input.imagePath);
        let mask: File;
        try { mask = open(root, input.maskPath); } catch (error) { close(image); throw error; }
        let temp: string | undefined;
        try {
          const scratch = input.maskPath.startsWith(".brain/scratch/");
          if (scratch) assertScratchMask(root, input.maskPath, join(root, input.maskPath));
          temp = `/proc/self/fd/${mask.chain.at(-1)!.fd}/.brain-mask-${crypto.randomUUID()}`;
          const fd = openSync(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, mask.mode ?? 0o600);
          try { if (mask.mode !== undefined) fchmodSync(fd, mask.mode); writeFileSync(fd, png); fsyncSync(fd); } finally { closeSync(fd); }
          options.beforeCommit?.();
          authority(request.principalId, request.turnId); verify(image, base.imageHash); verify(mask, base.maskHash);
          renameSync(temp, mask.at); temp = undefined;
          changes.push({ path: input.maskPath, contentHash: digest(png) }); fsyncSync(mask.chain.at(-1)!.fd);
          let pruneError: string | undefined;
          if (scratch) {
            try {
              const core = await import("@schlessera/brain/internal");
              authority(request.principalId, request.turnId);
              // The existing deterministic policy executes here, under the
              // same lock/authority. Its actual removals join the history.
              const pruned = core.pruneScratch(root);
              for (const removal of pruned.removed) changes.push({ path: removal.path, contentHash: null });
              if (pruned.failed.length) pruneError = "Some scratch files could not be pruned.";
            } catch (error) { pruneError = error instanceof Error ? error.message : String(error); }
          }
          return { ok: true, message: "Applied the PNG mask.", changes, outcome: { maskPath: input.maskPath, ...(pruneError ? { pruneError } : {}) } };
        } finally { if (temp) unlinkSync(temp); close(image); close(mask); }
      }, { signal: options.signal });
    } catch (error) {
      result = { ok: false, code: error instanceof MaskRefusal ? error.code : options.signal.aborted ? "cancelled" : "application_failed", message: error instanceof Error ? error.message : String(error), changes };
    }
    options.record(result); return result;
  };
}
