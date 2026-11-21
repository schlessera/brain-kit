/** Observe the selected payload below an isolation/tracing wrapper, never its launcher PID. */
import { readFileSync, readlinkSync } from "node:fs";
export function selectedNativePid(root: number, expectedExecutable: string): number {
  const pending = [root], seen = new Set<number>();
  for (let count = 0; pending.length && count < 100; count++) {
    const pid = pending.shift()!;
    if (seen.has(pid)) continue; seen.add(pid);
    try { if (readlinkSync(`/proc/${pid}/exe`) === expectedExecutable) return pid; } catch { /* Exited wrappers cannot qualify. */ }
    try { pending.push(...readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number)); } catch { /* Exited processes have no observable children. */ }
  }
  throw new Error("The guarded process tree did not contain the selected native executable.");
}
