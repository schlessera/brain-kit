/** Trusted bootstrap only: no adapter, SDK, extension or worker module is imported here. */
import { closeSync, existsSync, fstatSync, readFileSync, readdirSync, readlinkSync, writeFileSync, writeSync } from "node:fs";
import { workerLaunchPayload } from "../config/env.js";
import { attachMaintenanceTemp } from "./maintenance-temp-budget.js";

try {
  if (process.platform !== "linux" || !process.execve) throw new Error("Linux process.execve is required");
  for (const fd of [0, 1, 2]) {
    if (!fstatSync(fd).isFIFO()) throw new Error(`protocol descriptor ${fd} must be a pipe`);
  }
  const descriptors: number[] = [];
  for (const name of readdirSync("/proc/self/fd")) {
    const fd = Number(name);
    if (fd <= 2) continue;
    // readdir's own descriptor has already closed. Check before opening fdinfo
    // so that our fdinfo read cannot be mistaken for an inherited descriptor.
    let target: string;
    try { target = readlinkSync(`/proc/self/fd/${fd}`); } catch { continue; }
    const flags = readFileSync(`/proc/self/fdinfo/${fd}`, "utf8").match(/^flags:\s+([0-7]+)$/m)?.[1];
    // Bun 1.4.2 opens its read-only urandom device without CLOEXEC. It is
    // runtime-owned, carries no writable authority, and is explicitly closed.
    const runtimeRandom = target === "/dev/urandom" && fstatSync(fd).isCharacterDevice()
      && flags !== undefined && (parseInt(flags, 8) & 3) === 0;
    if (!flags || (!(parseInt(flags, 8) & 0o2000000) && !runtimeRandom)) {
      throw new Error(`non-protocol descriptor ${fd} would be inherited`);
    }
    descriptors.push(fd);
  }
  const config = JSON.parse(workerLaunchPayload() ?? "null") as { argv: string[]; cgroup?: string; maintenanceReservation?: { id: string; directory: string; statePath?: string } } | null;
  if (!config?.argv[0]) throw new Error("missing server-owned launcher arguments");
  if (config.maintenanceReservation) attachMaintenanceTemp(config.maintenanceReservation);
  // Join the worker's own cgroup (#1660) before any worker process exists, so
  // none ever runs outside its limits. The server created it for this launch.
  if (config.cgroup !== undefined) {
    if (!config.cgroup.startsWith("/") || config.cgroup.split("/").includes("..")) throw new Error("invalid worker cgroup");
    writeFileSync(`${config.cgroup}/cgroup.procs`, String(process.pid));
  }
  // Close every non-protocol descriptor explicitly. New runtime descriptors
  // carry CLOEXEC; execve discards them too. No agent code exists in this process.
  for (const fd of descriptors) closeSync(fd);
  // exec preserves SIG_IGN, including Bun's SIGPIPE/SIGXFSZ ignores (#1690).
  // GNU env resets every catchable disposition before becoming bubblewrap;
  // --default-signal alone leaves the signal mask unchanged. Absolute system
  // paths and literal argv keep worker PATH/shell input out of this step.
  const env = ["/usr/bin/env", "/bin/env"].find(existsSync);
  if (!env) throw new Error("GNU coreutils env with --default-signal is required");
  process.execve(env, [env, "--default-signal", "--", ...config.argv], {});
} catch (error) {
  // Refusal itself must never write to a policy-backed diagnostic descriptor.
  for (const fd of [2, 1]) {
    try {
      if (!fstatSync(fd).isFIFO()) continue;
      writeSync(fd, `Worker launcher refused: ${error instanceof Error ? error.message : String(error)}\n`);
      break;
    } catch { /* No safe diagnostic channel: exit without writing. */ }
  }
  process.exit(1);
}
