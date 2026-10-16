/** Optional installed RTK evidence belongs to one kernel-observed live worker. */
import { accessSync, constants, readFileSync, realpathSync, statSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import { rewriteInstalledRtk } from "./rtk.js";
import type { LaunchedWorker, WorkerLaunch } from "./worker-launcher.js";

interface View { pid: number; start: string; input: WorkerLaunch; alive: boolean; execution?: { pid: number; start: string }; }
const views = new WeakMap<object, View>();
function start(pid: number): string {
  const fields = readFileSync(`/proc/${pid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ");
  if (["Z", "X"].includes(fields[0]!) || !/^\d+$/.test(fields[19] ?? "")) throw new Error("RTK worker identity unavailable");
  return fields[19]!;
}
export function registerWorkerRtk(worker: LaunchedWorker, pid: number, input: WorkerLaunch): void {
  try {
    const view = { pid, start: start(pid), input, alive: true };
    views.set(worker, view);
    void worker.exited.then(() => { view.alive = false; }, () => { view.alive = false; });
  } catch { /* An unreadable worker cannot authorize an optional rewrite. */ }
}
function within(root: string, path: string): boolean { return path === root || path.startsWith(root + "/"); }
/** ELF64 native static executables, including dependency-free static PIE. */
export function isStaticNativeElf(path: string): boolean {
  const bytes = readFileSync(path);
  if (bytes.length < 64 || bytes.toString("hex", 0, 4) !== "7f454c46" || bytes[4] !== 2 || bytes[5] !== 1) return false;
  const machine = process.arch === "x64" ? 62 : process.arch === "arm64" ? 183 : undefined;
  const type = bytes.readUInt16LE(16);
  if (!machine || bytes.readUInt16LE(18) !== machine || ![2, 3].includes(type)) return false;
  const offset = Number(bytes.readBigUInt64LE(32)), size = bytes.readUInt16LE(54), count = bytes.readUInt16LE(56);
  if (!Number.isSafeInteger(offset) || size !== 56 || count === 0 || count > 256 || offset + size * count > bytes.length) return false;
  let dynamic = false, pie = false;
  for (let i = 0; i < count; i++) {
    const at = offset + size * i, kind = bytes.readUInt32LE(at);
    if (kind === 3) return false; // PT_INTERP: an opaque loader is not proven available.
    if (kind !== 2) continue; // PT_DYNAMIC is allowed only for known static PIE.
    if (dynamic || type !== 3) return false;
    dynamic = true;
    const begin = Number(bytes.readBigUInt64LE(at + 8)), length = Number(bytes.readBigUInt64LE(at + 32));
    if (!Number.isSafeInteger(begin) || !Number.isSafeInteger(length) || !length || length % 16 || length > 65536 || begin + length > bytes.length) return false;
    let terminated = false;
    for (let entry = begin; entry < begin + length; entry += 16) {
      const tag = bytes.readBigUInt64LE(entry), value = bytes.readBigUInt64LE(entry + 8);
      if (tag === 0n) { terminated = true; break; }
      // DT_NEEDED/RPATH/RUNPATH/AUDIT/DEPAUDIT/AUXILIARY/FILTER imply
      // external loader inputs, even if the file omits PT_INTERP.
      if ([1n, 15n, 29n, 0x6ffffefbn, 0x6ffffefcn, 0x7ffffffdn, 0x7fffffffn].includes(tag)) return false;
      if (tag === 0x6ffffffbn && (value & 0x08000000n)) pie = true; // DF_1_PIE
    }
    if (!terminated) return false;
  }
  return type === 2 ? !dynamic : dynamic && pie;
}
/** No repository executable, script or opaque loader ever runs on the server. */
export async function rewriteWorkerRtk(worker: LaunchedWorker | undefined, command: string): Promise<string> {
  const view = worker && views.get(worker);
  if (!view?.alive || view.input.restricted) return command;
  try {
    if (!view.start || start(view.pid) !== view.start) return command;
    // bubblewrap's namespace init may supervise the actual command. Only its
    // sole kernel-reported child qualifies; never accept a worker-supplied PID.
    if (!view.execution) {
      let pid = view.pid;
      const name = readFileSync(`/proc/${pid}/comm`, "utf8").trim();
      if (name === "bwrap") {
        const children = readFileSync(`/proc/${pid}/task/${pid}/children`, "utf8").trim().split(/\s+/).filter(Boolean);
        if (children.length !== 1) return command;
        pid = Number(children[0]);
      }
      view.execution = { pid, start: start(pid) };
    }
    if (start(view.execution.pid) !== view.execution.start) return command;
    const proc = `/proc/${view.execution.pid}`, status = readFileSync(`${proc}/status`, "utf8");
    const uid = /^Uid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
    const gid = /^Gid:\s+(\d+)\s+(\d+)\s+(\d+)\s+(\d+)/m.exec(status);
    if (!uid || !gid || uid.slice(1).some(id => Number(id) !== process.geteuid!()) || gid.slice(1).some(id => Number(id) !== process.getegid!())) return command;
    const groups = /^Groups:\s*(.*)$/m.exec(status)?.[1]?.trim().split(/\s+/).filter(Boolean).map(Number).sort((a,b)=>a-b);
    if (JSON.stringify(groups) !== JSON.stringify(process.getgroups!().sort((a,b)=>a-b))) return command;
    const env = Object.fromEntries(readFileSync(`${proc}/environ`, "utf8").split("\0").filter(Boolean).map(entry => { const at = entry.indexOf("="); return [entry.slice(0, at), entry.slice(at + 1)]; }));
    if (!env.PATH || env.PATH !== view.input.env.PATH) return command;
    const excluded = [view.input.brainPath, view.input.env.HOME, "/tmp", "/run", "/var/run", "/var/lib", "/home", "/root", "/mnt", "/media", "/srv", ...(view.input.sandbox?.maskPaths ?? []), ...(view.input.sandbox?.areas.flatMap(area => area.mount.writable ? [area.mount.path] : []) ?? [])].filter((path): path is string => Boolean(path));
    for (const directory of env.PATH.split(":")) {
      // A relative/empty preceding PATH entry makes resolution cwd-dependent.
      if (!isAbsolute(directory)) return command;
      const candidate = resolve(directory, "rtk"), visible = `${proc}/root${candidate}`;
      let info;
      try { info = statSync(visible); accessSync(visible, constants.X_OK); }
      catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) continue; return command; }
      if (!info.isFile()) return command;
      const binary = realpathSync(candidate);
      // Only an unaliased system installation outside worker-owned roots qualifies.
      if (!["/usr/bin", "/usr/local/bin", "/bin"].some(root => within(root, binary)) || excluded.some(root => within(resolve(root), candidate) || within(resolve(root), binary))) return command;
      // Every ancestor is a protected installation directory; an agent-owned
      // parent must not substitute the executable between observation and exec.
      for (let parent = dirname(binary);; parent = dirname(parent)) {
        const info = statSync(parent);
        if (![0, process.geteuid!()].includes(info.uid) || (info.mode & 0o022)) return command;
        if (parent === "/") break;
      }
      const mounts = readFileSync(`${proc}/mountinfo`, "utf8").trim().split("\n").map(line => {
        const fields = line.split(" ");
        const path = fields[4]!.replace(/\\([0-7]{3})/g, (_match, octal: string) => String.fromCharCode(parseInt(octal, 8)));
        return { path, options: fields[5]!.split(",") };
      }).filter(mount => mount.path === "/" || within(mount.path, binary)).sort((a,b) => b.path.length - a.path.length);
      if (!mounts[0]?.options.includes("ro") || mounts[0]?.options.includes("noexec")) return command;
      const host = statSync(binary);
      if (host.dev !== info.dev || host.ino !== info.ino || ![0, process.geteuid!()].includes(host.uid) || host.nlink !== 1 || (host.mode & 0o6022) || host.size > 32 * 1024 * 1024 || !isStaticNativeElf(binary)) return command;
      // No PID reuse or exit between observation and oracle admission.
      if (!view.alive || start(view.pid) !== view.start) return command;
      const rewritten = await rewriteInstalledRtk(command, binary);
      return view.alive && start(view.pid) === view.start && start(view.execution.pid) === view.execution.start ? rewritten : command;
    }
  } catch { /* Missing/unknown worker visibility always preserves the command. */ }
  return command;
}
