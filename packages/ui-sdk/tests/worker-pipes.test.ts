/**
 * #1648: a worker's output pipes are read without holding a thread. Node's fs
 * read streams park a thread-pool thread on every pending FIFO read, and the
 * pool is sized from the CPU count: on a four-CPU CI runner two idle workers
 * held all of it, and every other asynchronous file operation in the server,
 * a maintenance worker's own included, waited for a worker to speak.
 */
import { afterEach, expect, test } from "bun:test";
import { availableParallelism } from "node:os";
import { closeSync, mkdtempSync, rmSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkerPipes, fifoStream } from "../src/server/worker-pipes";

const cleanups: (() => void)[] = [];
afterEach(() => { for (const cleanup of cleanups.splice(0)) cleanup(); });

test("many idle worker outputs leave asynchronous file I/O free", async () => {
  // Comfortably more pending reads than any CPU-sized pool holds.
  const workers = 8 * availableParallelism() + 16;
  for (let i = 0; i < workers; i++) {
    const pipes = createWorkerPipes();
    cleanups.push(() => pipes.closeChild());
    if (i % 2) {
      const { stdout, stderr } = pipes.streams();
      stdout.on("data", () => {}); stderr.on("data", () => {});
    } else {
      const ends = pipes.take();
      cleanups.push(() => closeSync(ends.stdin));
      for (const fd of [ends.stdout, ends.stderr]) void new Response(fifoStream(fd)).text();
    }
  }
  const dir = mkdtempSync(join(tmpdir(), "worker-pipes-"));
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
  const io = (async () => {
    await writeFile(join(dir, "harbor.md"), "Ithaca\n");
    return readFile(join(dir, "harbor.md"), "utf8");
  })();
  const stalled = new Promise<string>(resolve => setTimeout(() => resolve("stalled"), 5_000));
  expect(await Promise.race([io, stalled])).toBe("Ithaca\n");
});
