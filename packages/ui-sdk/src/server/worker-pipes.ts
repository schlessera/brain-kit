import { closeSync, mkdtempSync, openSync, rmSync, constants, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";

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

/** Bun's web stream and Node's typings differ only in name. */
const nodeReadable = (stream: ReadableStream<Uint8Array>): Readable =>
  Readable.fromWeb(stream as unknown as import("node:stream/web").ReadableStream<Uint8Array>);

/** Bun's "pipe" channels are sockets. Use owned, unlinked real FIFO endpoints. */
export function createWorkerPipes() {
  const root = mkdtempSync(join(tmpdir(), "brain-worker-pipes-"));
  const owned = new Set<number>();
  const close = (fd: number): void => { if (owned.delete(fd)) closeSync(fd); };
  const cleanup = (): void => { for (const fd of [...owned]) close(fd); };
  try {
    const paths = ["stdin", "stdout", "stderr"].map(name => join(root, name));
    const mkfifo = Bun.which("mkfifo");
    if (!mkfifo) throw new Error("mkfifo is required for pipe-only worker stdio");
    const result = Bun.spawnSync([mkfifo, "-m", "600", ...paths], { stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`mkfifo failed: ${result.stderr.toString()}`);
    const channel = (path: string): [number, number] => {
      const hold = openSync(path, constants.O_RDWR); owned.add(hold);
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
