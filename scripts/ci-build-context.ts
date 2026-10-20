/** Actual fixed-daemon context; necessary identity, never ambient qualification. */
import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { identity } from "./ci-build-boundary";
import { dockerControl, inspectOwnedBuildContainer, removeOwnedBuildContainer } from "./ci-build-lifetime";

// Self-contained so the fixed image's Node executes the exact same reader used
// inside the compiling container. No caller-selected program or operand.
export function readBuildKernelContext() {
  const { readFileSync } = require("node:fs") as typeof import("node:fs");
  const { createHash } = require("node:crypto") as typeof import("node:crypto");
  const hash = (path: string) => createHash("sha256").update(readFileSync(path)).digest("hex");
  const status = readFileSync("/proc/self/status", "utf8");
  const affinity = status.match(/^Cpus_allowed_list:\s*(.+)$/m)?.[1];
  if (!affinity || !/^[0-9,-]+$/.test(affinity)) throw new Error("Unavailable producer CPU affinity");
  return { affinity, boot: hash("/proc/sys/kernel/random/boot_id"), kernel: hash("/proc/sys/kernel/osrelease"), version: hash("/proc/version") };
}
export function readBuildDaemonContext(config: string) {
  const value = JSON.parse(dockerControl(config, "info", "--format", "{{json .}}"));
  const fields = ["ID", "ServerVersion", "KernelVersion", "OSType", "Architecture"] as const;
  if (fields.some(field => typeof value[field] !== "string" || !value[field]) || value.OSType !== "linux") throw new Error("Unavailable build daemon context");
  return Object.fromEntries(fields.map(field => [field, value[field] as string]));
}

export class BuildContextCleanupError extends Error {}

/** Every eligible lookup owns a real, bounded producer-context container. */
export function observeBuildContext(config: string, image: string, state: string) {
  const session = randomUUID(), name = `brain-ci-build-${session}`;
  const daemon = readBuildDaemonContext(config), uid = process.getuid!(), gid = process.getgid!();
  if (!uid || !gid) throw new Error("Build context requires non-root identity");
  let attempted = false, id: string | undefined, drained = false, removed = false;
  let value: { kernel: ReturnType<typeof readBuildKernelContext>; node: string } | undefined;
  let failure: unknown, cleanupFailure: unknown;
  try {
    attempted = true;
    dockerControl(config, "create", "--name", name, "--label", `brain-ci-build-session=${session}`, "--pull=never", "--read-only", "--network=none", "--cap-drop=ALL", "--security-opt=no-new-privileges", "--user", `${uid}:${gid}`, "--hostname", "brain-build", "--cpus=2", "--memory=4g", "--pids-limit=256", "--shm-size=64m", image,
      "/usr/bin/env", "-i", "PATH=/usr/bin:/bin", "LANG=C.UTF-8", "LC_ALL=C.UTF-8", "TZ=UTC", "/usr/bin/timeout", "--signal=TERM", "--kill-after=1s", "5s", "/usr/bin/node", "-e",
      `const kernel=(${readBuildKernelContext.toString()})(); const node=require('node:crypto').createHash('sha256').update(require('node:fs').readFileSync('/proc/self/exe')).digest('hex'); process.stdout.write(JSON.stringify({kernel,node}));`);
    id = inspectOwnedBuildContainer(config, name, session).id;
    const output = dockerControl(config, "start", "--attach", id);
    const { record, running } = inspectOwnedBuildContainer(config, id, session);
    if (running || record.State.ExitCode !== 0 || record.Config.Image !== image || record.Config.User !== `${uid}:${gid}` || !record.HostConfig.ReadonlyRootfs || record.HostConfig.NetworkMode !== "none" || record.HostConfig.Privileged || !record.HostConfig.CapDrop.includes("ALL") || !record.HostConfig.SecurityOpt.includes("no-new-privileges") || record.Mounts.length) throw new Error("Actual context boundary unavailable");
    value = JSON.parse(output);
    if (!value || Object.keys(value).sort().join() !== "kernel,node" || !/^[0-9a-f]{64}$/.test(value.node) || !value.kernel || Object.keys(value.kernel).sort().join() !== "affinity,boot,kernel,version" || !/^[0-9,-]+$/.test(value.kernel.affinity) || [value.kernel.boot, value.kernel.kernel, value.kernel.version].some(hash => !/^[0-9a-f]{64}$/.test(hash))) throw new Error("Incomplete producer context");
    if (identity(readBuildDaemonContext(config)) !== identity(daemon)) throw new Error("Build daemon changed during context lookup");
  } catch (error) { failure = error; }
  finally {
    if (attempted) {
      // Even an ambiguous create timeout must reconcile by this session name.
      // A cleanup error propagates: it cannot be downgraded to ordinary fallback.
      try {
        const owned = inspectOwnedBuildContainer(config, id ?? name, session); id = owned.id;
        removeOwnedBuildContainer(config, id, session); drained = true; removed = true;
      } catch (error) { cleanupFailure = error; }
    }
    try {
      writeFileSync(join(state, "context.json"), JSON.stringify({ version: 1, session, containerID: id, drained, removed, daemon, value, success: !failure && !cleanupFailure }), { flag: "wx", mode: 0o600 });
    } catch (error) { failure ??= error; }
  }
  if (cleanupFailure) throw new BuildContextCleanupError("Build context cleanup incomplete", { cause: cleanupFailure });
  if (failure) throw failure;
  return { binding: { daemon, ...value! }, session, containerID: id!, drained, removed };
}
