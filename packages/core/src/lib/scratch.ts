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
 * entry with `lstat`; a write goes to a temporary sibling and is renamed onto
 * its name, which replaces the directory entry rather than writing through
 * whatever entry was there; and a removal re-verifies the path just before
 * the unlink. Node has no `openat`/`unlinkat`, so a window the width of one
 * syscall remains between each check and its operation; it is named at the
 * check.
 */
import { randomBytes } from "crypto";
import {
  existsSync,
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
  writeFileSync,
} from "fs";
import type { Dirent, Stats } from "fs";
import { tmpdir } from "os";
import { basename, dirname, join, relative, resolve, sep } from "path";

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
 * An empty repository, so that `check-ignore` can be asked about a brain that
 * is not one: the answer is what a later `git init` would read from the same
 * `.gitignore`, and the rules are git's, not a re-implementation of them.
 */
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
  const path = join(root, ".gitignore");
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const block =
    "\n# The brain's scratch area: transient output (renders, generated images)\n" +
    "# that is never part of the brain. Pruned by age and size.\n" +
    `${SCRATCH_IGNORE_LINE}\n`;
  writeFileSync(path, (current && !current.endsWith("\n") ? `${current}\n` : current) + block);
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
 * The one way bytes land in the scratch area, for every writer: render,
 * image, the OKF export. At the moment of the write it re-checks the chain
 * (`scratchDir`, git's exclusion), requires the target's directory to be
 * exactly what its path says (`realpath` equal to itself: no symlink at any
 * segment, so a directory swapped for a link since the pre-flight is refused),
 * requires the target's own entry not to be a link or a directory, writes to
 * a random temporary sibling created exclusively, and renames it onto the
 * name. A rename replaces the directory entry: it never writes through a
 * planted link, and never into an inode a hard link shares with a file
 * elsewhere.
 *
 * `replace` is for a name the caller chose (`--out`): theirs to overwrite. A
 * generated name refuses an existing file. That check is an `lstat` just
 * before the rename, and a file created in between by another writer would be
 * replaced; generated names carry a random tail, so no two writers produce
 * one. Returns the path written.
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
  if (realpathSync(parent) !== parent) {
    throw new ScratchRedirectedError(`${relative(rootReal, parent)} resolves to ${realpathSync(parent)}`);
  }
  const tmp = join(parent, `.${basename(abs)}.${randomBytes(4).toString("hex")}.tmp`);
  writeFileSync(tmp, data, { flag: "wx" });
  try {
    const entry = lstatSync(abs, { throwIfNoEntry: false });
    if (entry?.isSymbolicLink()) throw new ScratchRedirectedError(`${rel} is a symlink`);
    if (entry?.isDirectory()) throw new Error(`EISDIR: ${rel} is a directory`);
    if (entry && !replace) throw new Error(`EEXIST: ${rel} already exists`);
    // Between the lstat and this rename, the entry could change once more;
    // rename replaces whatever is there without following it, so nothing
    // outside scratch is written either way.
    renameSync(tmp, abs);
  } catch (error) {
    rmSync(tmp, { force: true });
    throw error;
  }
  return abs;
}

/**
 * A file name for a generated scratch file that no earlier or concurrent
 * write shares: the stem, the moment, and a random tail. Two renders of
 * different `report.md` files, or two stdin renders in one millisecond, must
 * not land on one name, because a chat link to the first would then show the
 * second.
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

export interface ScratchReport {
  removed: ScratchRemoval[];
  /** Bytes still in scratch afterwards. */
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
function removeFile(root: string, dir: string, abs: string): boolean {
  try {
    scratchDir(root);
  } catch {
    return false;
  }
  const parent = dirname(abs);
  if (!under(dir, abs)) return false;
  try {
    if (realpathSync(parent) !== parent) return false;
    if (lstatSync(abs).isDirectory()) return false;
    unlinkSync(abs);
    return true;
  } catch (error) {
    const code = (error as { code?: string }).code;
    // EISDIR/EPERM: a directory now sits where the file was. Not ours to remove.
    if (gone(error) || code === "EISDIR" || code === "EPERM") return false;
    throw error;
  }
}

function removeEmptyDirs(dir: string, keep: string): void {
  if (isSymlink(dir)) return;
  let names: Dirent[];
  try {
    names = readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (gone(error)) return;
    throw error;
  }
  for (const entry of names) {
    if (entry.isDirectory()) removeEmptyDirs(join(dir, entry.name), keep);
  }
  if (dir === keep) return;
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
  const removed: ScratchRemoval[] = [];
  const remove = (entry: Entry, reason: ScratchRemoval["reason"]) => {
    if (!removeFile(root, dir, entry.abs)) return;
    removed.push({ path: relative(rootReal, entry.abs).split("\\").join("/"), bytes: entry.bytes, reason });
  };
  let entries = listFiles(dir);
  for (const entry of entries) if (now - entry.mtimeMs > ttlMs) remove(entry, "age");
  entries = entries.filter((e) => now - e.mtimeMs <= ttlMs).sort((a, b) => a.mtimeMs - b.mtimeMs);
  let total = entries.reduce((sum, e) => sum + e.bytes, 0);
  while (total > maxBytes && entries.length > 0) {
    const oldest = entries.shift()!;
    remove(oldest, "size");
    total -= oldest.bytes;
  }
  removeEmptyDirs(dir, dir);
  return { removed, bytes: total, files: entries.length };
}

/** Empty the scratch area entirely. Refuses a redirected scratch. */
export function cleanScratch(root: string): ScratchReport {
  const dir = scratchDir(root);
  const rootReal = canonicalRoot(root);
  const removed: ScratchRemoval[] = [];
  for (const entry of listFiles(dir)) {
    if (!removeFile(root, dir, entry.abs)) continue;
    removed.push({ path: relative(rootReal, entry.abs).split("\\").join("/"), bytes: entry.bytes, reason: "clean" });
  }
  removeEmptyDirs(dir, dir);
  return { removed, bytes: 0, files: 0 };
}
