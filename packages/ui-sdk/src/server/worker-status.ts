/** Trusted bubblewrap status channel; never accepts a PID from worker output. */
import { closeSync, constants, mkdtempSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, rmSync, writeSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { runWorkerStepsSync, workerStepRun, workerStepSleep, type WorkerSteps } from "./worker-steps.js";

const MAX_STATUS_BYTES = 4096;
/** How long a refusal waits for its supervisor to stop before reading its children. */
const SUPERVISOR_STOP_MS = 2_000;
/** How long a refused gate waits for its killed processes to die before it stays open for good. */
const REFUSAL_DEATH_MS = 10_000;

/**
 * The bubblewrap process a status-gated launch spawned, as `Bun.spawn`
 * returns it. A refusal stops and kills it through this handle, which never
 * signals a PID the runtime has already reaped.
 */
export interface WorkerStatusSupervisor {
  readonly pid: number;
  readonly exitCode: number | null;
  readonly signalCode: string | null;
  readonly exited: Promise<unknown>;
  kill(signal?: NodeJS.Signals | number): void;
}

/** A process by PID and kernel start time, so a recycled PID never matches. */
interface ProcessIdentity { pid: number; start: string }

/** `/proc/<pid>/stat` after the command name: [state, ppid, ..., starttime at 19]. */
function statFields(pid: number): string[] | undefined {
  try { return readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" "); }
  catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") return undefined; throw error; }
}

/** Whether the identified process can still run code: present, the same start, not dead. */
function alive(target: ProcessIdentity): boolean {
  const fields = statFields(target.pid);
  return fields !== undefined && fields[19] === target.start && !["Z", "X", "x"].includes(fields[0]!);
}

function signal(pid: number, name: NodeJS.Signals) {
  try { process.kill(pid, name); }
  catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
}

/** Every child of a process, from the kernel's record or, without CONFIG_PROC_CHILDREN, by parent PID. */
function childrenOf(pid: number): number[] {
  try {
    return readdirSync(`/proc/${pid}/task`).flatMap(task =>
      readFileSync(`/proc/${pid}/task/${task}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return readdirSync("/proc").filter(name => /^\d+$/.test(name) && statFields(Number(name))?.[1] === String(pid)).map(Number);
}

/**
 * Kills everything that could pass a refused start gate (#3387). The
 * supervisor is stopped first, so it can neither fork nor reap: its
 * children's PIDs stay theirs while each is killed. The status-verified
 * gated process is killed too, by identity. Returns what must be seen dead
 * before the gate may close.
 */
function killGatedSandbox(supervisor: WorkerStatusSupervisor, gated: ProcessIdentity | undefined): ProcessIdentity[] {
  const doomed: ProcessIdentity[] = [];
  // Only an unreaped supervisor still owns its PID.
  if (supervisor.exitCode === null && supervisor.signalCode === null) {
    supervisor.kill("SIGSTOP");
    // A stop takes effect when the process next leaves the kernel, so a fork
    // in progress completes and its child is listed before it is read.
    const deadline = Date.now() + SUPERVISOR_STOP_MS;
    for (let state = statFields(supervisor.pid)?.[0]; state !== undefined && !["T", "t", "Z", "X", "x"].includes(state) && Date.now() < deadline;
      state = statFields(supervisor.pid)?.[0]) Bun.sleepSync(1);
    for (const pid of childrenOf(supervisor.pid)) {
      const start = statFields(pid)?.[19];
      if (start === undefined) continue;
      doomed.push({ pid, start });
      signal(pid, "SIGKILL");
    }
  }
  if (gated && alive(gated)) { doomed.push(gated); signal(gated.pid, "SIGKILL"); }
  supervisor.kill("SIGKILL");
  return doomed;
}

/** Resolves true once none of these processes can run code, or false at the deadline. */
async function confirmedDead(processes: ProcessIdentity[], deadline: number): Promise<boolean> {
  for (;;) {
    if (!processes.some(alive)) return true;
    if (Date.now() >= deadline) return false;
    await Bun.sleep(5);
  }
}

/** Unlinked FIFO, opened by the fixed trusted launch shell after descriptor filtering. */
export function createWorkerStatusPipe() {
  return runWorkerStepsSync(createWorkerStatusPipeSteps());
}

/** The same channel as steps, so an asynchronous launch awaits its `mkfifo` (#2799). */
export function* createWorkerStatusPipeSteps() {
  const directory = mkdtempSync(join(tmpdir(), "brain-worker-status-"));
  const path = join(directory, "status"), gate = join(directory, "gate");
  let hold: number | undefined, reader: number | undefined, writer: number | undefined, gateReader: number | undefined, gateWriter: number | undefined;
  try {
    const mkfifo = Bun.which("mkfifo");
    if (!mkfifo) throw new Error("mkfifo is required for worker status");
    const result = yield* workerStepRun([mkfifo, "-m", "600", path, gate]);
    if (result.exitCode !== 0) throw new Error(`Worker status pipe creation failed: ${result.stderr}`);
    hold = openSync(path, constants.O_RDWR);
    reader = openSync(path, constants.O_RDONLY | constants.O_NONBLOCK);
    writer = openSync(path, constants.O_WRONLY);
    closeSync(hold); hold = undefined;
    gateReader = openSync(gate, constants.O_RDONLY | constants.O_NONBLOCK);
    gateWriter = openSync(gate, constants.O_WRONLY);
    const source = `/proc/${process.pid}/fd/${writer}`, gateSource = `/proc/${process.pid}/fd/${gateReader}`;
    let closed = false, writerClosed = false, gateClosed = false;
    let gated: ProcessIdentity | undefined;
    const closeGate = () => { if (!gateClosed) { gateClosed = true; closeSync(gateReader!); closeSync(gateWriter!); } };
    function* childPidSteps(supervisor: number, deadline: number): WorkerSteps<number> {
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
          const pid = verifiedWorkerPid(supervisor, (status as { "child-pid": unknown })["child-pid"]);
          const start = statFields(pid)?.[19];
          if (start === undefined) throw new Error("Worker status names an exited child");
          gated = { pid, start };
          return pid;
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
        yield* workerStepSleep(1);
      }
    }
    return { source, gateSource,
      release() { if (gateClosed) throw new Error("Worker start gate is closed"); writeSync(gateWriter!, "go\n"); closeGate(); },
      childPid(supervisor: number, deadline: number): number { return runWorkerStepsSync(childPidSteps(supervisor, deadline)); },
      /** `childPid`, waiting through steps so an asynchronous launch keeps its event loop (#2416). */
      childPidSteps,
      closeWriter() { if (!writerClosed) { writerClosed = true; closeSync(writer!); } },
      /**
       * Closes the channel. The in-sandbox start gate refuses on the gate's
       * EOF (#3392). As a second guard, an unreleased gate still stays open
       * until the supervisor and every process it gated are dead (#3387). Its
       * supervisor is killed for that. A gate whose processes never die stays
       * open for good: a held descriptor, never a released payload. Only a
       * gate with no supervisor, which nothing can have opened, closes at once.
       */
      close(supervisor?: WorkerStatusSupervisor) {
        if (closed) return;
        closed = true;
        closeSync(reader!);
        if (!writerClosed) { writerClosed = true; closeSync(writer!); }
        if (gateClosed) return;
        if (!supervisor) { closeGate(); return; }
        const doomed = killGatedSandbox(supervisor, gated);
        void supervisor.exited.then(() => undefined, () => undefined)
          .then(() => confirmedDead(doomed, Date.now() + REFUSAL_DEATH_MS))
          .then(dead => { if (dead) closeGate(); });
      },
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
