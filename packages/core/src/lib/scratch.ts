/**
 * The brain's scratch area: one place, inside the brain root, for output that
 * is transient and never meant to become part of the brain (#310).
 *
 * Inside the root, because that is the only place the chat UI's file manager
 * can open a link to. Never canonical: it is gitignored (and nothing writes
 * there until it is), skipped by the index, the OKF export and stats through
 * this one constant, and pruned by age and size. A file becomes canonical by
 * being moved out of it into the content, and the normal commit flow takes it
 * from there.
 *
 * Share staging (`.brain-ui/inbox`) is deliberately separate: it may become a
 * mount point for a shared folder, so it keeps its own location and policy.
 *
 * Nothing here follows a symlink. A `.brain` or `.brain/scratch` that is one
 * would let a prune delete, or a write land, wherever the link points, so
 * both are refused outright (`ScratchRedirectedError`); the walk reads every
 * entry with `lstat`; a write publishes a completed temporary sibling onto
 * its name, replacing an entry only when requested rather than writing through
 * whatever entry was there; and a removal, a descent and a publication each
 * re-verify the path just before they act. Node has no `openat`/`unlinkat`/
 * `renameat`, so a window the width of one syscall remains between each
 * check and its operation; it is named at the check. On Linux, where a
 * hosted agent can write scratch during a prune, a removal goes through
 * directory descriptors instead (`anchored`) and has no such window.
 */
import { randomBytes } from "crypto";
import {
  closeSync,
  constants,
  fstatSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
} from "fs";
import type { Stats } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, relative, resolve, sep } from "path";
import { modeOf, WriteRefusedError, writeExclusive, writeFileSafely } from "./safe-path.js";

/** Repo-relative scratch directory. Every mechanism that needs it reads this. */
export const SCRATCH_DIR = ".brain/scratch";

/** Files older than this are pruned. */
export const SCRATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** After the age cut, the oldest files go until the folder is under this. */
export const SCRATCH_MAX_BYTES = 1024 * 1024 * 1024;

/** The `.gitignore` line that keeps scratch out of the brain's history. */
export const SCRATCH_IGNORE_LINE = `${SCRATCH_DIR}/`;

export class ScratchNotIgnoredError extends Error {
  constructor() {
    super(
      `${SCRATCH_DIR}/ is not gitignored as a directory, so a file written there could be committed to the brain. ` +
        "Run `brain doctor --fix` to add it to .gitignore, then try again."
    );
    this.name = "ScratchNotIgnoredError";
  }
}

/** `.brain` or `.brain/scratch` is a symlink, or a path in scratch resolves out of it. */
export class ScratchRedirectedError extends Error {
  constructor(detail: string) {
    super(`${SCRATCH_DIR}/ is redirected by a symlink, so nothing is written to or pruned from it: ${detail}`);
    this.name = "ScratchRedirectedError";
  }
}

function isGitRepo(root: string): boolean {
  return existsSync(join(root, ".git")) || Bun.spawnSync(["git", "-C", root, "rev-parse", "--git-dir"]).exitCode === 0;
}

let emptyGitDir: string | null = null;

/**
 * An empty repository, so that git can be asked about a brain that is not
 * one (`check-ignore` here, `check-attr` for the cache merge attributes): the
 * answer is what a later `git init` would read from the same `.gitignore` or
 * `.gitattributes`, and the rules are git's, not a re-implementation of them.
 */
export function emptyRepository(): string {
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
 * Whether git excludes the scratch DIRECTORY. Only that counts: nothing under
 * an excluded directory can be re-included, whereas `.brain/scratch/*` leaves
 * every later negation effective, and a later `!.brain/scratch/` cancels the
 * line itself. `check-ignore` on the directory path (no trailing slash, and
 * the directory has to exist) tells the three apart; a probe file inside, or
 * a trailing slash, does not.
 *
 * Outside a repository the same question goes to git through an empty one,
 * because the brain may be `git init`ed later.
 *
 * Refuses a symlinked scratch first (`scratchDir`), and creates the directory
 * so that git can answer for it.
 */
export function scratchIgnored(root: string): boolean {
  const dir = scratchDir(root);
  mkdirSync(dir, { recursive: true });
  const rootReal = canonicalRoot(root);
  const argv = isGitRepo(rootReal)
    ? ["git", "check-ignore", "-q", "--no-index", "--", SCRATCH_DIR]
    : ["git", `--git-dir=${emptyRepository()}`, `--work-tree=${rootReal}`, "check-ignore", "-q", "--no-index", "--", SCRATCH_DIR];
  return Bun.spawnSync(argv, { cwd: rootReal }).exitCode === 0;
}

/**
 * Appends the ignore line to the brain's `.gitignore` unless git already
 * excludes the directory. Appended last, so it also overrides an earlier
 * negation. Returns whether it changed anything.
 */
export function ignoreScratch(root: string): boolean {
  if (scratchIgnored(root)) return false;
  // At the canonical root, never through a link: a `.gitignore` that points
  // outside the brain would otherwise have this block appended to whatever it
  // names. The write is a rename, so a hard link's other name is left alone.
  const path = join(canonicalRoot(root), ".gitignore");
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new WriteRefusedError(".gitignore is a symlink; add the scratch line to the file it names by hand");
  }
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const block =
    "\n# The brain's scratch area: transient output (renders, generated images)\n" +
    "# that is never part of the brain. Pruned by age and size.\n" +
    `${SCRATCH_IGNORE_LINE}\n`;
  writeFileSafely(path, (current && !current.endsWith("\n") ? `${current}\n` : current) + block);
  return true;
}

function canonicalRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

function isSymlink(path: string | Buffer): boolean {
  try {
    return lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

/**
 * The scratch directory's absolute path, verified: neither `.brain` nor
 * `.brain/scratch` is a symlink, and the directory (when it exists) lies
 * inside the canonical brain root. Throws `ScratchRedirectedError` otherwise.
 * Because nothing on the way is a link, the path returned is canonical.
 */
export function scratchDir(root: string): string {
  const rootReal = canonicalRoot(root);
  const dir = join(rootReal, SCRATCH_DIR);
  for (const path of [dirname(dir), dir]) {
    if (isSymlink(path)) throw new ScratchRedirectedError(`${relative(rootReal, path)} is a symlink`);
  }
  if (existsSync(dir)) {
    const real = realpathSync(dir);
    if (real !== dir) throw new ScratchRedirectedError(`${SCRATCH_DIR} resolves to ${real}`);
  }
  return dir;
}

const under = (dir: string, path: string) => path === dir || path.startsWith(dir + sep);

/**
 * Whether `path` (repo-relative or absolute) is asked to go into the scratch
 * area: a lexical question against the canonical root, before any symlink
 * inside scratch gets a say. A caller that then writes there goes through
 * `writeScratchFile`, which checks where the write really lands.
 */
export function isInScratch(root: string, path: string): boolean {
  const rootReal = canonicalRoot(root);
  const rel = relative(rootReal, resolve(rootReal, path)).split("\\").join("/");
  return rel === SCRATCH_DIR || rel.startsWith(`${SCRATCH_DIR}/`);
}

/**
 * Make sure the scratch area may be written: not redirected by a symlink,
 * ignored by git, and present. Throws rather than writing where a commit
 * would pick the file up or a link would send it.
 */
export function ensureScratch(root: string): string {
  const dir = scratchDir(root);
  if (!scratchIgnored(root)) throw new ScratchNotIgnoredError();
  return dir;
}

/**
 * Create every directory from the verified scratch dir down to `parent`, one
 * real directory at a time: an existing segment must be a directory that is
 * not a link, so a `mkdir -p` never walks through one.
 */
function realDirectories(dir: string, parent: string, rootReal: string): void {
  if (!under(dir, parent)) throw new ScratchRedirectedError(`${relative(rootReal, parent)} is outside ${SCRATCH_DIR}/`);
  let path = dir;
  const segments = parent === dir ? [] : relative(dir, parent).split(sep);
  for (const segment of ["", ...segments]) {
    if (segment) path = join(path, segment);
    let s = lstatSync(path, { throwIfNoEntry: false });
    if (!s) {
      mkdirSync(path);
      s = lstatSync(path);
    }
    if (s.isSymbolicLink() || !s.isDirectory()) {
      throw new ScratchRedirectedError(`${relative(rootReal, path)} is not a directory of its own`);
    }
  }
}

/**
 * The pre-flight for a write into scratch, so a refusal costs nothing: the
 * directory is genuine (`scratchDir`), the target lies in it, git excludes it,
 * and the target's directory exists. `writeScratchFile` checks all of it again
 * at the moment of the write.
 */
export function assertScratchWritable(root: string, abs: string): void {
  const dir = scratchDir(root);
  const rootReal = canonicalRoot(root);
  const target = resolve(rootReal, abs);
  if (!under(dir, target)) throw new ScratchRedirectedError(`${target} resolves outside ${SCRATCH_DIR}/`);
  if (!scratchIgnored(root)) throw new ScratchNotIgnoredError();
  realDirectories(dir, dirname(target), rootReal);
}

/**
 * Whether `path` is, right now, a directory of its own inside the verified
 * scratch chain: `scratchDir` still holds, `path` lies in it, its realpath
 * is itself (no link at any segment) and `lstat` says directory. The check
 * a removal, a descent and a publication each repeat just before they act.
 */
function genuineDir(root: string, dir: string, path: string | Buffer): boolean {
  try {
    scratchDir(root);
    if (Buffer.isBuffer(path)) {
      const base = Buffer.from(dir);
      if (!path.equals(base) && !path.subarray(0, base.length + 1).equals(Buffer.from(dir + sep))) return false;
      if (!realpathSync(path, { encoding: "buffer" }).equals(path)) return false;
    } else {
      if (!under(dir, path)) return false;
      if (realpathSync(path) !== path) return false;
    }
    return lstatSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * The one way bytes land in the scratch area, for every writer: render,
 * image, the OKF export. At the moment of the write it re-checks the chain
 * (`scratchDir`, git's exclusion), requires the target's directory to be
 * exactly what its path says (`realpath` equal to itself: no symlink at any
 * segment, so a directory swapped for a link since the pre-flight is refused),
 * requires the target's own entry not to be a link or a directory, writes to
 * a random temporary sibling created exclusively, and publishes it onto the
 * name. Replacement uses rename, so it changes the entry rather than writing
 * through a planted link or an inode shared by another hard link. With
 * replacement disabled, a hard link atomically refuses every occupied name,
 * including an entry arriving after the final absence check.
 *
 * The directory is re-verified immediately before publication, and again
 * before the temporary file is removed, so a directory swapped for
 * a link while the temporary file was being written is refused rather than
 * published or removed through. What remains, as in the prune, is the one
 * syscall between verification and each path-based operation: Node has no
 * `renameat`. A temporary file a refused write leaves behind is pruned like
 * any other scratch file.
 *
 * `replace` is for a name the caller chose (`--out`): theirs to overwrite. A
 * generated name uses exclusive publication. Random tails reduce collisions;
 * they do not establish the nonreplacement guarantee. Successful publication
 * removes the temporary name, leaving one complete file. Returns its path.
 */
export function writeScratchFile(
  root: string,
  target: string,
  data: string | Uint8Array,
  { replace = false }: { replace?: boolean } = {},
): string {
  const dir = scratchDir(root);
  if (!scratchIgnored(root)) throw new ScratchNotIgnoredError();
  const rootReal = canonicalRoot(root);
  const abs = resolve(rootReal, target);
  const rel = relative(rootReal, abs);
  if (!under(dir, abs)) throw new ScratchRedirectedError(`${rel} is outside ${SCRATCH_DIR}/`);
  const parent = dirname(abs);
  realDirectories(dir, parent, rootReal);
  const swapped = () => new ScratchRedirectedError(`${relative(rootReal, parent)} is no longer a directory of its own`);
  if (!genuineDir(root, dir, parent)) throw swapped();
  const before = lstatSync(abs, { throwIfNoEntry: false });
  const tmp = join(parent, `.${basename(abs)}.${randomBytes(4).toString("hex")}.tmp`);
  // A replaced regular file keeps its mode; see `writeExclusive`.
  writeExclusive(tmp, data, replace ? modeOf(before) : undefined);
  try {
    if (!genuineDir(root, dir, parent)) throw swapped();
    const entry = lstatSync(abs, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) throw new ScratchRedirectedError(`${rel} is a symlink`);
    if (entry?.isDirectory()) throw new WriteRefusedError(`EISDIR: ${rel} is a directory`);
    if (entry && !replace) throw new WriteRefusedError(`EEXIST: ${rel} already exists`, "EEXIST");
    if (replace) renameSync(tmp, abs);
    else {
      try { linkSync(tmp, abs); }
      catch (error) {
        if ((error as NodeJS.ErrnoException).code === "EEXIST") {
          throw new WriteRefusedError(`EEXIST: ${rel} already exists`, "EEXIST");
        }
        throw error;
      }
      if (!genuineDir(root, dir, parent)) throw swapped();
      rmSync(tmp, { force: true });
    }
  } catch (error) {
    // Never remove through a directory that is no longer ours; the prune
    // takes a stranded temporary file with everything else.
    if (genuineDir(root, dir, parent)) rmSync(tmp, { force: true });
    throw error;
  }
  return abs;
}

/**
 * Whether an error a scratch or safe write threw is a refusal by design
 * (not ignored, redirected, a link or directory or taken name), which a
 * command reports as a usage error, rather than a filesystem failure
 * (ENOSPC, EACCES, ...), which stays an internal error.
 */
export function isWriteRefusal(error: unknown): boolean {
  return (
    error instanceof ScratchNotIgnoredError ||
    error instanceof ScratchRedirectedError ||
    error instanceof WriteRefusedError
  );
}

/**
 * A generated scratch name: the stem, the moment, and a random tail reduce
 * collisions between renders. Exclusive publication still refuses a taken
 * name, so a collision cannot redirect a chat link to another writer's bytes.
 */
export function scratchName(stem: string, ext: string, now: Date = new Date()): string {
  const stamp = now.toISOString().replace(/[-:.]/g, "");
  return `${stem}-${stamp}-${randomBytes(3).toString("hex")}.${ext}`;
}

export interface ScratchRemoval {
  /** Repo-relative path of the removed file. */
  path: string;
  bytes: number;
  reason: "age" | "size" | "clean";
}

export interface ScratchFailure {
  /** Repo-relative path of the file that could not be removed. */
  path: string;
  reason: string;
}

export interface ScratchReport {
  removed: ScratchRemoval[];
  /** Removals that failed for a reason other than the entry being gone or moved; the file is still there and counted below. */
  failed: ScratchFailure[];
  /** Bytes still in scratch afterwards, the files that could not be removed included. */
  bytes: number;
  files: number;
}

/** Server-managed pin snapshot. The directory marks brains with retained chat history. */
export const SCRATCH_PINS_FILE = ".brain/scratch-pins/pins.json";

export interface ScratchPruneReport extends ScratchReport {
  pinned: { files: number; bytes: number };
  overageBytes: number;
  /** Unknown pins suspend all deletion; never treat a failed read as an empty set. */
  pinError?: string;
}

function readScratchPins(root: string, pinsFile?: string): Set<string> {
  const path = resolve(root, pinsFile ?? SCRATCH_PINS_FILE);
  // A standalone brain has no retained server conversations. Once the server
  // creates this directory, even a missing snapshot must suspend pruning.
  if (!pinsFile && !lstatSync(dirname(path), { throwIfNoEntry: false })) {
    if (lstatSync(join(root, ".brain/scratch-pins-required"), { throwIfNoEntry: false })) throw new Error("managed scratch pin data is missing");
    return new Set();
  }
  if (realpathSync(dirname(path)) !== dirname(path) || lstatSync(path).isSymbolicLink()) {
    throw new Error("scratch pin data is redirected");
  }
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  let data: Record<string, unknown>;
  try {
    if (!fstatSync(fd).isFile()) throw new Error("scratch pin data is not a regular file");
    data = JSON.parse(readFileSync(fd, "utf8")) as Record<string, unknown>;
  } finally { closeSync(fd); }
  if (data.version !== 1 || data.ready !== true || !data.sessions || typeof data.sessions !== "object" || Array.isArray(data.sessions)) {
    throw new Error("scratch pin data is incomplete or invalid");
  }
  const paths = new Set<string>();
  for (const values of Object.values(data.sessions)) {
    if (!Array.isArray(values)) throw new Error("invalid scratch pin session");
    for (const value of values) {
      if (typeof value !== "string" || !value.startsWith(`${SCRATCH_DIR}/`) ||
          value.split("/").some(part => !part || part === "." || part === "..") || value.includes("\\") || /[\u0000-\u001f\u007f]/.test(value)) {
        throw new Error("invalid scratch pin path");
      }
      paths.add(value);
    }
  }
  return paths;
}

interface Entry {
  abs: Buffer;
  bytes: number;
  mtimeMs: number;
}

// Keep byte identities until the report boundary. Decoding a name for a
// filesystem call conflates distinct invalid UTF-8 names with U+FFFD.
const byteJoin = (dir: string | Buffer, name: Buffer) => Buffer.concat([Buffer.from(dir), Buffer.from(sep), name]);
const byteParent = (path: Buffer) => path.subarray(0, path.lastIndexOf(sep));
const byteName = (path: Buffer) => path.subarray(path.lastIndexOf(sep) + 1);
const reportPath = (root: string, path: Buffer) => path.subarray(Buffer.byteLength(root) + 1).toString().split("\\").join("/");

/** An entry that another process removed or replaced between two of our calls. */
function gone(error: unknown): boolean {
  const code = (error as { code?: string }).code;
  return code === "ENOENT" || code === "ENOTDIR";
}

/**
 * Every file below `dir`, read with `lstat`: a symlink counts as a file of
 * its own (removing it removes the link, never its target) and is never
 * descended into. A prune running beside a writer, or beside another prune,
 * sees entries vanish between readdir and stat; those are skipped.
 */
function listFiles(dir: Buffer): Entry[] {
  if (isSymlink(dir)) return [];
  let names: Buffer[];
  try {
    names = readdirSync(dir, { encoding: "buffer" });
  } catch (error) {
    if (gone(error)) return [];
    throw error;
  }
  const out: Entry[] = [];
  for (const name of names) {
    const abs = byteJoin(dir, name);
    let s: Stats;
    try {
      s = lstatSync(abs);
    } catch (error) {
      if (gone(error)) continue;
      throw error;
    }
    if (s.isDirectory()) out.push(...listFiles(abs));
    else out.push({ abs, bytes: s.size, mtimeMs: s.mtimeMs });
  }
  return out;
}

/**
 * On Linux, where a hosted agent worker can write scratch while the host
 * prunes it, a removal goes through directory descriptors: scratch is opened
 * with `O_NOFOLLOW | O_DIRECTORY`, then each directory down to the entry's
 * parent through the previous one (`/proc/self/fd/<fd>/<name>`), and the
 * unlink or rmdir names the entry through that parent's descriptor. A
 * directory swapped for a symlink at any moment makes the open fail
 * (`ELOOP`/`ENOTDIR`) instead of redirecting the removal out of scratch.
 * Elsewhere no worker exists, and the path checks below are what remains.
 */
const ANCHORED = process.platform === "linux";
const DIRECTORY_FLAGS = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;

/** Runs `act` with `/proc/self/fd/<fd>` for the real directory holding `abs` under `scratch`, and the entry's name. */
function anchored<T>(scratch: string, abs: Buffer, act: (parent: string, name: Buffer) => T): T | "skipped" | "gone" {
  const parent = byteParent(abs);
  const segments: Buffer[] = [];
  for (let start = Buffer.byteLength(scratch) + 1; start < parent.length;) {
    const end = parent.indexOf(sep, start);
    segments.push(parent.subarray(start, end < 0 ? parent.length : end));
    start = end < 0 ? parent.length : end + 1;
  }
  let fd: number;
  try {
    fd = openSync(scratch, DIRECTORY_FLAGS);
  } catch (error) {
    return gone(error) ? "gone" : "skipped";
  }
  try {
    for (const segment of segments) {
      let next: number;
      try {
        next = openSync(byteJoin(`/proc/self/fd/${fd}`, segment), DIRECTORY_FLAGS);
      } catch (error) {
        // ENOENT: gone. ELOOP/ENOTDIR: a link or file now sits where the directory was.
        return (error as { code?: string }).code === "ENOENT" ? "gone" : "skipped";
      }
      closeSync(fd);
      fd = next;
    }
    return act(`/proc/self/fd/${fd}`, byteName(abs));
  } finally {
    closeSync(fd);
  }
}

/**
 * Remove one file or link that the listing found, re-verifying the path just
 * before the unlink: the chain up to scratch is still genuine (`scratchDir`),
 * the entry's directory is exactly what its path says (`realpath` equal to
 * itself, so no ancestor was swapped for a link since the listing), and the
 * entry is still not a directory. Any mismatch skips the entry without
 * reporting it; so does an entry already gone.
 *
 * Off Linux, Node has no `unlinkat`, so between this verification and the
 * unlink syscall an ancestor can still be swapped, and the unlink would then
 * follow the new link; the window is one syscall wide. On Linux the removal
 * is anchored on descriptors (`anchored`) and the window is closed.
 */
/** `gone`: already removed by someone else. `skipped`: not ours to remove any more (moved, swapped, a directory now). */
type Removal = "removed" | "gone" | "skipped" | { failed: string };

function removeFile(root: string, dir: string, abs: Buffer): Removal {
  if (!genuineDir(root, dir, byteParent(abs))) return "skipped";
  try {
    if (ANCHORED) {
      return anchored(dir, abs, (parent, name) => {
        if (lstatSync(byteJoin(parent, name)).isDirectory()) return "skipped";
        unlinkSync(byteJoin(parent, name));
        return "removed";
      });
    }
    if (lstatSync(abs).isDirectory()) return "skipped";
    unlinkSync(abs);
    return "removed";
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (gone(error)) return "gone";
    // EISDIR: a directory now sits where the file was. Not ours to remove.
    if (code === "EISDIR") return "skipped";
    // Anything else (EPERM, EACCES, EBUSY, ...) leaves the file where it is,
    // and the report says so rather than counting it as reclaimed.
    return { failed: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Remove the directories the prune emptied, never the scratch root. Before
 * descending into a directory and again immediately before its rmdir, the
 * directory is re-verified (`genuineDir`): the chain to scratch, its own
 * realpath, and that it is a directory rather than a link put in its place
 * since the listing. A mismatch skips it. The one-syscall window between
 * that check and the rmdir is the same as the unlink's.
 */
function removeEmptyDirs(root: string, scratch: string, dir: Buffer, protectedPaths: readonly Buffer[] = []): void {
  if (!genuineDir(root, scratch, dir)) return;
  let names: Buffer[];
  try {
    names = readdirSync(dir, { encoding: "buffer" });
  } catch (error) {
    if (gone(error)) return;
    throw error;
  }
  for (const name of names) {
    const child = byteJoin(dir, name);
    try {
      if (lstatSync(child).isDirectory()) removeEmptyDirs(root, scratch, child, protectedPaths);
    } catch (error) {
      if (!gone(error)) throw error;
    }
  }
  if (dir.equals(Buffer.from(scratch))) return;
  if (protectedScratchPath(dir, protectedPaths)) return;
  if (!genuineDir(root, scratch, dir)) return;
  try {
    if (ANCHORED) anchored(scratch, dir, (parent, name) => rmdirSync(byteJoin(parent, name)));
    else rmdirSync(dir);
  } catch (error) {
    const code = (error as { code?: string }).code;
    // Refilled, replaced or removed meanwhile: leave it be.
    if (gone(error) || code === "ENOTEMPTY" || code === "EBUSY" || code === "EEXIST") return;
    throw error;
  }
}

/** Compare filesystem bytes, so a lossy display path cannot hide a protected target. */
function protectedScratchPath(path: Buffer, protectedPaths: readonly Buffer[]): boolean {
  const descendant = (child: Buffer, parent: Buffer) => child.length > parent.length && child[parent.length] === 47 && child.subarray(0, parent.length).equals(parent);
  return protectedPaths.some(protectedPath => path.equals(protectedPath) || descendant(path, protectedPath) || descendant(protectedPath, path));
}

/**
 * Prune the scratch area: every file older than `ttlMs`, then the oldest
 * files until the rest fit in `maxBytes`. Safe to call when scratch does not
 * exist, and from any process: an entry that another process removed in the
 * meantime is neither an error nor reported. Refuses a redirected scratch.
 *
 * `pinnedPaths` protects files for this call only, on top of the retained
 * pins: brain-relative or absolute paths, such as the ones `writeScratchFile`
 * returns. A writer that prunes after writing passes what it just produced,
 * so its own cleanup cannot delete the output it is about to report (#1691).
 */
export function pruneScratch(
  root: string,
  now: number = Date.now(),
  { ttlMs = SCRATCH_TTL_MS, maxBytes = SCRATCH_MAX_BYTES, pinnedPaths, pinsFile, protectedPaths }: { ttlMs?: number; maxBytes?: number; pinnedPaths?: ReadonlySet<string>; pinsFile?: string; protectedPaths?: readonly string[] } = {},
): ScratchPruneReport {
  const dir = scratchDir(root);
  const rootReal = canonicalRoot(root);
  // Host-admitted protection is additional retention, never an override of
  // durable pins. Own its encoded values before any cleanup runs.
  const protectedBytes = (protectedPaths ?? []).map(path => Buffer.from(resolve(rootReal, path)));
  const rel = (abs: Buffer) => reportPath(rootReal, abs);
  // Pins are UTF-8 strings. Compare their encoded bytes, not lossy display
  // paths, so an invalid name cannot impersonate a pinned U+FFFD filename.
  const pinKey = (abs: Buffer) => abs.subarray(Buffer.byteLength(rootReal) + 1).toString("hex");
  const removed: ScratchRemoval[] = [];
  const failed: ScratchFailure[] = [];
  // What is still in scratch after this pass, as far as it could tell: a
  // file it could not remove (reported in `failed`), one it left alone, one
  // it did not need to touch.
  const left: Entry[] = [];
  let pinError: string | undefined;
  /** Try to remove; true when the bytes are gone from disk (removed, or found gone). */
  const remove = (entry: Entry, reason: ScratchRemoval["reason"]): boolean => {
    if (protectedScratchPath(entry.abs, protectedBytes)) { left.push(entry); return false; }
    // A server can publish a new retained answer while a CLI prune runs.
    // Re-read immediately before removal, so a late pin or lost snapshot
    // suspends this deletion too, before the safe filesystem removal.
    try {
      pins = currentPins();
      if (pins.has(pinKey(entry.abs))) { left.push(entry); return false; }
    } catch (error) {
      pinError = error instanceof Error ? error.message : String(error);
      left.push(entry); return false;
    }
    const outcome = removeFile(root, dir, entry.abs);
    if (outcome === "removed") {
      removed.push({ path: rel(entry.abs), bytes: entry.bytes, reason });
      return true;
    }
    if (outcome === "gone") return true;
    if (outcome !== "skipped") failed.push({ path: rel(entry.abs), reason: outcome.failed });
    left.push(entry);
    return false;
  };
  const entries = listFiles(Buffer.from(dir)).sort((a, b) => a.mtimeMs - b.mtimeMs);
  let pins: ReadonlySet<string>;
  const explicit = [...(pinnedPaths ?? [])].map(path => Buffer.from(relative(rootReal, resolve(rootReal, path))).toString("hex"));
  const currentPins = () => new Set([
    ...[...readScratchPins(rootReal), ...(pinsFile ? readScratchPins(rootReal, pinsFile) : [])]
      .map(path => Buffer.from(path.split("/").join(sep)).toString("hex")),
    ...explicit,
  ]);
  try {
    // Explicit pins only add protection; they cannot bypass the durable set.
    pins = currentPins();
  } catch (error) {
    const bytes = entries.reduce((sum, entry) => sum + entry.bytes, 0);
    return { removed, failed, bytes, files: entries.length, pinned: { files: 0, bytes: 0 },
      overageBytes: Math.max(0, bytes - maxBytes), pinError: error instanceof Error ? error.message : String(error) };
  }
  const candidates: Entry[] = [];
  for (const entry of entries) {
    if (!pins.has(pinKey(entry.abs)) && now - entry.mtimeMs > ttlMs) remove(entry, "age");
    else candidates.push(entry);
  }
  // The cap counts everything still there, the files that would not go
  // included; a failure subtracts nothing and the pass moves on to the next
  // oldest, so the cap is met whenever the removable files allow it.
  let total = [...left, ...candidates].reduce((sum, e) => sum + e.bytes, 0);
  for (const entry of candidates) {
    if (pins.has(pinKey(entry.abs)) || total <= maxBytes) {
      left.push(entry);
      continue;
    }
    if (remove(entry, "size")) total -= entry.bytes;
  }
  removeEmptyDirs(root, dir, Buffer.from(dir), protectedBytes);
  const pinned = left.filter(entry => pins.has(pinKey(entry.abs)));
  return { removed, failed, bytes: left.reduce((sum, e) => sum + e.bytes, 0), files: left.length,
    pinned: { files: pinned.length, bytes: pinned.reduce((sum, entry) => sum + entry.bytes, 0) },
    overageBytes: Math.max(0, total - maxBytes), ...(pinError ? { pinError } : {}) };
}

/** Empty the scratch area entirely. Refuses a redirected scratch. */
export function cleanScratch(root: string): ScratchReport {
  const dir = scratchDir(root);
  const rootReal = canonicalRoot(root);
  const rel = (abs: Buffer) => reportPath(rootReal, abs);
  const removed: ScratchRemoval[] = [];
  const failed: ScratchFailure[] = [];
  const survivors: Entry[] = [];
  for (const entry of listFiles(Buffer.from(dir))) {
    const outcome = removeFile(root, dir, entry.abs);
    if (outcome === "removed") removed.push({ path: rel(entry.abs), bytes: entry.bytes, reason: "clean" });
    else if (outcome === "gone") continue;
    else {
      if (outcome !== "skipped") failed.push({ path: rel(entry.abs), reason: outcome.failed });
      survivors.push(entry);
    }
  }
  removeEmptyDirs(root, dir, Buffer.from(dir));
  return { removed, failed, bytes: survivors.reduce((sum, e) => sum + e.bytes, 0), files: survivors.length };
}
