/**
 * Git storage upkeep for a brain repository: the non-destructive packing
 * `brain maintain` runs, and the read-only figures `brain doctor` reports.
 *
 * A content repo collects large binaries. Git's automatic gc triggers on the
 * loose-object count (`gc.auto`), so a few thousand large loose blobs are
 * never packed. `git maintenance start` would fix that but needs a system
 * scheduler; `brain maintain` is the periodic entry point a brain already has.
 * Nothing here deletes a ref, expires a reflog or changes git config.
 */

export class GitStorageError extends Error {}

/** The git binary could not be started at all (not installed, not on PATH). */
export class GitUnavailableError extends GitStorageError {}

function git(root: string, args: string[]): { ok: boolean; stdout: string; stderr: string } {
  let proc;
  try {
    proc = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe" });
  } catch (e) {
    throw new GitUnavailableError(`git could not be run: ${(e as Error).message}`);
  }
  return {
    ok: proc.exitCode === 0,
    stdout: new TextDecoder().decode(proc.stdout).trim(),
    stderr: new TextDecoder().decode(proc.stderr).trim(),
  };
}

function firstLine(text: string, fallback: string): string {
  return text.split("\n").find((line) => line.trim() !== "")?.trim() ?? fallback;
}

/**
 * Whether `root` is inside a git work tree. Only git's own "not a git
 * repository" answer means no: any other failure (dubious ownership, a
 * broken config, a missing binary) throws with git's message, so a repository
 * git refuses to read is never mistaken for none.
 */
export function isGitWorkTree(root: string): boolean {
  const out = git(root, ["rev-parse", "--is-inside-work-tree"]);
  if (out.ok) return out.stdout === "true";
  if (/not a git repository/i.test(out.stderr)) return false;
  throw new GitStorageError(firstLine(out.stderr, "git rev-parse failed"));
}

export interface LooseObjects {
  count: number;
  /** Disk used by loose objects, in bytes (`git count-objects -v` reports KiB). */
  bytes: number;
}

/** Loose objects from `git count-objects -v`. */
export function looseObjects(root: string): LooseObjects {
  const out = git(root, ["count-objects", "-v"]);
  if (!out.ok) throw new GitStorageError(firstLine(out.stderr, "git count-objects failed"));
  const field = (name: string) => {
    const match = out.stdout.match(new RegExp(`^${name}: (\\d+)$`, "m"));
    if (!match) throw new GitStorageError(`git count-objects -v printed no ${name}`);
    return Number(match[1]);
  };
  return { count: field("count"), bytes: field("size") * 1024 };
}

/**
 * Pack loose objects and refs with git's own non-destructive maintenance
 * tasks. Each `git maintenance run` takes git's maintenance lock.
 *
 * The loose-objects task works in two steps across runs: it first deletes
 * loose objects that are already in a pack, then packs a batch of the rest.
 * One run therefore leaves every object it just packed loose as well, so a
 * second loose-objects run follows to delete those copies. It deletes only
 * objects a pack already holds.
 */
export function packRepository(root: string): { packed: number } {
  const before = looseObjects(root).count;
  const tasks = ["--task=loose-objects", "--task=incremental-repack", "--task=pack-refs"];
  for (const args of [tasks, ["--task=loose-objects"]]) {
    const out = git(root, ["maintenance", "run", ...args]);
    if (!out.ok) throw new GitStorageError(firstLine(out.stderr, "git maintenance run failed"));
  }
  return { packed: Math.max(0, before - looseObjects(root).count) };
}

/** Refs under `refs/original/`, the backups `git filter-branch` leaves behind. */
export function originalRefs(root: string): string[] {
  const out = git(root, ["for-each-ref", "--format=%(refname)", "refs/original/"]);
  if (!out.ok) throw new GitStorageError(firstLine(out.stderr, "git for-each-ref failed"));
  return out.stdout ? out.stdout.split("\n") : [];
}
