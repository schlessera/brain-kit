/** Hosted runner disk provisioning and free-space attribution (#3256).
 *
 * Fixtures that run real turns share the product's free-space floor:
 * `max(5% of total, SCOPE_FREE_BYTES)` on the brain's filesystem
 * (`check`, packages/ui-server/src/brain/turn-scope.ts). The hosted unit
 * runner keeps its brains under the root filesystem's /tmp, where three
 * copies of the frozen install, two worker trees, Chrome and the pinned
 * container image compete with preinstalled toolchains no job here uses.
 * When that left less than the floor, turns stopped and tests failed as
 * product failures (`provenBy: null`).
 *
 *   bun scripts/ci-disk.ts reclaim   # unit setup: remove unused toolchains,
 *                                    # record and require proof headroom
 *
 * `reclaim` removes only the fixed `RECLAIMABLE` directories, then refuses
 * to continue (an infrastructure setup failure) unless the fixtures' floor
 * plus `PROOF_RESERVE_BYTES` remains. `diskSampler` follows the same
 * filesystem through proof so a dip below the floor is reported by name. */
import { appendFileSync, existsSync, mkdirSync, statfsSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** The production minimum, `SCOPE_FREE_BYTES` in turn-scope.ts; tests pin equality. */
export const TURN_FREE_BYTES = 2 * 1024 ** 3;

/** What the unit proof itself writes after setup, with margin (#3256 qualification):
 * two worker copies of the frozen install, worker trees and builds, the pinned
 * lease image and fixture brains. */
export const PROOF_RESERVE_BYTES = 12 * 1024 ** 3;

/** Preinstalled hosted-image toolchains that no brain-kit job uses. Never a
 * path the proof reads: Chrome, Docker, Bun, Node and apt stay intact. */
export const RECLAIMABLE = [
  "/usr/local/lib/android",
  "/usr/share/dotnet",
  "/opt/ghc",
  "/usr/local/.ghcup",
  "/opt/hostedtoolcache/CodeQL",
  "/usr/share/swift",
] as const;

export interface DiskReading { path: string; totalBytes: number; availableBytes: number; floorBytes: number }
type Statfs = (path: string) => { blocks: number; bsize: number; bavail: number };

export function turnFreeSpaceFloor(totalBytes: number): number {
  return Math.max(totalBytes * .05, TURN_FREE_BYTES);
}

export function readDisk(path = tmpdir(), statfs: Statfs = statfsSync): DiskReading {
  const fs = statfs(path);
  const totalBytes = fs.blocks * fs.bsize;
  return { path, totalBytes, availableBytes: fs.bavail * fs.bsize, floorBytes: turnFreeSpaceFloor(totalBytes) };
}

const gib = (bytes: number) => `${(bytes / 1024 ** 3).toFixed(2)} GiB`;

/** The setup refusal: a named infrastructure prerequisite, never a test failure. */
export function headroomProblem(reading: DiskReading, reserve = PROOF_RESERVE_BYTES): string | undefined {
  const required = reading.floorBytes + reserve;
  if (reading.availableBytes >= required) return undefined;
  return `Runner disk at ${reading.path} has ${reading.availableBytes} available bytes (${gib(reading.availableBytes)}); `
    + `unit proof needs ${required} (turn-fixture floor ${reading.floorBytes} = max(5% of ${reading.totalBytes}, ${TURN_FREE_BYTES}) `
    + `plus a ${reserve}-byte proof reserve). This is a runner provisioning failure, not a test result.`;
}

/** A proof that dipped below the floor ran its turn fixtures on a runner that
 * could not admit turns; any failure there is attributed to the runner. */
export function floorProblem(path: string, minimumAvailableBytes: number, floorBytes: number): string | undefined {
  if (minimumAvailableBytes >= floorBytes) return undefined;
  return `Runner disk at ${path} fell to ${minimumAvailableBytes} available bytes (${gib(minimumAvailableBytes)}) during proof, `
    + `below the turn-fixture free-space floor of ${floorBytes} bytes (${gib(floorBytes)}). Turns stop at that floor, `
    + "so turn-dependent test failures in this job are runner disk exhaustion (#3256), not product results.";
}

/** One-second sampling of the fixtures' filesystem during proof. */
export function diskSampler(path = tmpdir(), statfs: Statfs = statfsSync) {
  const first = readDisk(path, statfs);
  let minimum = first.availableBytes, last = first.availableBytes, samples = 1;
  const sample = () => {
    try { const reading = readDisk(path, statfs); last = reading.availableBytes; minimum = Math.min(minimum, last); samples++; }
    catch { /* A transient statfs failure leaves the recorded minimum intact. */ }
  };
  return {
    sample,
    summary: () => ({ path, totalBytes: first.totalBytes, floorBytes: first.floorBytes, startAvailableBytes: first.availableBytes,
      minimumAvailableBytes: minimum, endAvailableBytes: last, samples,
      belowFloor: minimum < first.floorBytes }),
  };
}

export async function reclaim(options: { root: string; path?: string; remove?: (paths: string[]) => Promise<void>;
  exists?: (path: string) => boolean; statfs?: Statfs; summary?: string }) {
  const path = options.path ?? tmpdir();
  const exists = options.exists ?? existsSync;
  const before = readDisk(path, options.statfs);
  const removed = RECLAIMABLE.filter(dir => exists(dir));
  const started = performance.now();
  await (options.remove ?? removeAll)([...removed]);
  const elapsedSeconds = (performance.now() - started) / 1000;
  const after = readDisk(path, options.statfs);
  const problem = headroomProblem(after);
  const record = { path, removed, elapsedSeconds, before, after, reserveBytes: PROOF_RESERVE_BYTES,
    reclaimedBytes: after.availableBytes - before.availableBytes, problem: problem ?? null };
  mkdirSync(join(options.root, "tmp"), { recursive: true });
  writeFileSync(join(options.root, "tmp/runner-disk.json"), JSON.stringify(record, null, 2));
  console.log(`BRAIN_RUNNER_DISK ${JSON.stringify(record)}`);
  if (options.summary) appendFileSync(options.summary,
    `Runner disk at ${path}: ${gib(before.availableBytes)} available before, ${gib(after.availableBytes)} after removing `
    + `${removed.length} unused toolchain(s) in ${elapsedSeconds.toFixed(1)} s; turn-fixture floor ${gib(after.floorBytes)}.\n`);
  return record;
}

async function removeAll(paths: string[]) {
  const children = paths.map(path => Bun.spawn(["sudo", "rm", "-rf", "--one-file-system", "--", path], { stdout: "inherit", stderr: "inherit" }));
  const codes = await Promise.all(children.map(child => child.exited));
  const failed = paths.filter((_, index) => codes[index] !== 0);
  if (failed.length) throw new Error(`Could not remove unused runner toolchains: ${failed.join(", ")}`);
}

if (import.meta.main) {
  const [command, ...rest] = process.argv.slice(2);
  if (command !== "reclaim" || rest.length) {
    console.error("usage: bun scripts/ci-disk.ts reclaim");
    process.exit(2);
  }
  const record = await reclaim({ root: join(import.meta.dir, ".."), summary: process.env.GITHUB_STEP_SUMMARY || undefined });
  if (record.problem) { console.error(`::error title=Runner disk below unit proof headroom::${record.problem}`); process.exit(1); }
}
