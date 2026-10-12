/**
 * Turn temp, the promotion of linked turn-temp files (#1655) and the
 * `turn_temp` tool's usage and purge (#1703).
 *
 * Turn temp is everything a worker may write that dies with the turn: `/tmp`,
 * with `$BRAIN_WORKER_SCRATCH` and the per-turn XDG directories below it. Each
 * worker's `/tmp` is a private tmpfs of exactly its turn-temp allowance,
 * mounted by bubblewrap (`--size`), so one worker filling it touches no other
 * worker and nothing of the host. Only that worker's mount namespace holds the
 * mount; the server keeps a directory descriptor to it from launch
 * (`launchAgentWorker`, `packages/ui-sdk/src/server/worker-launcher.ts`), and
 * reads it through that descriptor while the worker runs and after its
 * namespace is gone, until the descriptor is closed
 * (docs/decisions/governed-writable-workers.md, "The three write areas").
 *
 * Everything below the root was written by the worker. Nothing here trusts a
 * name in it: every component is opened from a descriptor the server holds,
 * without following a symlink and without crossing into another mount, and
 * only a regular file with one link is read, with its byte bounds counted
 * while it is copied. The destination is opened the same way below
 * `.brain/scratch/turns/<turnId>/`.
 */
import { closeSync, constants, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readSync, realpathSync,
  rmdirSync, statfsSync, unlinkSync, writeSync } from "node:fs";
import { posix } from "node:path";
import { randomUUID } from "node:crypto";
import type { BackendActivityEvent, TurnTempPromotionRefusal } from "./backend.js";
import { at, BRAIN_SCRATCH_DIR, openDirectory, type WorkerNoteLimit } from "./worker-sandbox.js";
import { mib } from "./worker-state-limits.js";
import { rewriteLinkDestinations } from "../markdown-links.js";

/** Where promoted files go, brain-relative; each turn gets its own directory below it. */
export const PROMOTED_SCRATCH_DIR = `${BRAIN_SCRATCH_DIR}/turns`;
/** A single linked file larger than this stays in turn temp, and its link is left as written. */
export const PROMOTION_FILE_MAX_BYTES = 128 * 1024 * 1024;
/** What one turn may promote in total. */
export const PROMOTION_TURN_MAX_BYTES = 256 * 1024 * 1024;
/** How many files one turn may promote. */
export const PROMOTION_TURN_MAX_FILES = 64;
/** The worker's own path of its turn temp. */
export const TURN_TEMP_ROOT = "/tmp";
/** A link longer than this is not examined. */
const LINK_MAX_CHARS = 2000;
const COPY_CHUNK = 1024 * 1024;

/** Whether `path` is `dir` or lies below it. */
const within = (dir: string, path: string) => path === dir || path.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

/**
 * A server-side path that opens the directory a held descriptor names.
 * `/proc/self/fd/N` itself is a link, which an `O_NOFOLLOW` open refuses;
 * its `.` is the directory.
 */
const directoryPath = (root: string) => root.endsWith("/.") ? root : `${root}/.`;

const errno = (error: unknown) => (error as NodeJS.ErrnoException)?.code;

/**
 * The worker path a link destination names, with any query or fragment kept
 * apart, or null when it is not an absolute local path. `$BRAIN_WORKER_SCRATCH`
 * is expanded to `scratch`.
 */
export function linkTarget(raw: string, scratch: string): { path: string; suffix: string } | null {
  let link = raw.startsWith("<") && raw.endsWith(">") ? raw.slice(1, -1) : raw;
  const cut = link.search(/[?#]/);
  const suffix = cut === -1 ? "" : link.slice(cut);
  if (cut !== -1) link = link.slice(0, cut);
  if (/^file:\/\//i.test(link)) link = link.slice("file://".length);
  try { link = decodeURIComponent(link); } catch { /* Not percent-encoded: keep it as written. */ }
  link = link.replace(/^\$(?:\{BRAIN_WORKER_SCRATCH\}|BRAIN_WORKER_SCRATCH)(?=\/|$)/, scratch);
  if (!link.startsWith("/") || link.includes("\0")) return null;
  return { path: posix.normalize(link), suffix };
}

/** The turn-temp paths (worker paths below `/tmp`) that `text` links. */
export function linkedTurnTempPaths(text: string, scratch: string): Set<string> {
  const linked = new Set<string>();
  rewriteLinkDestinations(text, destination => {
    if (destination.length <= LINK_MAX_CHARS) {
      const target = linkTarget(destination, scratch);
      if (target && within(TURN_TEMP_ROOT, target.path) && target.path !== TURN_TEMP_ROOT) linked.add(target.path);
    }
    return destination;
  });
  return linked;
}

export type TurnTempPromotionRecord = Extract<BackendActivityEvent, { kind: "promotion" | "promotion_refused" }>;

export interface TurnTempPromoterOptions {
  /** The brain the worker ran in. */
  brain: string;
  /**
   * A server-side path to the worker's `/tmp`: the root of the held
   * descriptor (`LaunchedWorker.turnTemp.root`).
   */
  tmp: string;
  /** The host's turn id; names the destination directory. Absent or not a plain id: a fresh one. */
  turnId: string | undefined;
  /** The worker's `$BRAIN_WORKER_SCRATCH`. */
  scratch: string;
  /** Worker paths below `/tmp` that are never turn temp (runtime state). */
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

  /** The host directory and segments a worker path is stored under, or null when it is not turn temp. */
  function locate(path: string): { base: string; segments: string[] } | null {
    if (within(brain, path) || options.exclude?.some(dir => within(dir, path)) || !within(TURN_TEMP_ROOT, path)) return null;
    return { base: directoryPath(options.tmp), segments: path.slice(TURN_TEMP_ROOT.length).split("/").filter(Boolean) };
  }

  /**
   * Opens the source read-only through descriptors anchored at `base`. The
   * opens decide: a symlink anywhere fails them (`O_NOFOLLOW`), a directory
   * on another mount (runtime state below `/tmp`) is not turn temp, and only
   * a regular file with one link is returned. `lstat` only names a refusal.
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
    const device = fstatSync(dir).dev;
    try {
      for (const segment of segments.slice(0, -1)) {
        let next: number;
        try { next = openDirectory(at(dir, segment)); } catch (error) { throw why(dir, segment, error); }
        closeSync(dir); dir = next;
        if (fstatSync(dir).dev !== device) throw new Refused("missing");
      }
      const name = segments.at(-1)!;
      let fd: number;
      try { fd = openSync(at(dir, name), constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK); }
      catch (error) { throw why(dir, name, error); }
      const opened = fstatSync(fd);
      if (!opened.isFile()) { closeSync(fd); throw new Refused("not_regular_file"); }
      if (opened.dev !== device) { closeSync(fd); throw new Refused("missing"); }
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
    const resolved = linkTarget(original, options.scratch);
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

/** The share of the turn-temp allowance past which the agent is warned once (#1703). */
export const TURN_TEMP_WARN_RATIO = 0.8;
/** How many entries a usage or purge walk visits before it stops. */
export const TURN_TEMP_WALK_LIMIT = 100_000;
/** How many of the largest entries `usage` lists. */
const LARGEST = 10;

/** The live worker's turn temp, as the `turn_temp` tool reaches it (#1703). */
export interface TurnTempAccess {
  /** A server-side path to the worker's `/tmp` while one runs: the held descriptor's root. */
  root(): string | undefined;
  /** The allowance the worker's `/tmp` was mounted with. */
  allowanceBytes: number;
  /** The worker's `$BRAIN_WORKER_SCRATCH`. */
  scratch: string;
  /** Worker paths below `/tmp` that are not turn temp and are never purged (runtime state). */
  exclude: readonly string[];
  /** Worker directories below `/tmp` that a purge empties but keeps: `$BRAIN_WORKER_SCRATCH`, the XDG directories. */
  keep: readonly string[];
  /** This turn's answer text so far; the files it links are promoted at turn end. */
  linkedText(): string;
}

export interface TurnTempSpace { usedBytes: number; limitBytes: number; freeBytes: number }

/** Space in the worker's `/tmp`, read from its own filesystem. */
export function turnTempSpace(root: string, allowanceBytes: number): TurnTempSpace {
  const fs = statfsSync(directoryPath(root));
  return { usedBytes: Math.max(0, (fs.blocks - fs.bfree) * fs.bsize), limitBytes: allowanceBytes, freeBytes: fs.bavail * fs.bsize };
}

export interface TurnTempEntry { path: string; bytes: number; type: "file" | "directory" }

const NO_WORKER = "No worker is running for this turn, so it has no turn temp.";

/** The names in a held directory, or none when it cannot be read. */
function names(dir: number): string[] {
  try { return readdirSync(at(dir, ".")).map(String); } catch { return []; }
}

/**
 * `usage`: bytes used, the limit, and the largest files and directories. The
 * walk opens every directory from its parent's descriptor without following a
 * link and stays on the turn-temp mount.
 */
export function turnTempUsage(access: TurnTempAccess): TurnTempSpace & { largest: TurnTempEntry[]; truncated: boolean } {
  const root = access.root();
  if (!root) throw new Error(NO_WORKER);
  const space = turnTempSpace(root, access.allowanceBytes);
  const entries: TurnTempEntry[] = [];
  let left = TURN_TEMP_WALK_LIMIT;
  const visit = (dir: number, device: number, path: string): number => {
    let total = 0;
    for (const name of names(dir)) {
      if (left-- <= 0) break;
      const child = `${path}/${name}`;
      if (access.exclude.some(excluded => within(excluded, child))) continue;
      const info = lstatSync(at(dir, name), { throwIfNoEntry: false });
      if (!info) continue;
      if (!info.isDirectory()) { entries.push({ path: child, bytes: info.size, type: "file" }); total += info.size; continue; }
      let sub: number;
      try { sub = openDirectory(at(dir, name)); } catch { continue; }
      try {
        if (fstatSync(sub).dev !== device) continue;
        const bytes = visit(sub, device, child);
        entries.push({ path: child, bytes, type: "directory" });
        total += bytes;
      } finally { closeSync(sub); }
    }
    return total;
  };
  const dir = openDirectory(directoryPath(root));
  try { visit(dir, fstatSync(dir).dev, TURN_TEMP_ROOT); } finally { closeSync(dir); }
  const largest = entries.sort((a, b) => b.bytes - a.bytes || a.path.localeCompare(b.path)).slice(0, LARGEST);
  return { ...space, largest, truncated: left <= 0 };
}

export type TurnTempPurgeSkip = "linked" | "outside" | "not_turn_temp" | "missing" | "symlink_in_path" | "io_error";

export interface TurnTempPurgeResult {
  /** The entry walk reached its bound; another purge is needed for remaining paths. */
  truncated: boolean;
  /** What was removed, by worker path, with the bytes each held. */
  removed: TurnTempEntry[];
  /** What was not removed, and why. A linked file is promoted at turn end. */
  skipped: Array<{ path: string; reason: TurnTempPurgeSkip }>;
  freedBytes: number;
  space: TurnTempSpace;
}

/**
 * The worker path a `turn_temp` path names, relative to the turn-temp root,
 * or null when it names anything outside it or the root itself. `/tmp/…`
 * and `$BRAIN_WORKER_SCRATCH/…` are accepted as spellings of the same place.
 */
export function turnTempPath(requested: string, scratch: string): string | null {
  let path = requested.trim();
  if (!path || path.includes("\0")) return null;
  path = path.replace(/^\$(?:\{BRAIN_WORKER_SCRATCH\}|BRAIN_WORKER_SCRATCH)(?=\/|$)/, scratch);
  if (path.startsWith("/")) {
    if (!within(TURN_TEMP_ROOT, path)) return null;
    path = path.slice(TURN_TEMP_ROOT.length);
  }
  const segments = path.split("/").filter(segment => segment && segment !== ".");
  if (!segments.length || segments.includes("..")) return null;
  return `${TURN_TEMP_ROOT}/${segments.join("/")}`;
}

/**
 * `purge`: removes the named turn-temp paths, or everything in turn temp.
 * Every component is opened from the held root without following a link, no
 * directory on another mount is entered, and a removal unlinks the name
 * itself: a link is removed, never what it points at. A file this turn's
 * answer links is skipped and reported unless `force` names it (or a
 * directory holding it); `all` never forces. The directories bubblewrap made
 * for the worker (`keep`) are emptied, not removed.
 */
export function purgeTurnTemp(access: TurnTempAccess, request: { paths?: readonly string[]; all?: boolean; force?: boolean }): TurnTempPurgeResult {
  const root = access.root();
  if (!root) throw new Error(NO_WORKER);
  const linked = linkedTurnTempPaths(access.linkedText(), access.scratch);
  const removed: TurnTempEntry[] = [];
  const skipped: TurnTempPurgeResult["skipped"] = [];
  const excluded = (path: string) => access.exclude.some(dir => within(dir, path));
  /** A directory that is, or holds, one bubblewrap made for the worker. */
  const kept = (path: string) => access.keep.some(dir => within(path, dir));
  let left = TURN_TEMP_WALK_LIMIT;
  let truncated = false;

  /** Removes `name` in `dir`, worker path `path`; whether it is gone. */
  const remove = (dir: number, device: number, name: string, path: string, force: boolean): boolean => {
    // Runtime state below /tmp is not turn temp; its ancestors stay too.
    if (left-- <= 0) { truncated = true; return false; }
    if (excluded(path)) return false;
    const info = lstatSync(at(dir, name), { throwIfNoEntry: false });
    if (!info) return true;
    if (!info.isDirectory()) {
      if (!force && linked.has(path)) { skipped.push({ path, reason: "linked" }); return false; }
      try { unlinkSync(at(dir, name)); } catch (error) {
        if (errno(error) === "ENOENT") return true;
        skipped.push({ path, reason: "io_error" });
        return false;
      }
      removed.push({ path, bytes: info.size, type: "file" });
      return true;
    }
    let sub: number;
    try { sub = openDirectory(at(dir, name)); } catch { skipped.push({ path, reason: "io_error" }); return false; }
    let empty = true;
    try {
      // A mount below turn temp (runtime state) is not turn temp.
      if (fstatSync(sub).dev !== device) { skipped.push({ path, reason: "not_turn_temp" }); return false; }
      for (const child of names(sub)) if (!remove(sub, device, child, `${path}/${child}`, force)) empty = false;
    } finally { closeSync(sub); }
    if (!empty || kept(path)) return false;
    try { rmdirSync(at(dir, name)); } catch (error) {
      if (errno(error) === "ENOENT") return true;
      skipped.push({ path, reason: "io_error" });
      return false;
    }
    removed.push({ path, bytes: 0, type: "directory" });
    return true;
  };

  const before = turnTempSpace(root, access.allowanceBytes);
  const rootFd = openDirectory(directoryPath(root));
  try {
    const device = fstatSync(rootFd).dev;
    if (request.all) {
      for (const name of names(rootFd)) remove(rootFd, device, name, `${TURN_TEMP_ROOT}/${name}`, false);
    } else {
      for (const requested of request.paths ?? []) {
        const path = turnTempPath(requested, access.scratch);
        if (!path) { skipped.push({ path: requested, reason: "outside" }); continue; }
        if (excluded(path)) { skipped.push({ path, reason: "not_turn_temp" }); continue; }
        const segments = path.slice(TURN_TEMP_ROOT.length + 1).split("/");
        let dir = rootFd, failed: TurnTempPurgeSkip | undefined;
        try {
          for (const segment of segments.slice(0, -1)) {
            let next: number;
            try { next = openDirectory(at(dir, segment)); } catch (error) {
              const code = errno(error);
              failed = code === "ENOENT" ? "missing" : code === "ELOOP" || code === "ENOTDIR" ? "symlink_in_path" : "io_error";
              break;
            }
            if (dir !== rootFd) closeSync(dir);
            dir = next;
            if (fstatSync(dir).dev !== device) { failed = "not_turn_temp"; break; }
          }
          const name = segments.at(-1)!;
          if (!failed && !lstatSync(at(dir, name), { throwIfNoEntry: false })) failed = "missing";
          if (failed) skipped.push({ path, reason: failed });
          else remove(dir, device, name, path, Boolean(request.force));
        } finally { if (dir !== rootFd) closeSync(dir); }
      }
    }
  } finally { closeSync(rootFd); }
  const space = turnTempSpace(root, access.allowanceBytes);
  return { removed, skipped, truncated, freedBytes: Math.max(0, before.usedBytes - space.usedBytes), space };
}

/**
 * What to tell the agent about its turn temp after a step (#1703): once when
 * it passes `TURN_TEMP_WARN_RATIO` of the allowance, and once each time it
 * fills up. Computed from the allowance the worker's `/tmp` is mounted with.
 * `tool` is the `turn_temp` tool's name as the agent sees it.
 */
export function createTurnTempPressure(allowanceBytes: number, tool: string) {
  let warned = false, full = false;
  return (space: Pick<TurnTempSpace, "usedBytes" | "freeBytes">): string | undefined => {
    if (space.freeBytes < 4096) {
      if (full) return undefined;
      full = warned = true;
      return turnTempFullMessage(allowanceBytes, tool);
    }
    full = false;
    const fill = space.usedBytes / allowanceBytes;
    if (warned || fill < TURN_TEMP_WARN_RATIO) return undefined;
    warned = true;
    return `Turn temp is ${Math.floor(fill * 100)}% full: ${mib(space.usedBytes)} of its ${mib(allowanceBytes)} allowance `
      + "(`/tmp`, `$BRAIN_WORKER_SCRATCH` and the XDG directories). When it is full, writes there fail with `ENOSPC`. "
      + `Call \`${tool}\` with \`action: "usage"\` to see what is large, then \`action: "purge"\` to free what you no longer need; `
      + "files your answer already links are kept and promoted at turn end.";
  };
}

/**
 * The turn-temp line of the agent's note (#1703), rendered from the resolved
 * allowance through the note's limits seam (#1654), next to the tool that
 * frees it. `tool` is the `turn_temp` tool's name as the agent sees it.
 */
export function turnTempLimit(allowanceBytes: number, tool?: string): WorkerNoteLimit {
  return { name: "Turn temp", value: mib(allowanceBytes),
    onHit: tool
      ? "`/tmp`, `$BRAIN_WORKER_SCRATCH` and the XDG directories share a private tmpfs of that size. "
        + `You are warned once at ${Math.round(TURN_TEMP_WARN_RATIO * 100)}%; when it is full, writes there fail with \`ENOSPC\`. `
        + `\`${tool}\` shows what uses it (\`action: "usage"\`) and frees it (\`action: "purge"\`), keeping the files your answer links.`
      // The restricted envelope has no turn_temp tool.
      : "Turn temp is a private tmpfs of that size. When it is full, writes there fail with `ENOSPC`; delete what you no longer need." };
}

/** The out-of-space message: names the limit and the tool that frees it. */
export function turnTempFullMessage(allowanceBytes: number, tool: string): string {
  return `Turn temp is full: its ${mib(allowanceBytes)} allowance (\`/tmp\`, \`$BRAIN_WORKER_SCRATCH\` and the XDG directories) `
    + "is used up, so writes there fail with `ENOSPC` (`No space left on device`). "
    + `Free space with \`${tool}\`: \`action: "usage"\` lists what is large, \`action: "purge"\` removes what you no longer need. `
    + "Files your answer already links are kept for promotion; put a large deliverable in persistent scratch instead.";
}
