/** Observe real host processes despite the worker's private PID namespace. */
import { readdirSync, readFileSync } from "node:fs";

export interface HostProcess {
  readonly pid: number;
  /** Linux /proc stat field 22; retain ticks as text without number rounding. */
  readonly startTime: string;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException)?.code === "ENOENT";
}

function processStat(pid: number): HostProcess & { state: string } {
  const text = readFileSync(`/proc/${pid}/stat`, "utf8");
  // comm can contain spaces and closing parentheses; all later fields cannot.
  const end = text.lastIndexOf(")");
  const fields = text.slice(end + 2).trim().split(/\s+/);
  if (!text.startsWith(`${pid} (`) || end < 0 || text[end + 1] !== " " ||
      !/^[RSDZTtXxKWPI]$/.test(fields[0] ?? "") || !/^\d+$/.test(fields[19] ?? "")) {
    throw new Error(`Invalid /proc/${pid}/stat`);
  }
  return { pid, startTime: fields[19]!, state: fields[0]! };
}

export function hostProcessesWithArg(argument: string, also?: string): HostProcess[] {
  return readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => {
    const pid = Number(name);
    try {
      const before = processStat(pid);
      const args = readFileSync(`/proc/${pid}/cmdline`, "utf8").split("\0").slice(1);
      const after = processStat(pid);
      return before.startTime === after.startTime && after.state !== "Z" &&
        args.includes(argument) && (!also || args.includes(also))
        ? [{ pid, startTime: after.startTime }] : [];
    } catch (error) {
      if (missing(error)) return []; // Entry disappeared during this scan.
      throw error; // An unreadable/invalid entry is not evidence of absence.
    }
  });
}

export async function waitForHostProcesses(argument: string, also?: string): Promise<HostProcess[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const pids = hostProcessesWithArg(argument, also);
    if (pids.length) return pids;
    await Bun.sleep(10);
  }
  throw new Error("Fixture child did not start");
}

/**
 * Whether this captured identity has not exited. A zombie has exited even
 * though kill(pid, 0) still succeeds. This does not reap it or join descendants:
 * callers must retain their native payload/pipe/release joins. Stopped tasks
 * remain live. Only ENOENT or a different start identity proves it is gone;
 * all other read/parse failures throw rather than passing an exit assertion.
 */
export function hostProcessAlive(process: HostProcess): boolean {
  try {
    const before = processStat(process.pid);
    const after = processStat(process.pid);
    return before.startTime === process.startTime && after.startTime === process.startTime && after.state !== "Z";
  } catch (error) {
    if (missing(error)) return false;
    throw error;
  }
}
