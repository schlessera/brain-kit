import { closeSync, mkdtempSync, openSync, rmSync, constants, createReadStream, createWriteStream } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
      streams: () => {
        const stdin = createWriteStream("", { fd: input[1], autoClose: true });
        const stdout = createReadStream("", { fd: output[0], autoClose: true });
        const stderr = createReadStream("", { fd: error[0], autoClose: true });
        // Streams now own these ends; never close a recycled descriptor later.
        for (const fd of [input[1], output[0], error[0]]) owned.delete(fd);
        return { stdin, stdout, stderr };
      },
    };
  } catch (error) { cleanup(); throw error; }
  finally { rmSync(root, { recursive: true, force: true }); }
}
