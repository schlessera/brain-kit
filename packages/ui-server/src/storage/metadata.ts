/** Host-owned metadata worker. Exact configured roots only; never reads file contents. */
import { constants, openSync, closeSync, fstatSync, readFileSync, statfsSync, type BigIntStats } from "node:fs";
import { opendir } from "node:fs/promises";
import { resolve } from "node:path";
const O_PATH = 1 << 21;
const fdPath = (fd: number, name = "") => `/proc/self/fd/${fd}${name ? `/${name}` : ""}`;
const safe = (n: bigint) => n >= 0n && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
export interface MetadataRoot { id: string; path: string; recursive: boolean; optional?: boolean }
export interface MetadataEntry {
  rootId: string; path: string; kind: "file" | "directory" | "symlink" | "special";
  object: string; version: string; device: string; logical: number | null; allocated: number | null; links: number;
}
export interface MetadataCapacity {
  rootId: string; device: string; filesystem: string; identity: string | null;
  total: number | null; used: number | null; free: number | null; available: number | null; reason: string | null;
}
export interface MetadataResult { entries: MetadataEntry[]; capacities: MetadataCapacity[]; errors: { rootId: string; reason: string }[]; omittedErrors: number }
function openConfigured(path: string): number {
  const pieces = resolve(path).split("/").filter(Boolean);
  let fd = openSync("/", O_PATH | constants.O_DIRECTORY);
  try {
    for (let i = 0; i < pieces.length; i++) {
      const next = openSync(fdPath(fd, pieces[i]), O_PATH | constants.O_NOFOLLOW | (i < pieces.length - 1 ? constants.O_DIRECTORY : 0));
      closeSync(fd); fd = next;
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
const mount = (fd: number) => {
  const id = /^mnt_id:\s*(\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"))?.[1];
  if (!id) throw Error("identity-unavailable");
  return id;
};
/** GNU stat reads filesystem identity through our already-held descriptor. No path selected by a request. */
async function filesystemIdentity(fd: number): Promise<string | null> {
  const child = Bun.spawn(["/usr/bin/stat", "-f", "--format=%i", `/proc/${process.pid}/fd/${fd}`], { stdin: "ignore", stdout: "pipe", stderr: "ignore", env: { PATH: "/usr/bin:/bin", LC_ALL: "C" } });
  const timer = setTimeout(() => child.kill("SIGKILL"), 1000);
  try {
    let bytes = 0, output = "";
    for await (const part of child.stdout) { bytes += part.length; if (bytes > 128) { child.kill("SIGKILL"); break; } output += new TextDecoder().decode(part); }
    return await child.exited === 0 && /^[0-9a-f]{1,32}\n$/i.test(output) && !/^0+\n$/.test(output) ? output.trim().toLowerCase() : null;
  } finally { clearTimeout(timer); child.kill("SIGKILL"); await child.exited; }
}
export async function collectMetadata(roots: MetadataRoot[], options: { signal?: AbortSignal; entries?: number; milliseconds?: number } = {}): Promise<MetadataResult> {
  const result: MetadataResult = { entries: [], capacities: [], errors: [], omittedErrors: 0 };
  const limit = Math.min(100_000, options.entries ?? 100_000), deadline = performance.now() + Math.min(30_000, options.milliseconds ?? 30_000);
  let visited = 0, payloadBytes = 0;
  const fail = (rootId: string, reason: string) => { if (result.errors.length < 100) result.errors.push({ rootId, reason }); else result.omittedErrors++; };
  const stop = () => options.signal?.aborted || performance.now() >= deadline || visited >= limit || payloadBytes >= 32 * 1024 * 1024;
  if (process.platform !== "linux") { for (const root of roots) fail(root.id, "unsupported-platform"); return result; }
  for (const root of roots.slice(0, 32)) {
    if (stop()) { fail(root.id, options.signal?.aborted ? "cancelled" : visited >= limit ? "entry-budget" : payloadBytes >= 32 * 1024 * 1024 ? "output-budget" : "time-budget"); continue; }
    let rootFd: number | undefined;
    try {
      // Server roots and exact sidecars never follow path-component redirects.
      const canonical = resolve(root.path);
      rootFd = openConfigured(canonical);
      const first = fstatSync(rootFd, { bigint: true }), mountId = mount(rootFd);
      if (first.isSymbolicLink() || (!first.isFile() && !first.isDirectory())) { fail(root.id, "unsupported-root"); continue; }
      const fs = statfsSync(fdPath(rootFd), { bigint: true }), unsupported = fs.type === 0x794c7630n;
      let identity: string | null = null;
      try { identity = unsupported ? null : await filesystemIdentity(rootFd); } catch { /* explicit unknown relationship */ }
      result.capacities.push({ rootId: root.id, device: String(first.dev), filesystem: String(fs.type), identity,
        total: unsupported ? null : safe(fs.blocks * fs.bsize), used: unsupported ? null : safe((fs.blocks - fs.bfree) * fs.bsize), free: unsupported ? null : safe(fs.bfree * fs.bsize), available: unsupported ? null : safe(fs.bavail * fs.bsize), reason: unsupported ? "overlay-capacity-unknown" : identity ? null : "capacity-identity-unknown" });
      const visit = async (fd: number, path: string, depth: number, info: BigIntStats): Promise<void> => {
        if (stop()) { fail(root.id, options.signal?.aborted ? "cancelled" : visited >= limit ? "entry-budget" : payloadBytes >= 32 * 1024 * 1024 ? "output-budget" : "time-budget"); return; }
        visited++;
        if (mount(fd) !== mountId) { fail(root.id, "mount-boundary"); return; }
        const entry: MetadataEntry = { rootId: root.id, path, kind: info.isFile() ? "file" : info.isDirectory() ? "directory" : info.isSymbolicLink() ? "symlink" : "special",
          object: `${info.dev}:${info.ino}`, version: `${info.dev}:${info.ino}:${info.mode}:${info.size}:${info.mtimeNs}:${info.ctimeNs}:${info.nlink}`, device: String(info.dev), logical: info.isFile() ? safe(info.size) : 0,
          allocated: safe(info.blocks * 512n), links: Number(info.nlink) };
        payloadBytes += Buffer.byteLength(JSON.stringify(entry));
        if (payloadBytes >= 32 * 1024 * 1024) { fail(root.id, "output-budget"); return; }
        result.entries.push(entry);
        if (!info.isDirectory() || !root.recursive) return;
        if (depth >= 64) { fail(root.id, "depth-budget"); return; }
        const directory = await opendir(fdPath(fd), { bufferSize: 32 });
        try {
          for await (const entry of directory) {
            if (stop()) { fail(root.id, options.signal?.aborted ? "cancelled" : visited >= limit ? "entry-budget" : payloadBytes >= 32 * 1024 * 1024 ? "output-budget" : "time-budget"); break; }
            let child: number | undefined;
            try { child = openSync(fdPath(fd, entry.name), O_PATH | constants.O_NOFOLLOW); await visit(child, path ? `${path}/${entry.name}` : entry.name, depth + 1, fstatSync(child, { bigint: true })); }
            catch { visited++; fail(root.id, "entry-unavailable"); }
            finally { if (child !== undefined) closeSync(child); }
            if (visited % 32 === 0) await new Promise<void>(done => setTimeout(done, 0));
          }
        } finally { try { await directory.close(); } catch { /* async iterator already closed */ } }
      };
      await visit(rootFd, "", 0, first);
      const finalFd = openConfigured(canonical);
      try { const final = fstatSync(finalFd, { bigint: true }); if (final.dev !== first.dev || final.ino !== first.ino || mount(finalFd) !== mountId) fail(root.id, "root-changed"); }
      finally { closeSync(finalFd); }
    } catch (error) { if (!root.optional || (error as NodeJS.ErrnoException).code !== "ENOENT") fail(root.id, "root-unavailable"); }
    finally { if (rootFd !== undefined) closeSync(rootFd); }
  }
  if (roots.length > 32) fail("", "root-budget");
  return result;
}
