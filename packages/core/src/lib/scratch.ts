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
 * both are refused outright (`ScratchRedirectedError`), and the walk reads
 * every entry with `lstat`.
 */
import { randomBytes } from "crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from "fs";
import type { Dirent, Stats } from "fs";
import { dirname, join, relative, resolve, sep } from "path";

/** Repo-relative scratch directory. Every mechanism that needs it reads this. */
export const SCRATCH_DIR = ".brain/scratch";

/** Files older than this are pruned. */
export const SCRATCH_TTL_MS = 7 * 24 * 60 * 60 * 1000;

/** After the age cut, the oldest files go until the folder is under this. */
export const SCRATCH_MAX_BYTES = 1024 * 1024 * 1024;

/** The `.gitignore` line that keeps scratch out of the brain's history. */
export const SCRATCH_IGNORE_LINE = `${SCRATCH_DIR}/`;

export class ScratchNotIgnoredError extends Error {
  constructor(path: string = `${SCRATCH_DIR}/`) {
    super(
      `${path} is not gitignored, so a file written there could be committed to the brain. ` +
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

/** A `.gitignore` line that excludes the scratch directory (or all of `.brain`) as a directory. */
const IGNORE_LINE = /^\/?\.brain(\/scratch)?\/?$/;

function hasIgnoreLine(root: string): boolean {
  const path = join(root, ".gitignore");
  if (!existsSync(path)) return false;
  return readFileSync(path, "utf8")
    .split("\n")
    .some((line) => IGNORE_LINE.test(line.trim()));
}

/**
 * Whether git ignores `rel`, a repo-relative path in the scratch area (by
 * default a probe file straight under it).
 *
 * In a repository the answer is git's own, for that path: a negation can
 * re-include one file below a `.brain/scratch/*` rule, so a probe stands in
 * for nothing but itself. Outside one, the `.gitignore` line is required all
 * the same: the brain may be `git init`ed later, and a scratch left unignored
 * would go into its first commit.
 */
export function scratchIgnored(root: string, rel: string = `${SCRATCH_DIR}/probe`): boolean {
  if (!isGitRepo(root)) return hasIgnoreLine(root);
  // `check-ignore` answers for a path whether or not it exists.
  return Bun.spawnSync(["git", "-C", root, "check-ignore", "-q", "--no-index", "--", rel]).exitCode === 0;
}

/** Appends the ignore line to the brain's `.gitignore`. Returns whether it changed anything. */
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

/**
 * Whether `path` (repo-relative or absolute) is asked to go into the scratch
 * area: a lexical question against the canonical root, before any symlink
 * inside scratch gets a say. A caller that then writes there goes through
 * `assertScratchWritable`, which checks where the write really lands.
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
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Everything one write into scratch needs, checked right before it happens:
 * the directory is genuine (`scratchDir`), the canonical target `abs` lies in
 * it, and git ignores that very path. Creates the target's directory.
 *
 * Called twice by a writer that renders or fetches in between: once up front,
 * so a refusal costs nothing, and once more just before the bytes go down,
 * because the ignore rule can change while the renderer runs.
 */
export function assertScratchWritable(root: string, abs: string): void {
  const dir = scratchDir(root);
  if (abs !== dir && !abs.startsWith(dir + sep)) {
    throw new ScratchRedirectedError(`${abs} resolves outside ${SCRATCH_DIR}/`);
  }
  const rel = relative(canonicalRoot(root), abs).split("\\").join("/");
  if (!scratchIgnored(root, rel)) throw new ScratchNotIgnoredError(rel);
  mkdirSync(dirname(abs), { recursive: true });
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

/** Write a generated scratch file, refusing (EEXIST) to replace one already there. */
export function writeScratchFile(abs: string, data: string | Uint8Array): void {
  writeFileSync(abs, data, { flag: "wx" });
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

/** Remove one file or link. Returns false when it was already gone, or is no longer a file. */
function removeFile(abs: string): boolean {
  try {
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
    if (!removeFile(entry.abs)) return;
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
    if (!removeFile(entry.abs)) continue;
    removed.push({ path: relative(rootReal, entry.abs).split("\\").join("/"), bytes: entry.bytes, reason: "clean" });
  }
  removeEmptyDirs(dir, dir);
  return { removed, bytes: 0, files: 0 };
}
