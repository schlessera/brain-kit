import { readdirSync, unlinkSync, statfsSync } from "node:fs";

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

export class GitPackingSkipped extends GitStorageError {}

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

/** One read of Git's own storage accounting, including existing garbage. */
export function gitObjectCounts(root: string): { count: number; bytes: number; garbage: { count: number; bytes: number } } {
  const out = git(root, ["count-objects", "-v"]);
  if (!out.ok) throw new GitStorageError(firstLine(out.stderr, "git count-objects failed"));
  const field = (name: string) => {
    const match = out.stdout.match(new RegExp(`^${name}: (\\d+)$`, "m"));
    if (!match) throw new GitStorageError(`git count-objects -v printed no ${name}`);
    return Number(match[1]);
  };
  return { count: field("count"), bytes: field("size") * 1024, garbage: { count: field("garbage"), bytes: field("size-garbage") * 1024 } };
}

export function looseObjects(root: string): LooseObjects {
  const { count, bytes } = gitObjectCounts(root);
  return { count, bytes };
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
export function packRepository(root: string, headroom = gitPackingHeadroom(root)): { packed: number } {
  if (headroom.availableBytes === null || headroom.availableBytes < headroom.packingRequiredBytes)
    throw new GitPackingSkipped(`packing_headroom — requires ${headroom.packingRequiredBytes} bytes; available ${headroom.availableBytes ?? "unknown"}`);
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) throw new GitStorageError("Git common store unavailable");
  const pack = `${common.stdout}/objects/pack`;
  const previous = new Set(readdirSync(pack));
  try {
    const before = looseObjects(root).count;
    const repack = packCount(root) > 0 ? ["--task=incremental-repack"] : [];
    runMaintenance(root, ["--task=loose-objects", ...repack, "--task=pack-refs"]);
    runMaintenance(root, ["--task=loose-objects"]);
    return { packed: Math.max(0, before - looseObjects(root).count) };
  } catch (error) {
    // Only this attempt's temporary outputs, never historical garbage.
    for (const name of readdirSync(pack)) if (!previous.has(name) && /^(tmp_pack_|\.tmp-)/.test(name)) unlinkSync(`${pack}/${name}`);
    throw error;
  }
}

/** Refs under `refs/original/`, the backups `git filter-branch` leaves behind. */
export function originalRefs(root: string): string[] {
  const out = git(root, ["for-each-ref", "--format=%(refname)", "refs/original/"]);
  if (!out.ok) throw new GitStorageError(firstLine(out.stderr, "git for-each-ref failed"));
  return out.stdout ? out.stdout.split("\n") : [];
}

/** Capacity of the Git common store, resolved inside the caller's execution boundary. */
export function gitPackingHeadroom(root: string): { availableBytes: number | null; requiredBytes: null; packingRequiredBytes: number; reason: string } {
  const common = git(root, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) throw new GitStorageError("Git common store unavailable");
  // Raw object sizes avoid treating highly compressible loose data as cheap.
  // Three copies cover both maintenance passes, indexes and auxiliary files;
  // 16 MiB covers fixed Git overhead. Existing packs remain alongside output.
  const sizes = git(root, ["cat-file", "--batch-all-objects", "--batch-check=%(objectsize)"]);
  if (!sizes.ok) throw new GitStorageError("Git packing size unavailable");
  let raw = 0;
  for (const line of sizes.stdout.split("\n").filter(Boolean)) {
    if (!/^\d+$/.test(line)) throw new GitStorageError("Git packing size unavailable");
    raw += Number(line) + 128;
  }
  const refs = git(root, ["for-each-ref", "--format=%(objectname) %(refname)"]);
  if (!refs.ok) throw new GitStorageError("Git packing ref size unavailable");
  // Packed refs can dwarf object bytes when many long names share one object.
  // Include their text plus room for one peeled object line per reference.
  const refBytes = Buffer.byteLength(refs.stdout) + refs.stdout.split("\n").filter(Boolean).length * 128;
  const requiredBytes = Math.ceil((3 * (raw + refBytes) + 16 * 1024 ** 2) / 4096) * 4096;
  if (!Number.isSafeInteger(requiredBytes)) throw new GitStorageError("Git packing size exceeds safe accounting");
  let availableBytes: number | null = null;
  try {
    const info = statfsSync(common.stdout, { bigint: true }), bytes = info.bavail * info.bsize;
    if (bytes >= 0n && bytes <= BigInt(Number.MAX_SAFE_INTEGER)) availableBytes = Number(bytes);
  } catch { /* Unknown capacity skips packing. */ }
  return { availableBytes, requiredBytes: null, packingRequiredBytes: requiredBytes, reason: "Three times raw object bytes plus 128 bytes per object and ref text plus 128 bytes per ref, plus 16 MiB fixed overhead; old packs coexist. No space is reserved by the CLI." };
}
