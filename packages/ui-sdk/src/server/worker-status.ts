/** Trusted bubblewrap status channel; never accepts a PID from worker output. */
import { closeSync, constants, mkdtempSync, openSync, readFileSync, readlinkSync, readSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const MAX_STATUS_BYTES = 4096;

/** Unlinked FIFO, opened by the fixed trusted launch shell after descriptor filtering. */
export function createWorkerStatusPipe() {
  const directory = mkdtempSync(join(tmpdir(), "brain-worker-status-"));
  const path = join(directory, "status"), gate = join(directory, "gate");
  let hold: number | undefined, reader: number | undefined, writer: number | undefined, gateReader: number | undefined, gateWriter: number | undefined;
  try {
    const mkfifo = Bun.which("mkfifo");
    if (!mkfifo) throw new Error("mkfifo is required for worker status");
    const result = Bun.spawnSync([mkfifo, "-m", "600", path, gate], { stdout: "ignore", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`Worker status pipe creation failed: ${result.stderr.toString()}`);
    hold = openSync(path, constants.O_RDWR);
    reader = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    writer = openSync(path, constants.O_WRONLY);
    closeSync(hold); hold = undefined;
    gateReader = openSync(gate, constants.O_RDONLY | constants.O_NONBLOCK);
    gateWriter = openSync(gate, constants.O_WRONLY);
    const source = `/proc/${process.pid}/fd/${writer}`, gateSource = `/proc/${process.pid}/fd/${gateReader}`;
    let closed = false, writerClosed = false, gateClosed = false;
    const closeGate = () => { if (!gateClosed) { gateClosed = true; closeSync(gateReader!); closeSync(gateWriter!); } };
    return { source, gateSource,
      release() { if (gateClosed) throw new Error("Worker start gate is closed"); writeSync(gateWriter!, "g"); closeGate(); },
      childPid(supervisor: number, deadline: number): number {
        if (closed) throw new Error("Worker status pipe is closed");
        const buffer = Buffer.alloc(MAX_STATUS_BYTES + 1);
        let used = 0;
        for (;;) {
          try { used += readSync(reader!, buffer, used, buffer.length - used, null); }
          catch (error) { if ((error as NodeJS.ErrnoException).code !== "EAGAIN") throw error; }
          const end = buffer.subarray(0, used).indexOf(10);
          if (end >= 0) {
            if (end > MAX_STATUS_BYTES) throw new Error("Worker status exceeds its byte bound");
            const status: unknown = JSON.parse(buffer.subarray(0, end).toString("utf8"));
            if (!status || typeof status !== "object" || !("child-pid" in status)) throw new Error("Worker status has no child PID");
            return verifiedWorkerPid(supervisor, (status as { "child-pid": unknown })["child-pid"]);
          }
          if (used > MAX_STATUS_BYTES) throw new Error("Worker status exceeds its byte bound");
          try {
            const state = readFileSync(`/proc/${supervisor}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[0];
            if (["Z", "X", "x"].includes(state!)) throw new Error("bubblewrap exited before reporting worker status");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code === "ENOENT") throw new Error("bubblewrap exited before reporting worker status");
            throw error;
          }
          if (Date.now() >= deadline) throw new Error("Worker did not report authenticated bubblewrap status in time");
          Bun.sleepSync(1);
        }
      },
      closeWriter() { if (!writerClosed) { writerClosed = true; closeSync(writer!); } },
      close() { if (!closed) { closed = true; closeGate(); closeSync(reader!); if (!writerClosed) { writerClosed = true; closeSync(writer!); } } },
    };
  } catch (error) {
    for (const fd of [hold, reader, writer, gateReader, gateWriter]) if (fd !== undefined) closeSync(fd);
    throw error;
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

/** The reporter must name its live descendant in a different PID namespace. */
export function verifiedWorkerPid(supervisor: number, reported: unknown): number {
  if (typeof reported !== "number" || !Number.isSafeInteger(reported) || reported <= 0 || reported === supervisor)
    throw new Error("Worker status child PID is invalid");
  const start = (pid: number) => readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ");
  const root = start(reported);
  if (["Z", "X", "x"].includes(root[0]!)) throw new Error("Worker status names an exited child");
  if (readlinkSync(`/proc/${reported}/ns/pid`) === readlinkSync("/proc/self/ns/pid"))
    throw new Error("Worker status child must have a private PID namespace");
  let parent = Number(root[1]);
  const visited = new Set<number>([reported]);
  while (parent !== supervisor) {
    if (!Number.isSafeInteger(parent) || parent <= 1 || visited.has(parent) || visited.size >= 256)
      throw new Error("Worker status child does not descend from its supervisor");
    visited.add(parent); parent = Number(start(parent)[1]);
  }
  if (start(reported)[19] !== root[19]) throw new Error("Worker status child identity changed during verification");
  return reported;
}
