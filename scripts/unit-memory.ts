/** Incremental Linux diagnostics survive a killed proof coordinator. */
import { appendFileSync, mkdirSync, readFileSync, readdirSync, readlinkSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

function text(path: string): string | undefined {
  try { return readFileSync(path, "utf8").trim(); } catch { return undefined; }
}
function fields(value: string | undefined): Record<string, number> {
  return Object.fromEntries((value ?? "").split("\n").flatMap(line => {
    const match = /^(\w+):?\s+(\d+)/.exec(line);
    return match ? [[match[1]!, Number(match[2])]] : [];
  }));
}

export function unitMemorySnapshot(proc = "/proc", cgroup = "/sys/fs/cgroup") {
  const meminfoKiB = fields(text(join(proc, "meminfo")));
  const groups = [];
  const membership = text(join(proc, "self/cgroup"));
  const v2 = /^0::(.*)$/m.exec(membership ?? "")?.[1];
  const v1 = /^\d+:[^:\n]*\bmemory\b[^:\n]*:(.*)$/m.exec(membership ?? "")?.[1];
  const base = resolve(cgroup, v2 !== undefined ? "." : "memory");
  let path = resolve(base, `.${v2 ?? v1 ?? "/"}`);
  // Include ancestors: the job may be limited above its immediate cgroup.
  while (path === base || path.startsWith(`${base}/`)) {
    const names = v2 !== undefined ? ["memory.current", "memory.peak", "memory.max", "memory.events"] :
      ["memory.usage_in_bytes", "memory.max_usage_in_bytes", "memory.limit_in_bytes", "memory.failcnt"];
    const [current, peak, limit, events] = names.map(name => text(join(path, name)));
    if (current !== undefined || peak !== undefined) groups.push({ path, current, peak, limit, events });
    if (path === base) break;
    path = dirname(path);
  }
  const processes = [];
  for (const pid of readdirSync(proc).filter(name => /^\d+$/.test(name))) {
    const status = text(join(proc, pid, "status"));
    const values = fields(status);
    if (!values.VmRSS) continue;
    let cwd: string | undefined;
    try { cwd = readlinkSync(join(proc, pid, "cwd")); } catch { /* Exited or inaccessible. */ }
    processes.push({ pid: Number(pid), ppid: values.PPid, rssKiB: values.VmRSS, peakRssKiB: values.VmHWM,
      name: /^Name:\s+(.+)$/m.exec(status ?? "")?.[1], cwd,
      command: text(join(proc, pid, "cmdline"))?.replaceAll("\0", " ").slice(0, 2048) });
  }
  return { at: new Date().toISOString(), meminfoKiB, cgroups: groups,
    topRss: processes.sort((a, b) => b.rssKiB - a.rssKiB || a.pid - b.pid).slice(0, 20) };
}

/** Separate writer + synchronous appends retain every completed sample on SIGKILL. */
export async function startUnitMemorySampler(output: string, intervalMs = 10_000, logSummary = false) {
  if (!Number.isSafeInteger(intervalMs) || intervalMs < 1) throw new Error("Invalid unit memory sampling interval");
  let ready!: () => void;
  const started = new Promise<void>(resolve => { ready = resolve; });
  const child = Bun.spawn([process.execPath, import.meta.path, "--sample", output, String(intervalMs), ...(logSummary ? ["--log-summary"] : [])], {
    stdin: "ignore", stdout: "inherit", stderr: "inherit", ipc(message) { if (message === "ready") ready(); },
  });
  await Promise.race([started, child.exited.then(code => { throw new Error(`Unit memory sampler exited before startup (${code})`); })]);
  return { async stop() {
    if (child.exitCode === null && child.signalCode === null) child.send("stop");
    const code = await child.exited;
    if (code !== 0 || child.signalCode) throw new Error(`Unit memory sampler failed (${child.signalCode ?? code})`);
  } };
}

if (import.meta.main && process.argv[2] === "--sample") {
  const output = process.argv[3]!, interval = Number(process.argv[4]);
  if (!output || !Number.isSafeInteger(interval) || interval < 1 || !process.send) throw new Error("Expected private unit memory sampler invocation");
  mkdirSync(dirname(output), { recursive: true });
  writeFileSync(output, "");
  const sample = (event: string) => {
    const record = { event, ...unitMemorySnapshot() };
    appendFileSync(output, JSON.stringify(record) + "\n");
    // A runner shutdown can prevent artifact upload. Keep a compact receipt in
    // the live job log as well; full process tables remain in the artifact.
    if (process.argv[5] === "--log-summary") console.log(`BRAIN_UNIT_MEMORY ${JSON.stringify({
      at: record.at, event, memAvailableKiB: record.meminfoKiB.MemAvailable,
      cgroups: record.cgroups, topRss: record.topRss.slice(0, 3),
    })}`);
  };
  const finish = (event: string) => { sample(event); process.exit(0); };
  process.on("SIGTERM", () => finish("SIGTERM"));
  process.on("SIGINT", () => finish("SIGINT"));
  process.on("disconnect", () => finish("coordinator-disconnected"));
  process.on("message", message => { if (message === "stop") finish("stop"); });
  sample("start");
  process.send("ready");
  setInterval(() => sample("interval"), interval);
}
