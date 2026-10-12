/** Server-owned process control, restricted to one verified worker PID namespace. */
import { readFileSync, readlinkSync, readdirSync, realpathSync } from "node:fs";

type Task = { pid: number; parent: number; start: string; namespace: string; state: string };
function task(pid: number): Task | undefined {
  try {
    const fields = readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ");
    return { pid, parent: Number(fields[1]), start: fields[19]!, state: fields[0]!, namespace: readlinkSync(`/proc/${pid}/ns/pid`) };
  } catch { return undefined; }
}

/** Never signals a host process or a recycled PID. The launcher supplies bubblewrap's sole child. */
export function createWorkerFreezer(pid: number) {
  const root = task(pid), host = readlinkSync("/proc/self/ns/pid");
  if (!root) return { freeze() {}, resume() {} };
  if (root.namespace === host) throw new Error("Worker freeze requires a verified private PID namespace");
  // bubblewrap's trusted PID-1 reaper must handle parent death even while the
  // agent is frozen. Stopping it leaves SIGTERM pending on host interruption.
  let reaper = false;
  try { reaper = readFileSync(`/proc/${pid}/status`, "utf8").match(/^NSpid:\s+(.+)$/m)?.[1]?.trim().split(/\s+/).at(-1) === "1"
    && readlinkSync(`/proc/${pid}/exe`) === realpathSync(Bun.which("bwrap")!);
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT" || (error as NodeJS.ErrnoException).code === "ESRCH") return { freeze() {}, resume() {} }; throw error; }
  let frozen: Task[] = [];
  const current = (entry: Task) => { const now = task(entry.pid); return now?.start === entry.start && now.namespace === entry.namespace ? now : undefined; };
  const signal = (entry: Task, name: NodeJS.Signals) => {
    if (!current(entry)) return;
    try { process.kill(entry.pid, name); } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error; }
  };
  function members(): Task[] {
    if (!current(root!)) return [];
    const tasks = readdirSync("/proc").filter(name => /^\d+$/.test(name)).flatMap(name => { const value = task(Number(name)); return value ? [value] : []; });
    const found = new Map(tasks.filter(entry => entry.namespace === root!.namespace).map(entry => [entry.pid, entry]));
    // Children may enter nested PID namespaces; their verified ancestry still belongs to this worker.
    let added = true;
    while (added) { added = false; for (const entry of tasks) if (!found.has(entry.pid) && found.has(entry.parent)) { found.set(entry.pid, entry); added = true; } }
    return [...found.values()].filter(entry => !reaper || entry.pid !== root!.pid);
  }
  return {
    freeze() {
      if (!reaper) signal(root!, "SIGSTOP");
      const deadline = Date.now() + 5_000;
      for (;;) {
        const seen = members();
        for (const entry of seen) { if (!frozen.some(prior => prior.pid === entry.pid && prior.start === entry.start)) frozen.push(entry); signal(entry, "SIGSTOP"); }
        if (!current(root!)) return;
        // PID-1 may still be forking the first agent process at launch. An
        // empty scan is not a confirmed pause while that reaper is alive.
        if (seen.length > 0 && seen.every(entry => { const now = current(entry); return !now || ["T", "t", "Z"].includes(now.state); })) return;
        if (Date.now() >= deadline) throw new Error("Worker process tree did not confirm its frozen state");
        Bun.sleepSync(1);
      }
    },
    resume() { for (const entry of frozen) signal(entry, "SIGCONT"); frozen = []; },
  };
}
