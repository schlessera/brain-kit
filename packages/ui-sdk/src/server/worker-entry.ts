/** Trusted bootstrap only: no adapter, SDK, extension or worker module is imported here. */
import { closeSync, fstatSync, readFileSync, readdirSync, readlinkSync, writeSync } from "node:fs";
import { workerLaunchPayload } from "../config/env.js";

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
  const config = JSON.parse(workerLaunchPayload() ?? "null") as { argv: string[] } | null;
  if (!config?.argv[0]) throw new Error("missing server-owned launcher arguments");
  // Close every non-protocol descriptor explicitly. New runtime descriptors
  // carry CLOEXEC; execve discards them too. No agent code exists in this process.
  for (const fd of descriptors) closeSync(fd);
  process.execve(config.argv[0], config.argv, {});
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
