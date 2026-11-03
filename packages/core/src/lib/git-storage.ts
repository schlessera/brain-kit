import { statfsSync } from "node:fs";

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

/** A git write ran out of space; the message is git's own line saying so. */
export class GitNoSpaceError extends GitStorageError {}

/**
 * Whether a failure's text reports a full filesystem. Git words its own write
 * refusal "Out of diskspace" rather than the system's ENOSPC text.
 */
export function isNoSpaceFailure(text: string): boolean {
  return /ENOSPC|EDQUOT|No space left on device|Out of diskspace|Disk quota exceeded/i.test(text);
}

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

/** Local pack files, from `git count-objects -v`. */
function packCount(root: string): number {
  const out = git(root, ["count-objects", "-v"]);
  if (!out.ok) throw new GitStorageError(firstLine(out.stderr, "git count-objects failed"));
  const match = out.stdout.match(/^packs: (\d+)$/m);
  if (!match) throw new GitStorageError("git count-objects -v printed no packs");
  return Number(match[1]);
}

function runMaintenance(root: string, tasks: string[]): void {
  const out = git(root, ["maintenance", "run", ...tasks]);
  if (out.ok) return;
  // The out-of-space line need not be git's first; report that line itself.
  const noSpace = out.stderr.split("\n").find(isNoSpaceFailure)?.trim();
  if (noSpace) throw new GitNoSpaceError(noSpace);
  throw new GitStorageError(firstLine(out.stderr, "git maintenance run failed"));
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
 *
 * The incremental-repack task refuses a repository with no pack file ("no
 * pack files to index"). Git 2.43 and 2.47 refuse even when the same run's
 * loose-objects task has just written the first pack. A repository with no
 * pack yet therefore leaves that task out: the loose-objects task writes the
 * first pack, and there is nothing older to repack it with. A repository with
 * no objects at all gets no pack and has nothing to do. A repository that
 * already has a pack runs exactly the tasks it always did.
 */
export function packRepository(root: string): { packed: number } {
  const before = looseObjects(root).count;
  const repack = packCount(root) > 0 ? ["--task=incremental-repack"] : [];
  runMaintenance(root, ["--task=loose-objects", ...repack, "--task=pack-refs"]);
  runMaintenance(root, ["--task=loose-objects"]);
  return { packed: Math.max(0, before - looseObjects(root).count) };
}

/** Refs under `refs/original/`, the backups `git filter-branch` leaves behind. */
export function originalRefs(root: string): string[] {
  const out = git(root, ["for-each-ref", "--format=%(refname)", "refs/original/"]);
  if (!out.ok) throw new GitStorageError(firstLine(out.stderr, "git for-each-ref failed"));
  return out.stdout ? out.stdout.split("\n") : [];
}

/** Capacity of the Git common store, resolved inside the caller's execution boundary. */
export function gitPackingHeadroom(root: string): { availableBytes: number | null; requiredBytes: null; reason: string } {
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) throw new GitStorageError("Git common store unavailable");
  let availableBytes: number | null = null;
  try {
    const info = statfsSync(common.stdout, { bigint: true }), bytes = info.bavail * info.bsize;
    if (bytes >= 0n && bytes <= BigInt(Number.MAX_SAFE_INTEGER)) availableBytes = Number(bytes);
  } catch { /* An unknown capacity is not zero. Git still reports write refusals. */ }
  return { availableBytes, requiredBytes: null, reason: "Old and new packs coexist; required temporary bytes depend on the workload. No space is reserved." };
}
