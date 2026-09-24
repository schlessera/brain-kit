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
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmdirSync, rmSync, statSync, writeFileSync } from "fs";
import { join, relative } from "path";

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
      `${SCRATCH_DIR}/ is not gitignored, so a file written there could be committed to the brain. ` +
        "Run `brain doctor --fix` to add it to .gitignore, then try again."
    );
    this.name = "ScratchNotIgnoredError";
  }
}

function isGitRepo(root: string): boolean {
  return existsSync(join(root, ".git")) || Bun.spawnSync(["git", "-C", root, "rev-parse", "--git-dir"]).exitCode === 0;
}

/**
 * Whether git ignores the scratch area. A brain that is not a git repository
 * commits nothing, so there is nothing to protect and the answer is yes.
 */
export function scratchIgnored(root: string): boolean {
  if (!isGitRepo(root)) return true;
  // `check-ignore` answers for a path whether or not it exists.
  return Bun.spawnSync(["git", "-C", root, "check-ignore", "-q", "--no-index", `${SCRATCH_DIR}/probe`]).exitCode === 0;
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

/** The absolute path of a repo-relative path, and whether it lies in scratch. */
export function isInScratch(root: string, abs: string): boolean {
  const rel = relative(root, abs).split("\\").join("/");
  return rel === SCRATCH_DIR || rel.startsWith(`${SCRATCH_DIR}/`);
}

/**
 * Make sure the scratch area may be written: ignored by git, and present.
 * Throws `ScratchNotIgnoredError` rather than writing where a commit would
 * pick the file up.
 */
export function ensureScratch(root: string): string {
  if (!scratchIgnored(root)) throw new ScratchNotIgnoredError();
  const dir = join(root, SCRATCH_DIR);
  mkdirSync(dir, { recursive: true });
  return dir;
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

function listFiles(dir: string): Entry[] {
  if (!existsSync(dir)) return [];
  const out: Entry[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...listFiles(abs));
    else if (entry.isFile()) {
      const s = statSync(abs);
      out.push({ abs, bytes: s.size, mtimeMs: s.mtimeMs });
    }
  }
  return out;
}

function removeEmptyDirs(dir: string, keep: string): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) removeEmptyDirs(join(dir, entry.name), keep);
  }
  if (dir !== keep && readdirSync(dir).length === 0) rmdirSync(dir);
}

/**
 * Prune the scratch area: every file older than `ttlMs`, then the oldest
 * files until the rest fit in `maxBytes`. Safe to call when scratch does not
 * exist, and from any process: removal of a file already gone is not an error.
 */
export function pruneScratch(
  root: string,
  now: number = Date.now(),
  { ttlMs = SCRATCH_TTL_MS, maxBytes = SCRATCH_MAX_BYTES }: { ttlMs?: number; maxBytes?: number } = {},
): ScratchReport {
  const dir = join(root, SCRATCH_DIR);
  const removed: ScratchRemoval[] = [];
  const remove = (entry: Entry, reason: ScratchRemoval["reason"]) => {
    rmSync(entry.abs, { force: true });
    removed.push({ path: relative(root, entry.abs).split("\\").join("/"), bytes: entry.bytes, reason });
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

/** Empty the scratch area entirely. */
export function cleanScratch(root: string): ScratchReport {
  const dir = join(root, SCRATCH_DIR);
  const removed: ScratchRemoval[] = [];
  for (const entry of listFiles(dir)) {
    rmSync(entry.abs, { force: true });
    removed.push({ path: relative(root, entry.abs).split("\\").join("/"), bytes: entry.bytes, reason: "clean" });
  }
  removeEmptyDirs(dir, dir);
  return { removed, bytes: 0, files: 0 };
}
