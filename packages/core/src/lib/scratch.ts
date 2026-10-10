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
 * check and its operation; it is named at the check.
 */
import { randomBytes } from "crypto";
import {
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmdirSync,
  rmSync,
  unlinkSync,
} from "fs";
import type { Dirent, Stats } from "fs";
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

function isSymlink(path: string): boolean {
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
function genuineDir(root: string, dir: string, path: string): boolean {
  try {
    scratchDir(root);
    if (!under(dir, path)) return false;
    if (realpathSync(path) !== path) return false;
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

interface Entry {
  abs: string;
  bytes: number;
  mtimeMs: number;
}

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
function listFiles(dir: string): Entry[] {
  if (isSymlink(dir)) return [];
  let names: Dirent[];
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (gone(error)) return [];
    throw error;
  }
  const out: Entry[] = [];
  for (const entry of names) {
    const abs = join(dir, entry.name);
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
 * Remove one file or link that the listing found, re-verifying the path just
 * before the unlink: the chain up to scratch is still genuine (`scratchDir`),
 * the entry's directory is exactly what its path says (`realpath` equal to
 * itself, so no ancestor was swapped for a link since the listing), and the
 * entry is still not a directory. Any mismatch skips the entry without
 * reporting it; so does an entry already gone.
 *
 * What remains open: Node has no `unlinkat`, so between this verification
 * and the unlink syscall an ancestor can still be swapped, and the unlink
 * would then follow the new link. The window is one syscall wide.
 */
/** `gone`: already removed by someone else. `skipped`: not ours to remove any more (moved, swapped, a directory now). */
type Removal = "removed" | "gone" | "skipped" | { failed: string };

function removeFile(root: string, dir: string, abs: string): Removal {
  if (!genuineDir(root, dir, dirname(abs))) return "skipped";
  try {
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
function removeEmptyDirs(root: string, scratch: string, dir: string): void {
  if (!genuineDir(root, scratch, dir)) return;
  let names: Dirent[];
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (gone(error)) return;
    throw error;
  }
  for (const entry of names) {
    if (entry.isDirectory()) removeEmptyDirs(root, scratch, join(dir, entry.name));
  }
  if (dir === scratch) return;
  if (!genuineDir(root, scratch, dir)) return;
  try {
    rmdirSync(dir);
  } catch (error) {
    const code = (error as { code?: string }).code;
    // Refilled, replaced or removed meanwhile: leave it be.
    if (gone(error) || code === "ENOTEMPTY" || code === "EBUSY" || code === "EEXIST") return;
    throw error;
  }
}

/**
 * Prune the scratch area: every file older than `ttlMs`, then the oldest
 * files until the rest fit in `maxBytes`. Safe to call when scratch does not
 * exist, and from any process: an entry that another process removed in the
 * meantime is neither an error nor reported. Refuses a redirected scratch.
 */
export function pruneScratch(
  root: string,
  now: number = Date.now(),
  { ttlMs = SCRATCH_TTL_MS, maxBytes = SCRATCH_MAX_BYTES }: { ttlMs?: number; maxBytes?: number } = {},
): ScratchReport {
  const dir = scratchDir(root);
  const rootReal = canonicalRoot(root);
  const rel = (abs: string) => relative(rootReal, abs).split("\\").join("/");
  const removed: ScratchRemoval[] = [];
  const failed: ScratchFailure[] = [];
  // What is still in scratch after this pass, as far as it could tell: a
  // file it could not remove (reported in `failed`), one it left alone, one
  // it did not need to touch.
  const left: Entry[] = [];
  /** Try to remove; true when the bytes are gone from disk (removed, or found gone). */
  const remove = (entry: Entry, reason: ScratchRemoval["reason"]): boolean => {
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
  const entries = listFiles(dir).sort((a, b) => a.mtimeMs - b.mtimeMs);
  const candidates: Entry[] = [];
  for (const entry of entries) {
    if (now - entry.mtimeMs > ttlMs) remove(entry, "age");
    else candidates.push(entry);
  }
  // The cap counts everything still there, the files that would not go
  // included; a failure subtracts nothing and the pass moves on to the next
  // oldest, so the cap is met whenever the removable files allow it.
  let total = [...left, ...candidates].reduce((sum, e) => sum + e.bytes, 0);
  for (const entry of candidates) {
    if (total <= maxBytes) {
      left.push(entry);
      continue;
    }
    if (remove(entry, "size")) total -= entry.bytes;
  }
  removeEmptyDirs(root, dir, dir);
  return { removed, failed, bytes: left.reduce((sum, e) => sum + e.bytes, 0), files: left.length };
}

/** Empty the scratch area entirely. Refuses a redirected scratch. */
export function cleanScratch(root: string): ScratchReport {
  const dir = scratchDir(root);
  const rootReal = canonicalRoot(root);
  const rel = (abs: string) => relative(rootReal, abs).split("\\").join("/");
  const removed: ScratchRemoval[] = [];
  const failed: ScratchFailure[] = [];
  const survivors: Entry[] = [];
  for (const entry of listFiles(dir)) {
    const outcome = removeFile(root, dir, entry.abs);
    if (outcome === "removed") removed.push({ path: rel(entry.abs), bytes: entry.bytes, reason: "clean" });
    else if (outcome === "gone") continue;
    else {
      if (outcome !== "skipped") failed.push({ path: rel(entry.abs), reason: outcome.failed });
      survivors.push(entry);
    }
  }
  removeEmptyDirs(root, dir, dir);
  return { removed, failed, bytes: survivors.reduce((sum, e) => sum + e.bytes, 0), files: survivors.length };
}
