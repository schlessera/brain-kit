import { readFileSync } from "node:fs";

/**
 * Stops a worker whole. The pid the server holds is bubblewrap's outer
 * process; its child is the init of the worker's PID namespace. Killing that
 * init first makes the kernel kill and reap every process in the namespace
 * before the init's exit completes. The outer monitor can exit earlier;
 * runMaintenanceWorker also drains the stdio descriptors held by init.
 * Outer-process settlement alone does not establish completed teardown.
 */
export function killWorker(child: { pid: number; kill(signal?: NodeJS.Signals): void }, signal: NodeJS.Signals = "SIGKILL"): void {
  let inits: number[] = [];
  try {
    inits = readFileSync(`/proc/${child.pid}/task/${child.pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean).map(Number);
  } catch { /* Already gone, or no children list: the outer kill below still applies. */ }
  // A namespace init takes only SIGKILL from outside; the outer process then
  // exits on its own once the namespace is empty.
  let reached = false;
  for (const pid of inits) { try { process.kill(pid, "SIGKILL"); reached = true; } catch { /* Raced away. */ } }
  if (!reached) child.kill(signal);
}
