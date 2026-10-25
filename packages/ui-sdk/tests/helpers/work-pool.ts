/** Bun's pool held while worker stdio closes, and the descriptors still open on worker FIFOs (#2862, #2863). */
import { availableParallelism, tmpdir } from "node:os";
import { closeSync, constants, mkdtempSync, openSync, read, readdirSync, readlinkSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";

/**
 * Holds every thread of Bun's pool on a blocking FIFO read until `release`.
 * Bun's file streams and sinks close their duplicate descriptors on that pool
 * (#2862), so while it is held they stay open after their streams end.
 * Asynchronous `node:fs` work waits for it too.
 */
export function holdWorkPool(dir: string) {
  const plug = join(dir, "pool-plug");
  if (Bun.spawnSync(["mkfifo", plug]).exitCode !== 0) throw new Error("mkfifo failed");
  const writer = openSync(plug, constants.O_RDWR);
  const reads = Array.from({ length: 8 * availableParallelism() + 16 }, () => {
    const fd = openSync(plug, constants.O_RDONLY);
    return new Promise<void>(done => read(fd, Buffer.alloc(1), 0, 1, null, () => { closeSync(fd); done(); }));
  });
  let released: Promise<void> | undefined;
  return { release: () => released ??= (writeSync(writer, Buffer.alloc(reads.length)), Promise.all(reads).then(() => closeSync(writer))) };
}

/**
 * A private TMPDIR, so every worker FIFO this process creates lives below it.
 * `held()` lists the descriptors this process still has open on any of them.
 */
export function ownedWorkerFifos() {
  const dir = mkdtempSync(join(tmpdir(), "worker-fifos-owned-"));
  const previous = process.env.TMPDIR;
  process.env.TMPDIR = dir;
  const fifos = join(dir, "brain-worker-pipes-");
  return {
    dir,
    held: () => readdirSync("/proc/self/fd").flatMap(fd => {
      try { const target = readlinkSync(`/proc/self/fd/${fd}`); return target.startsWith(fifos) ? [target] : []; } catch { return []; }
    }),
    restore: () => {
      if (previous === undefined) delete process.env.TMPDIR; else process.env.TMPDIR = previous;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
