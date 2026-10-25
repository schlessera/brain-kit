import { closeSync, fstatSync, mkdtempSync, openSync, readdirSync, rmSync, statSync, constants, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { runWorkerStepsSync, workerStepRun } from "./worker-steps.js";

/**
 * Reads a worker's FIFO end with Bun's own file stream, which polls the
 * descriptor. Node's fs read streams block a thread-pool thread for every
 * pending read, and the pool is sized from the CPU count: on a four-CPU host
 * two idle workers hold all of it, and every other asynchronous file
 * operation in the server stalls behind them. The descriptor is closed once
 * the stream ends, fails or is cancelled.
 */
export function fifoStream(fd: number): ReadableStream<Uint8Array> {
  const reader = Bun.file(fd).stream().getReader();
  let closed = false;
  const close = () => { if (!closed) { closed = true; closeSync(fd); } };
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read();
        if (done) { close(); controller.close(); } else controller.enqueue(value);
      } catch (error) { close(); controller.error(error); }
    },
    async cancel() { try { await reader.cancel(); } finally { close(); } },
  });
}

/** A FIFO by inode: what every descriptor on it shares, whatever its number. */
interface FifoIdentity { readonly dev: number; readonly ino: number }

const fifoHeld = (fifos: readonly FifoIdentity[]): boolean => {
  let fds: string[];
  try { fds = readdirSync("/proc/self/fd"); } catch { return false; }
  return fds.some(fd => {
    try { const { dev, ino } = statSync(`/proc/self/fd/${fd}`); return fifos.some(fifo => fifo.dev === dev && fifo.ino === ino); }
    catch { return false; }
  });
};

/**
 * Resolves once no descriptor in this process refers to any of these FIFOs
 * (#2862). Bun's file stream and sink (`fifoStream`, `Bun.file(fd).writer()`)
 * work through their own duplicate of the descriptor they are given, and
 * close it on one of Bun's pool threads after the stream ends, with nothing a
 * caller can await: while asynchronous file I/O holds the pool, the duplicate
 * stays open. The wait is bounded, because that duplicate is Bun's to close:
 * after `limitMs`, or where `/proc/self/fd` cannot be read, it resolves
 * without that confirmation. One scan of the descriptor table is the usual cost.
 */
async function fifosReleased(fifos: readonly FifoIdentity[], limitMs = 5_000): Promise<void> {
  const deadline = performance.now() + limitMs;
  for (let wait = 1; fifoHeld(fifos) && performance.now() < deadline; wait = Math.min(wait * 2, 16)) await Bun.sleep(wait);
}

/** Bun's web stream and Node's typings differ only in name. */
const nodeReadable = (stream: ReadableStream<Uint8Array>): Readable =>
  Readable.fromWeb(stream as unknown as import("node:stream/web").ReadableStream<Uint8Array>);

/** Bun's "pipe" channels are sockets. Use owned, unlinked real FIFO endpoints. */
export function createWorkerPipes() {
  return runWorkerStepsSync(createWorkerPipesSteps());
}

/**
 * The same pipes as steps (#2799): the asynchronous probe, launch and
 * maintenance forms await `mkfifo` instead of blocking the event loop while
 * a loaded host starts it. Every descriptor and the FIFO paths are released
 * when any step fails; the paths are gone before the caller can start a worker.
 */
export function* createWorkerPipesSteps() {
  const root = mkdtempSync(join(tmpdir(), "brain-worker-pipes-"));
  const owned = new Set<number>();
  const fifos: FifoIdentity[] = [];
  const close = (fd: number): void => { if (owned.delete(fd)) closeSync(fd); };
  const cleanup = (): void => { for (const fd of [...owned]) close(fd); };
  try {
    const paths = ["stdin", "stdout", "stderr"].map(name => join(root, name));
    const mkfifo = Bun.which("mkfifo");
    if (!mkfifo) throw new Error("mkfifo is required for pipe-only worker stdio");
    const result = yield* workerStepRun([mkfifo, "-m", "600", ...paths]);
    if (result.exitCode !== 0) throw new Error(`mkfifo failed: ${result.stderr}`);
    const channel = (path: string): [number, number] => {
      const hold = openSync(path, constants.O_RDWR); owned.add(hold);
      const { dev, ino } = fstatSync(hold); fifos.push({ dev, ino });
      const reader = openSync(path, constants.O_RDONLY); owned.add(reader);
      const writer = openSync(path, constants.O_WRONLY); owned.add(writer);
      close(hold);
      return [reader, writer];
    };
    const [input, output, error] = paths.map(channel) as [[number, number], [number, number], [number, number]];
    // Paths disappear before any worker starts; the only access is through the
    // three explicit protocol descriptors. No host-backed scratch is exposed.
    rmSync(root, { recursive: true });
    return {
      child: [input[0], output[1], error[1]] as const,
      parent: [input[1], output[0], error[0]] as const,
      closeChild: () => { for (const fd of [input[0], output[1], error[1]]) close(fd); },
      closeInput: () => close(input[1]),
      cleanup,
      /** Resolves once no descriptor on these FIFOs remains in this process, Bun's own duplicates included. */
      released: () => fifosReleased(fifos),
      /** The parent's three ends as raw descriptors, now owned by the caller. */
      take: () => {
        for (const fd of [input[1], output[0], error[0]]) owned.delete(fd);
        return { stdin: input[1], stdout: output[0], stderr: error[0] };
      },
      /** The parent's ends as Node streams; both outputs poll (see `fifoStream`). */
      streams: () => {
        const stdin = createWriteStream("", { fd: input[1], autoClose: true });
        const stdout = nodeReadable(fifoStream(output[0]));
        const stderr = nodeReadable(fifoStream(error[0]));
        // Streams now own these ends; never close a recycled descriptor later.
        for (const fd of [input[1], output[0], error[0]]) owned.delete(fd);
        return { stdin, stdout, stderr };
      },
    };
  } catch (error) { cleanup(); throw error; }
  finally { rmSync(root, { recursive: true, force: true }); }
}
