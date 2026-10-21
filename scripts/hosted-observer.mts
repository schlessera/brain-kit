/** Diagnostic-only opt-in; no timers, dependency patches or proof authority. */
import { closeSync, constants, openSync, readFileSync, writeSync } from "node:fs";
import { join } from "node:path";

const directory = process.env.BRAIN_HOSTED_OBSERVER_DIR;
let fd: number | undefined, unavailable = false, sequence = 0, bytes = 0;
let costNs = 0n;
let identity: string | undefined;
function disable(reason: string) {
  if (unavailable) return;
  unavailable = true;
  if (fd !== undefined) { try { closeSync(fd); } catch {} fd = undefined; }
  try { console.error(`HOSTED_OBSERVER_INCOMPLETE ${reason}`); } catch {}
}
/** Slots bound all phase writers together to 128 MiB. Never throw into the workload. */
export function observation(name: string, data?: unknown) {
  if (!directory || unavailable) return;
  const start = process.hrtime.bigint();
  try {
    if (fd === undefined) {
      const stat = readFileSync("/proc/self/stat", "utf8");
      identity = `${process.pid}:${stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19]}`;
      for (let slot = 0; slot < 128; slot++) {
        try { fd = openSync(join(directory, `phase-${slot}.jsonl`), constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600); break; }
        catch (error) { if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error; }
      }
      if (fd === undefined) { disable("phase slots exhausted"); return; }
    }
    const line = JSON.stringify({ name, data, key: identity, pid: process.pid, ppid: process.ppid,
      sequence: ++sequence, epochMs: Date.now(), ns: start.toString(), cpu: process.cpuUsage(),
      memory: process.memoryUsage(), observerNsBefore: costNs.toString() }) + "\n";
    const size = Buffer.byteLength(line);
    if (size > 65536 || bytes + size > 1048576) { disable("phase bytes exhausted"); return; }
    const count = writeSync(fd, line);
    if (count !== size) { disable("short phase write"); return; }
    bytes += count;
  } catch { disable("phase write failed"); }
  finally { costNs += process.hrtime.bigint() - start; }
}
export function beginObservation(name: string, data?: unknown) {
  if (!directory) return undefined;
  const id = ++sequence;
  observation(name + ".begin", { id, data });
  return { name, id };
}
export function endObservation(span: ReturnType<typeof beginObservation>, data?: unknown) {
  if (span) observation(span.name + ".end", { id: span.id, data });
}
// These are synchronous lifecycle observations, not listeners that retain the loop.
if (directory) process.on("exit", code => {
  observation("process.exit", { code });
  if (fd !== undefined) { try { closeSync(fd); } catch {} fd = undefined; }
});
