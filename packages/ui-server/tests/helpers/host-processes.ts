/** Observe real host PIDs despite the worker's private PID namespace. */
import { readdirSync, readFileSync } from "node:fs";
export function hostProcessesWithArg(argument: string, also?: string): number[] {
  return readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => {
    try { const args = readFileSync(`/proc/${name}/cmdline`, "utf8").split("\0").slice(1); return args.includes(argument) && (!also || args.includes(also)) ? [Number(name)] : []; }
    catch { return []; }
  });
}
export async function waitForHostProcesses(argument: string, also?: string): Promise<number[]> {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    const pids = hostProcessesWithArg(argument, also);
    if (pids.length) return pids;
    await Bun.sleep(10);
  }
  throw new Error("Fixture child did not start");
}
export function hostProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true; } catch { return false; }
}
