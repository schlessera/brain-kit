/**
 * Server-owned markup layer application (#3975). The browser's layer is
 * written only here, only under `.brain/scratch/markup/`, under a name the
 * server derives from the source; no worker or client names a destination.
 *
 * Before commit, under the application lock, it rechecks what the mask
 * application rechecks: the source's hash, the directory chain's topology,
 * the policy-protected targets, live turn authority and membership. A layer
 * never replaces an earlier one: each submission takes the first free name.
 */
import { closeSync, constants, fstatSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, unlinkSync, writeFileSync } from "node:fs";
import { inflateSync } from "node:zlib";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { imageHeader, isPng } from "@schlessera/brain-common/internal/image-header";
import {
  BRAIN_LOCK_KEY,
  BRAIN_MARKUP_DIR,
  BRAIN_MARKUP_MAX_BYTES,
  BRAIN_MARKUP_MAX_PIXELS,
  BRAIN_MARKUP_SOURCE_MAX_BYTES,
  type BrainApplicationResult,
  type KeyedLock,
} from "@schlessera/brain-ui-sdk/server";
import { assertScratchMaskAsync } from "@schlessera/brain-ui-sdk/internal";
import { createProtectedTargetCheck, protectedPlaces } from "./protected-target.js";
import { admitHeld, AuthorityHeld, retryHeld, type AuthorityHold } from "./authority-hold.js";
import type { AppliedEffect, TurnDataTree } from "./turn-data-tree.js";

const digest = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

export class MarkupRefusal extends Error {
  constructor(readonly code: string, message: string) { super(message); }
}
const refuse = (code: string, message: string): never => { throw new MarkupRefusal(code, message); };

interface Dir { fd: number; path: string; dev: number; ino: number }
interface Held { chain: Dir[]; at: string }
interface Source extends Held { hash: string; width: number; height: number }

/** What the editor was opened on: the source's bytes and displayed size. */
interface MarkupBase { imageHash: string; width: number; height: number }

/** The most names one source's layers take before a submission is refused. */
const MAX_NAME_ATTEMPTS = 1000;

/** The same path rules as a mask's source: exact, no traversal, no metadata or policy. */
function validatePath(path: string, what: "image" | "layer"): void {
  const parts = path.split("/");
  if (path.length > 1024 || parts.some(p => !p || p === "." || p === "..") || path.includes("\\") || /[\u0000-\u001f\u007f]/.test(path))
    refuse("invalid_target", "Use an exact repository-relative image path without traversal.");
  const folded = parts.map(p => p.normalize("NFKC").toLowerCase());
  if (folded[0] === "context" && (folded.length === 1 || folded[1] === "policies"))
    refuse("policy_denied", "Markup cannot read or write policy paths, ancestors or aliases.");
  if (parts.some((p, i) => p.startsWith(".") && !(what === "layer" && i === 0 && p === ".brain" && parts[1] === "scratch")))
    refuse("invalid_target", "Markup cannot read or write configuration or repository metadata.");
}

function closeHeld(held: Held | undefined): void {
  if (!held) return;
  for (const dir of held.chain.reverse()) closeSync(dir.fd);
  held.chain.length = 0;
}

/**
 * Open each directory of `parts` from its parent's descriptor, never through
 * a link; `create` makes a missing segment, through that same descriptor.
 */
function openChain(root: string, parts: readonly string[], create: boolean): Dir[] {
  const chain: Dir[] = [];
  const flags = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
  try {
    let visible = root;
    for (let i = 0; i <= parts.length; i++) {
      const at = i === 0 ? root : `/proc/self/fd/${chain.at(-1)!.fd}/${parts[i - 1]}`;
      if (i > 0) visible = join(visible, parts[i - 1]!);
      let fd: number;
      try { fd = openSync(at, flags); }
      catch (error) {
        if (!create || (error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        try { mkdirSync(at, 0o700); } catch (mkdirError) { if ((mkdirError as NodeJS.ErrnoException).code !== "EEXIST") throw mkdirError; }
        fd = openSync(at, flags);
      }
      try { const info = fstatSync(fd); chain.push({ fd, path: visible, dev: info.dev, ino: info.ino }); }
      catch (error) { closeSync(fd); throw error; }
    }
    return chain;
  } catch (error) {
    for (const dir of chain.reverse()) closeSync(dir.fd);
    if (["ELOOP", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""))
      refuse("alias_denied", "A markup directory is redirected or is not a directory.");
    throw error;
  }
}

function verifyChain(chain: readonly Dir[]): void {
  for (const dir of chain) {
    const info = lstatSync(dir.path, { throwIfNoEntry: false });
    if (!info?.isDirectory() || info.isSymbolicLink() || info.dev !== dir.dev || info.ino !== dir.ino)
      refuse("topology_changed", "The image or markup directory changed during application.");
  }
}

/** The source's bytes through its held parent: an ordinary file with one link, within the source bound. */
function readSource(at: string): Buffer {
  let fd: number;
  try { fd = openSync(at, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
  catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return refuse("missing_image", "The submitted image does not exist.");
    if (code === "ELOOP") return refuse("alias_denied", "The image to mark up is a symlink.");
    throw error;
  }
  try {
    const info = fstatSync(fd);
    if (!info.isFile() || info.nlink !== 1) refuse("alias_denied", "The image to mark up must be an ordinary file with one link.");
    if (info.size > BRAIN_MARKUP_SOURCE_MAX_BYTES) refuse("payload_too_large", `The image to mark up is over the ${BRAIN_MARKUP_SOURCE_MAX_BYTES}-byte source bound.`);
    const bytes = readFileSync(fd);
    if (bytes.length > BRAIN_MARKUP_SOURCE_MAX_BYTES) refuse("payload_too_large", `The image to mark up is over the ${BRAIN_MARKUP_SOURCE_MAX_BYTES}-byte source bound.`);
    return bytes;
  } finally { closeSync(fd); }
}

function openSource(root: string, imagePath: string): Source {
  validatePath(imagePath, "image");
  if (!/\.(png|jpe?g|webp)$/i.test(imagePath)) refuse("invalid_target", "Markup needs a PNG, JPEG or WebP image.");
  const parts = imagePath.split("/");
  const chain = openChain(root, parts.slice(0, -1), false);
  const held: Held = { chain, at: `/proc/self/fd/${chain.at(-1)!.fd}/${parts.at(-1)}` };
  try {
    const bytes = readSource(held.at);
    const header = imageHeader(bytes);
    if (!header) refuse("invalid_image", "Cannot read the width and height of the image; markup needs a PNG, JPEG or WebP.");
    if (header!.width < 1 || header!.height < 1 || header!.width * header!.height > BRAIN_MARKUP_MAX_PIXELS)
      refuse("invalid_image", `The image is ${header!.width}x${header!.height}, over the ${BRAIN_MARKUP_MAX_PIXELS.toLocaleString("en-US")}-pixel limit for markup edits.`);
    return { ...held, hash: digest(bytes), width: header!.width, height: header!.height };
  } catch (error) { closeHeld(held); throw error; }
}

/**
 * The bound source's bytes for the open editor, only while they still hash
 * to `imageHash`: the editor draws on exactly the image the layer will be
 * checked against, through no route whose size bound is narrower.
 */
export function readMarkupSource(root: string, imagePath: string, imageHash: string): { bytes: Buffer; type: string } {
  const source = openSource(realpathSync(root), imagePath);
  try {
    const bytes = readSource(source.at);
    if (digest(bytes) !== imageHash) refuse("stale_base", "The image changed while its markup editor was open.");
    const format = imageHeader(bytes)!.format;
    return { bytes, type: format === "jpeg" ? "image/jpeg" : `image/${format}` };
  } finally { closeHeld(source); }
}

/** Read the source the editor opens on; refuses before anything is shown. */
export function readMarkupBase(root: string, imagePath: string): MarkupBase {
  const source = openSource(realpathSync(root), imagePath);
  try { verifyChain(source.chain); return { imageHash: source.hash, width: source.width, height: source.height }; }
  finally { closeHeld(source); }
}

/**
 * The layer's name: `<stem>.<sha8>.markup.png`, then `-2`, `-3` … when an
 * earlier layer of the same source holds the name. The stem keeps letters,
 * digits, `.`, `_` and `-` of the source's file name, never leading a dot.
 */
export function markupFilename(imagePath: string, imageHash: string, attempt = 1): string {
  const name = imagePath.split("/").at(-1)!.replace(/\.[^.]*$/, "");
  const stem = name.normalize("NFKC").replace(/[^A-Za-z0-9._-]+/g, "-").replace(/^[.-]+/, "").slice(0, 80) || "image";
  return `${stem}.${imageHash.slice(0, 8)}${attempt > 1 ? `-${attempt}` : ""}.markup.png`;
}

/** Why a layer cannot go with this source, as a refusal; the CLI's `markupProblem` rules. */
function validateLayer(png: Uint8Array, base: Pick<MarkupBase, "width" | "height">): void {
  if (png.byteLength === 0) refuse("empty_markup", "The markup layer is empty.");
  if (png.byteLength > BRAIN_MARKUP_MAX_BYTES)
    refuse("payload_too_large", `The markup layer is ${png.byteLength} bytes; the limit is ${BRAIN_MARKUP_MAX_BYTES} bytes (50 MiB).`);
  if (!isPng(png)) refuse("invalid_png", "The markup layer must be a PNG.");
  const header = imageHeader(png);
  if (!header) refuse("invalid_png", "The markup layer has no readable PNG header.");
  if (!header!.alpha) refuse("invalid_png", "The markup layer has no alpha channel, so it is not a transparent layer.");
  if (header!.width !== base.width || header!.height !== base.height)
    refuse("invalid_dimensions", `The markup layer is ${header!.width}x${header!.height} but the image is ${base.width}x${base.height}; it must match exactly.`);
  if (!pngHasInk(png, header!.width, header!.height)) refuse("empty_markup", "The markup layer is fully transparent: nothing was drawn.");
}

const CHANNELS: Record<number, number> = { 0: 1, 2: 3, 3: 1, 4: 2, 6: 4 };

/**
 * Decode the layer's structure (#3975): IHDR first, its chunks within the
 * file, one complete zlib image stream of exactly the size its header
 * promises, valid row filters; and whether any pixel is not all zero. A
 * fabricated header with no image data, a truncated stream or a stream that
 * inflates past its rows refuses. An all-zero image is fully transparent.
 */
function pngHasInk(png: Uint8Array, width: number, height: number): boolean {
  const data = Buffer.from(png.buffer, png.byteOffset, png.byteLength);
  const idat: Buffer[] = [];
  let ihdr: Buffer | undefined, ended = false;
  for (let at = 8; at < data.length && !ended; ) {
    if (at + 12 > data.length) refuse("invalid_png", "The markup layer's PNG chunks are truncated.");
    const length = data.readUInt32BE(at);
    const type = data.toString("latin1", at + 4, at + 8);
    if (at + 12 + length > data.length) refuse("invalid_png", "The markup layer's PNG chunks are truncated.");
    const body = data.subarray(at + 8, at + 8 + length);
    if (!ihdr && type !== "IHDR") refuse("invalid_png", "The markup layer's PNG does not start with its header.");
    if (type === "IHDR") ihdr = body;
    else if (type === "IDAT") idat.push(body);
    else if (type === "IEND") ended = true;
    at += 12 + length;
  }
  if (!ihdr || ihdr.length !== 13 || !ended || idat.length === 0) refuse("invalid_png", "The markup layer is not a complete PNG.");
  const depth = ihdr![8]!, colorType = ihdr![9]!, interlace = ihdr![12]!;
  const channels = CHANNELS[colorType];
  if (!channels || ![1, 2, 4, 8, 16].includes(depth) || interlace !== 0)
    refuse("invalid_png", "The markup layer must be a non-interlaced PNG of a standard colour type.");
  const rowBytes = Math.ceil((width * channels! * depth) / 8);
  const expected = height * (1 + rowBytes);
  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(idat), { maxOutputLength: expected + 1 }); }
  catch { return refuse("invalid_png", "The markup layer's image data does not decode."); }
  if (raw.length !== expected) refuse("invalid_png", "The markup layer's image data does not match its size.");
  let ink = false;
  for (let row = 0; row < height; row++) {
    const at = row * (1 + rowBytes);
    if (raw[at]! > 4) refuse("invalid_png", "The markup layer's image data has an invalid row filter.");
    // Every PNG filter maps an all-zero image to all-zero bytes and back, so
    // a nonzero filtered byte is a nonzero pixel.
    if (!ink) for (let i = at + 1; i <= at + rowBytes; i++) if (raw[i] !== 0) { ink = true; break; }
  }
  return ink;
}

interface MarkupOutcome { markupPath: string; bytes: number; width: number; height: number; pruneError?: string; durabilityError?: string }

export function createMarkupApplication(options: {
  maintenance?: import("@schlessera/brain-ui-sdk/internal").MaintenanceHost;
  root: string;
  principalId: string;
  turnId: string;
  signal: AbortSignal;
  lock: Pick<KeyedLock, "withLock">;
  /** Immutable admitted host facts; not a browser or worker permission. */
  protectedPaths?: readonly string[];
  /** Whether the layer may commit now; false while a `hold` is active as well as once authority is gone. */
  isAuthorized(): boolean;
  hold?: AuthorityHold;
  isAvailable(): boolean;
  record(result: BrainApplicationResult): void;
  turnTree?: Pick<TurnDataTree, "commit">;
  /** Internal race fixtures only. */
  beforeCommit?(): void;
  afterLink?(): void;
}) {
  const root = realpathSync(options.root);
  const protectedPaths = [...(options.protectedPaths ?? [])];
  const isProtected = options.protectedPaths ? createProtectedTargetCheck(root, protectedPaths, { links: "refused" }) : undefined;
  const validateTarget = (path: string, what: "image" | "layer"): void => {
    validatePath(path, what);
    if (isProtected?.(path)) refuse("policy_denied", "This markup target is protected by the policy admitted for this turn; no change was applied.");
  };
  const authority = (principalId: string, turnId: string) => {
    if (principalId !== options.principalId || turnId !== options.turnId) refuse("authority_revoked", "This markup no longer has current turn authority.");
    if (!options.isAuthorized()) {
      if (options.signal.aborted) refuse("cancelled", "The markup turn was cancelled.");
      if (options.hold?.active()) throw new AuthorityHeld();
      refuse("authority_revoked", "This markup no longer has current turn authority.");
    }
    if (options.signal.aborted) refuse("cancelled", "The markup turn was cancelled.");
    if (!options.isAvailable()) refuse("membership_denied", "This turn's membership does not permit image markup.");
  };
  const dirParts = BRAIN_MARKUP_DIR.split("/");
  return async (request: { principalId: string; turnId: string; imagePath: string; png: Uint8Array; base: MarkupBase }): Promise<BrainApplicationResult & { outcome?: MarkupOutcome }> => {
    const changes: BrainApplicationResult["changes"] = [];
    let result: BrainApplicationResult & { outcome?: MarkupOutcome };
    const budget: { deadline?: number } = {};
    const expired = (): never => options.signal.aborted ? refuse("cancelled", "The markup turn was cancelled.")
      : refuse("application_failed", "This markup stayed held by a journal observation or a scope pause past the wait bound; no change was applied.");
    const afterHolds = <T>(attempt: () => T | Promise<T>) => retryHeld(options.hold, options.signal, attempt, expired, budget);
    try {
      const admitted = admitHeld(options.hold, options.signal, () => authority(request.principalId, request.turnId), expired, budget);
      if (admitted) await admitted;
      if (typeof request.imagePath !== "string" || !(request.png instanceof Uint8Array)) refuse("invalid_request", "Use the exact markup layer operation.");
      const base = { ...request.base };
      validateTarget(request.imagePath, "image");
      validateLayer(request.png, base);
      // Own the bytes before lock admission: a caller's later mutation cannot
      // change what was validated.
      const png = Uint8Array.from(request.png);
      const first = `${BRAIN_MARKUP_DIR}/${markupFilename(request.imagePath, base.imageHash)}`;
      const hostedQuery = Boolean(options.maintenance?.scratchIgnoreQuery);
      if (hostedQuery) {
        validateTarget(first, "layer");
        await assertScratchMaskAsync(root, first, join(root, first), options.maintenance, options.signal, "markup layer");
      }
      result = await afterHolds(() => options.lock.withLock(BRAIN_LOCK_KEY, async () => {
        authority(request.principalId, request.turnId);
        validateTarget(request.imagePath, "image");
        validateTarget(first, "layer");
        if (!hostedQuery) await assertScratchMaskAsync(root, first, join(root, first), options.maintenance, options.signal, "markup layer");
        const source = openSource(root, request.imagePath);
        let dir: Dir[] | undefined;
        let temp: string | undefined;
        const effects: AppliedEffect[] = [];
        try {
          if (source.hash !== base.imageHash || source.width !== base.width || source.height !== base.height)
            refuse("stale_base", "The image changed while its markup editor was open; no layer was written.");
          dir = openChain(root, dirParts, true);
          const at = `/proc/self/fd/${dir.at(-1)!.fd}`;
          temp = `${at}/.brain-markup-${crypto.randomUUID()}`;
          // The staged inode stays open: what is published is checked to be
          // this inode, holding exactly these bytes, not whatever the
          // temporary's name points at by the time it is linked.
          const fd = openSync(temp, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
          let markupPath: string | undefined;
          try {
            writeFileSync(fd, png); fsyncSync(fd);
            const staged = fstatSync(fd);
            options.beforeCommit?.();
            authority(request.principalId, request.turnId);
            verifyChain(source.chain); verifyChain(dir);
            if (digest(readSource(source.at)) !== base.imageHash)
              refuse("stale_base", "The image changed while its markup editor was open; no layer was written.");
            // A link never replaces an entry: an earlier layer, or anything
            // planted at the name, keeps its bytes and the next name is taken.
            let name: string | undefined;
            for (let attempt = 1; attempt <= MAX_NAME_ATTEMPTS && !name; attempt++) {
              const candidate = markupFilename(request.imagePath, base.imageHash, attempt);
              validateTarget(`${BRAIN_MARKUP_DIR}/${candidate}`, "layer");
              try { linkSync(temp, `${at}/${candidate}`); name = candidate; }
              catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
            }
            if (!name) refuse("application_failed", "Every layer name for this image is taken; no layer was written.");
            const published = `${at}/${name}`;
            options.afterLink?.();
            const entry = lstatSync(published, { throwIfNoEntry: false });
            const bytes = Buffer.alloc(png.byteLength + 1);
            const length = readSync(fd, bytes, 0, bytes.length, 0);
            const same = entry?.isFile() && entry.dev === staged.dev && entry.ino === staged.ino
              && length === png.byteLength && digest(bytes.subarray(0, length)) === digest(png);
            let moved = false;
            try { verifyChain(dir); } catch { moved = true; }
            if (!same || moved) {
              // Only the name this operation just created is removed, through
              // the held directory, wherever that directory now is.
              unlinkSync(published);
              refuse(moved ? "topology_changed" : "staging_changed", moved
                ? "The markup directory changed during application; no layer was written."
                : "The staged markup layer changed before it was published; no layer was written.");
            }
            markupPath = `${BRAIN_MARKUP_DIR}/${name}`;
            // Recorded the moment the layer exists, so a later cleanup or
            // durability failure never hides a committed write.
            changes.push({ path: markupPath, contentHash: digest(png) });
            effects.push({ path: markupPath, content: png, base: null });
          } finally { closeSync(fd); }
          let durabilityError: string | undefined;
          try { unlinkSync(temp); temp = undefined; fsyncSync(dir.at(-1)!.fd); }
          catch (error) { durabilityError = error instanceof Error ? error.message : String(error); }
          let pruneError: string | undefined;
          try {
            const core = await import("@schlessera/brain/internal");
            authority(request.principalId, request.turnId);
            // The layer this operation just wrote is protected from its own
            // cleanup; later passes apply the usual scratch policy.
            const pruned = core.pruneScratch(root, Date.now(), { pinnedPaths: new Set([markupPath!]),
              protectedPaths: options.protectedPaths ? protectedPlaces(root, protectedPaths) : protectedPaths });
            for (const removal of pruned.removed) {
              changes.push({ path: removal.path, contentHash: null });
              effects.push({ path: removal.path, content: null, base: null });
            }
            if (pruned.failed.length) pruneError = "Some scratch files could not be pruned.";
          } catch (error) { pruneError = error instanceof Error ? error.message : String(error); }
          return { ok: true, message: "Applied the markup layer.", changes,
            outcome: { markupPath: markupPath!, bytes: png.byteLength, width: base.width, height: base.height,
              ...(pruneError ? { pruneError } : {}), ...(durabilityError ? { durabilityError } : {}) } };
        } finally {
          // Partial failures included: the tree follows exactly what committed.
          options.turnTree?.commit(effects);
          if (temp) { try { unlinkSync(temp); } catch { /* the temporary is already gone */ } }
          closeHeld(source);
          if (dir) for (const entry of dir.reverse()) closeSync(entry.fd);
        }
      }, { signal: options.signal }));
    } catch (error) {
      result = { ok: false, code: error instanceof MarkupRefusal ? error.code : options.signal.aborted ? "cancelled" : "application_failed", message: error instanceof Error ? error.message : String(error), changes };
    }
    options.record(result); return result;
  };
}
