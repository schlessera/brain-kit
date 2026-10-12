/**
 * Turn temp and the promotion of linked turn-temp files (#1655).
 *
 * Turn temp is everything a worker may write that dies with the turn: `/tmp`
 * (with `$BRAIN_WORKER_SCRATCH` and the XDG fallback below it) and the writes
 * of the per-turn `$HOME` overlay. It used to be a tmpfs mounted inside
 * bubblewrap, which only the worker's mount namespace could see. It is now a
 * private directory the host creates on a tmpfs device apart from the brain,
 * bound into the worker, so that once the worker has exited the host can copy
 * out what the answer linked before the directory is removed
 * (docs/decisions/governed-writable-workers.md, "The three write areas").
 *
 * Everything below the directory was written by the worker. The copy trusts
 * no name in it: every component is opened from a descriptor the host holds,
 * without following a symlink, and only a regular file with one link is read,
 * with its byte bounds counted while it is copied. The destination is opened
 * the same way below `.brain/scratch/turns/<turnId>/`.
 */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, mkdtempSync, openSync, readdirSync, readSync, realpathSync,
  rmSync, statfsSync, statSync, unlinkSync, writeSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { randomUUID } from "node:crypto";
import type { BackendActivityEvent, TurnTempPromotionRefusal } from "./backend.js";
import { at, BRAIN_SCRATCH_DIR, openDirectory } from "./worker-sandbox.js";
import { rewriteLinkDestinations } from "../markdown-links.js";

/** The kernel's `statfs` type of a tmpfs. */
const TMPFS_MAGIC = 0x01021994;
export const TURN_TEMP_PREFIX = "brain-turn-temp-";
/** Where promoted files go, brain-relative; each turn gets its own directory below it. */
export const PROMOTED_SCRATCH_DIR = `${BRAIN_SCRATCH_DIR}/turns`;
/** A single linked file larger than this stays in turn temp, and its link is left as written. */
export const PROMOTION_FILE_MAX_BYTES = 128 * 1024 * 1024;
/** What one turn may promote in total. */
export const PROMOTION_TURN_MAX_BYTES = 256 * 1024 * 1024;
/** How many files one turn may promote. */
export const PROMOTION_TURN_MAX_FILES = 64;
/** A link longer than this is not examined. */
const LINK_MAX_CHARS = 2000;
const COPY_CHUNK = 1024 * 1024;

export interface TurnTemp {
  /** The private host directory holding the rest; removed by `cleanup`. */
  readonly root: string;
  /** Bound at the worker's `/tmp`. */
  readonly tmp: string;
  /** The `$HOME` overlay's upper directory: what the worker wrote under its home. */
  readonly homeUpper: string;
  /** The overlay's work directory, on the same filesystem as `homeUpper`. */
  readonly homeWork: string;
  cleanup(): void;
}

/** Whether `path` is `dir` or lies below it. */
const within = (dir: string, path: string) => path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

/**
 * The first candidate that is a tmpfs directory on another device than the
 * brain, neither inside it nor holding it. The server's own temporary
 * directory comes first when it is a tmpfs, so turn temp does not compete with
 * runtime state for `/dev/shm`.
 */
export function turnTempRoot(brainPath: string, candidates: readonly string[] = [tmpdir(), "/dev/shm"]): string | null {
  let brain: string, brainDev: number;
  try { brain = realpathSync(brainPath); brainDev = statSync(brain).dev; } catch { return null; }
  for (const candidate of candidates) {
    try {
      const real = realpathSync(candidate);
      const info = statSync(real);
      if (!info.isDirectory() || info.dev === brainDev || within(real, brain) || within(brain, real)) continue;
      if (statfsSync(real).type !== TMPFS_MAGIC) continue;
      return real;
    } catch { continue; }
  }
  return null;
}

/** Turn-temp directories of this server's dead processes, left by a crash. */
function sweepStale(root: string): void {
  let names: string[];
  try { names = readdirSync(root); } catch { return; }
  for (const name of names) {
    const match = name.startsWith(TURN_TEMP_PREFIX) ? /^(\d+)-/.exec(name.slice(TURN_TEMP_PREFIX.length)) : null;
    if (!match) continue;
    const pid = Number(match[1]);
    if (pid === process.pid) continue;
    try { process.kill(pid, 0); continue; } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ESRCH") continue;
    }
    try {
      const path = join(root, name);
      if (lstatSync(path).isDirectory() && lstatSync(path).uid === process.getuid?.()) removeTree(path);
    } catch { /* Another server may be sweeping the same directory. */ }
  }
}

/**
 * A fresh turn temp for one worker, or `null` when no candidate root
 * qualifies; the worker then keeps the namespace-private tmpfs, and nothing
 * it links in turn temp can be promoted.
 */
export function createTurnTemp(brainPath: string, candidates?: readonly string[]): TurnTemp | null {
  const base = turnTempRoot(brainPath, candidates);
  if (!base) return null;
  sweepStale(base);
  const root = mkdtempSync(join(base, `${TURN_TEMP_PREFIX}${process.pid}-`));
  chmodSync(root, 0o700);
  const tmp = join(root, "tmp"), home = join(root, "home"), homeUpper = join(home, "upper"), homeWork = join(home, "work");
  try {
    // Mode 1777 is what programs expect of /tmp; only the worker can reach it.
    mkdirSync(tmp, { mode: 0o700 }); chmodSync(tmp, 0o1777);
    mkdirSync(home, { mode: 0o700 }); mkdirSync(homeUpper, { mode: 0o700 }); mkdirSync(homeWork, { mode: 0o700 });
  } catch (error) { removeTree(root); throw error; }
  return { root, tmp, homeUpper, homeWork, cleanup: () => removeTree(root) };
}

/**
 * Removes a turn-temp tree. Overlayfs leaves its work directory mode 000, and
 * a worker may have made any directory unreadable, so directories are opened
 * up (never through a symlink) when a plain removal is refused.
 */
function removeTree(root: string): void {
  try { rmSync(root, { recursive: true, force: true }); return; } catch (error) {
    if (errno(error) !== "EACCES" && errno(error) !== "EPERM") throw error;
  }
  const open = (dir: string): void => {
    try { chmodSync(dir, 0o700); } catch { return; }
    let names: string[];
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names) {
      const path = join(dir, name);
      if (lstatSync(path, { throwIfNoEntry: false })?.isDirectory()) open(path);
    }
  };
  open(root);
  rmSync(root, { recursive: true, force: true });
}

export type TurnTempPromotionRecord = Extract<BackendActivityEvent, { kind: "promotion" | "promotion_refused" }>;

export interface TurnTempPromoterOptions {
  /** The brain the worker ran in. */
  brain: string;
  turnTemp: TurnTemp;
  /** The host's turn id; names the destination directory. Absent or not a plain id: a fresh one. */
  turnId: string | undefined;
  /** The worker's `$HOME` when its writes went to `turnTemp.homeUpper` (the overlay). */
  home?: string;
  /** The worker's `$BRAIN_WORKER_SCRATCH`. */
  scratch: string;
  /** Host paths bound into the worker at their own path, which are never turn temp (runtime state). */
  exclude?: readonly string[];
  /** Whether `.brain/scratch/` was usable for this turn; when it was not, nothing is promoted. */
  scratchWritable: boolean;
  limits?: { fileBytes?: number; turnBytes?: number; files?: number };
  /** Test seam: runs once a source's size has been checked, before it is copied. */
  beforeCopy?: (source: string) => void;
}

class Refused extends Error {
  constructor(readonly reason: TurnTempPromotionRefusal, readonly bytes: number | null = null, readonly limitBytes: number | null = null) {
    super(reason);
  }
}

const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

/**
 * Promotes the files an answer links in turn temp. `rewrite` copies each
 * linked file once, whatever the number of links to it, and returns the text
 * with those links pointing at the copies; `records` is what happened to each
 * linked file, in order.
 */
export function createTurnTempPromoter(options: TurnTempPromoterOptions) {
  const brain = realpathSync(options.brain);
  // The id names a directory: anything but a plain id (or none, from an older
  // host) gets a fresh one, so the copies still have a directory of their own.
  const turnId = options.turnId && /^[A-Za-z0-9_-]{1,128}$/.test(options.turnId) ? options.turnId : randomUUID();
  const fileMax = options.limits?.fileBytes ?? PROMOTION_FILE_MAX_BYTES;
  const turnMax = options.limits?.turnBytes ?? PROMOTION_TURN_MAX_BYTES;
  const filesMax = options.limits?.files ?? PROMOTION_TURN_MAX_FILES;
  const records: TurnTempPromotionRecord[] = [];
  /** Worker path to its promotion record, or null once refused. */
  const done = new Map<string, Extract<TurnTempPromotionRecord, { kind: "promotion" }> | null>();
  const used = new Set<string>();
  let total = 0, promoted = 0;

  /** The worker path a link destination names, with any query or fragment kept apart. */
  function target(raw: string): { path: string; suffix: string } | null {
    let link = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
    const cut = link.search(/[?#]/);
    const suffix = cut === -1 ? "" : link.slice(cut);
    if (cut !== -1) link = link.slice(0, cut);
    if (/^file:\/\//i.test(link)) link = link.slice("file://".length);
    try { link = decodeURIComponent(link); } catch { /* Not percent-encoded: keep it as written. */ }
    link = link.replace(/^\$(?:\{BRAIN_WORKER_SCRATCH\}|BRAIN_WORKER_SCRATCH)(?=\/|$)/, options.scratch);
    if (options.home) link = link.replace(/^(?:~|\$\{HOME\}|\$HOME)(?=\/|$)/, options.home);
    if (!link.startsWith("/") || link.includes("\0")) return null;
    return { path: posix.normalize(link), suffix };
  }

  /** The host directory and segments a worker path is stored under, or null when it is not turn temp. */
  function locate(path: string): { base: string; segments: string[] } | null {
    if (within(brain, path) || options.exclude?.some(dir => within(dir, path))) return null;
    const area = options.home && within(options.home, path) ? { prefix: options.home, base: options.turnTemp.homeUpper }
      : within("/tmp", path) ? { prefix: "/tmp", base: options.turnTemp.tmp } : null;
    if (!area) return null;
    return { base: area.base, segments: path.slice(area.prefix.length).split("/").filter(Boolean) };
  }

  /**
   * Opens the source read-only through descriptors anchored at `base`. The
   * opens decide: a symlink anywhere fails them (`O_NOFOLLOW`), and only a
   * regular file with one link is returned. `lstat` only names a refusal.
   */
  function openSource(base: string, segments: string[]): number {
    if (!segments.length) throw new Refused("not_regular_file");
    const why = (dir: number, name: string, error: unknown): Refused => {
      const code = errno(error);
      if (code === "ELOOP") return new Refused("symlink");
      if (code === "ENOENT") return new Refused("missing");
      if (code === "ENOTDIR") return new Refused(lstatSync(at(dir, name), { throwIfNoEntry: false })?.isSymbolicLink() ? "symlink" : "missing");
      if (code === "ENXIO" || code === "EISDIR") return new Refused("not_regular_file");
      return new Refused("io_error");
    };
    let dir = openDirectory(base);
    try {
      for (const segment of segments.slice(0, -1)) {
        let next: number;
        try { next = openDirectory(at(dir, segment)); } catch (error) { throw why(dir, segment, error); }
        closeSync(dir); dir = next;
      }
      const name = segments.at(-1)!;
      let fd: number;
      try { fd = openSync(at(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) { throw why(dir, name, error); }
      const opened = fstatSync(fd);
      if (!opened.isFile()) { closeSync(fd); throw new Refused("not_regular_file"); }
      if (opened.nlink !== 1) { closeSync(fd); throw new Refused("multiple_links", opened.size, null); }
      return fd;
    } finally { closeSync(dir); }
  }

  /** `.brain/scratch/turns/<turnId>/`, every directory opened from the brain's descriptor without following a link. */
  function openDestination(): number {
    let dir = openDirectory(brain);
    try {
      for (const segment of [...PROMOTED_SCRATCH_DIR.split("/"), turnId]) {
        let next: number;
        try { next = openDirectory(at(dir, segment)); } catch (error) {
          if (errno(error) !== "ENOENT") throw new Refused("io_error");
          try { mkdirSync(at(dir, segment), { mode: 0o755 }); next = openDirectory(at(dir, segment)); }
          catch { throw new Refused("io_error"); }
        }
        closeSync(dir); dir = next;
      }
      return dir;
    } catch (error) { closeSync(dir); throw error; }
  }

  /** A name the reader's file links accept, unique in this turn's directory. */
  function destinationName(dir: number, source: string): { fd: number; name: string } {
    const raw = posix.basename(source);
    const dot = raw.lastIndexOf(".");
    const clean = (value: string) => value.replace(/[^A-Za-z0-9_.-]+/g, "-").replace(/^[.-]+|-+$/g, "");
    const extension = dot > 0 ? clean(raw.slice(dot + 1)).slice(0, 8) : "";
    const stem = (clean(dot > 0 ? raw.slice(0, dot) : raw) || "file").slice(0, 100);
    for (let n = 1; n <= 100; n++) {
      const name = `${stem}${n === 1 ? "" : `-${n}`}${extension ? `.${extension}` : ""}`;
      if (used.has(name)) continue;
      try {
        const fd = openSync(at(dir, name), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o644);
        used.add(name);
        return { fd, name };
      } catch (error) { if (errno(error) !== "EEXIST") throw new Refused("io_error"); }
    }
    throw new Refused("io_error");
  }

  /** Copies the linked file, counting both bounds as it reads. Returns the destination, brain-relative. */
  function promote(path: string, base: string, segments: string[]): { destination: string; bytes: number } {
    if (!options.scratchWritable) throw new Refused("scratch_unavailable");
    if (promoted >= filesMax) throw new Refused("turn_too_large");
    const source = openSource(base, segments);
    let dir: number | undefined, out: { fd: number; name: string } | undefined, copied = 0, complete = false;
    try {
      const size = fstatSync(source).size;
      if (size > fileMax) throw new Refused("file_too_large", size, fileMax);
      if (total + size > turnMax) throw new Refused("turn_too_large", size, turnMax);
      options.beforeCopy?.(path);
      dir = openDestination();
      out = destinationName(dir, path);
      const buffer = Buffer.allocUnsafe(COPY_CHUNK);
      for (;;) {
        let read: number;
        try { read = readSync(source, buffer, 0, buffer.length, null); } catch { throw new Refused("io_error", copied); }
        if (read === 0) break;
        copied += read;
        if (copied > fileMax) throw new Refused("file_too_large", copied, fileMax);
        if (total + copied > turnMax) throw new Refused("turn_too_large", copied, turnMax);
        for (let offset = 0; offset < read;) {
          try { offset += writeSync(out.fd, buffer, offset, read - offset); } catch { throw new Refused("io_error", copied); }
        }
      }
      complete = true;
      total += copied; promoted++;
      return { destination: `${PROMOTED_SCRATCH_DIR}/${turnId}/${out.name}`, bytes: copied };
    } finally {
      closeSync(source);
      if (out) {
        closeSync(out.fd);
        if (!complete) try { unlinkSync(at(dir!, out.name)); } catch { /* The refusal stands either way. */ }
      }
      if (dir !== undefined) closeSync(dir);
    }
  }

  function link(original: string): string {
    if (original.length > LINK_MAX_CHARS) return original;
    const resolved = target(original);
    if (!resolved) return original;
    const located = locate(resolved.path);
    if (!located) return original;
    if (done.has(resolved.path)) {
      const record = done.get(resolved.path);
      if (!record) return original;
      const rewritten = `${record.destination}${resolved.suffix}`;
      // Another way of writing a link to a file already copied: the live
      // view must rewrite it too (#1698).
      if (original !== record.originalLink && !record.aliases?.some(alias => alias.originalLink === original)) {
        (record.aliases ??= []).push({ originalLink: original, rewrittenLink: rewritten });
      }
      return rewritten;
    }
    try {
      const { destination, bytes } = promote(resolved.path, located.base, located.segments);
      const rewritten = `${destination}${resolved.suffix}`;
      const record = { kind: "promotion" as const, source: resolved.path, destination, bytes, originalLink: original, rewrittenLink: rewritten };
      done.set(resolved.path, record);
      records.push(record);
      return rewritten;
    } catch (error) {
      done.set(resolved.path, null);
      const refusal = error instanceof Refused ? error : new Refused("io_error");
      records.push({ kind: "promotion_refused", source: resolved.path, originalLink: original, reason: refusal.reason,
        bytes: refusal.bytes, limitBytes: refusal.limitBytes });
      return original;
    }
  }

  return {
    records,
    rewrite(text: string): string {
      return rewriteLinkDestinations(text, link);
    },
  };
}
