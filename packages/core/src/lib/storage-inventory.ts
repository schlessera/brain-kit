import { inheritedEnv } from "../config/env.js";
import { constants, fstatSync, openSync, closeSync, readFileSync, readSync, realpathSync, statfsSync, type BigIntStats } from "node:fs";
import { opendir } from "node:fs/promises";
import { resolve, relative, isAbsolute, sep } from "node:path";
import { createHash, randomUUID } from "node:crypto";

// Linux O_PATH obtains metadata without opening FIFO/device endpoints or reading bytes.
const PATH = 1 << 21;
const at = (fd: number, name = "") => `/proc/self/fd/${fd}${name ? `/${name}` : ""}`;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
interface StorageLimits { entries: number; depth: number; milliseconds: number; errors: number; page: number; freshness: number; gitBytes: number }
export const STORAGE_LIMITS: Readonly<StorageLimits> = Object.freeze({ entries: 100_000, depth: 64, milliseconds: 30_000, errors: 100, page: 200, freshness: 60_000, gitBytes: 65_536 });
export type StorageKind = "file" | "directory" | "symlink" | "special";
export interface StorageEntry {
  id: string; parentId: string | null; rootId: string; path: string; name: string; kind: StorageKind;
  objectId: string; capacityId: string; logicalBytes: number | null; allocatedBytes: number | null;
  measurementReason: string | null; version: string; links: number; pdfOver5MB: boolean;
  aliasOf: string | null;
}
export interface StorageCapacity {
  id: string; device: string; mountId: string; filesystemType: string;
  totalBytes: number | null; usedBytes: number | null; freeBytes: number | null; availableBytes: number | null;
  reason: string | null; provenance: "statfs"; quota: null; quotaReason: "unsupported";
}
export interface StorageInventory {
  schema_version: 1; scanId: string; revision: string; startedAt: string; finishedAt: string; expiresAt: string;
  status: "complete" | "partial" | "unsupported"; consistency: "live-observation";
  allocationBasis: "512 * st_blocks; shared extents may be charged more than once";
  roots: { id: string; kind: "brain" | "git"; path: string }[];
  entries: StorageEntry[]; capacities: StorageCapacity[];
  pages: { cursor: string; parentId: string | null; entryIds: string[]; nextCursor: string | null }[];
  totals: { entryLogicalBytes: number | null; objectLogicalBytes: number | null; objectAllocatedBytes: number | null; objects: number; entries: number; lowerBound: boolean };
  errors: { path: string; reason: string }[]; omittedErrors: number;
  limits: typeof STORAGE_LIMITS;
}
interface Options {
  /** Internal host-reader mode: Git administrative metadata only, no executable. */
  metadataGit?: boolean;
  signal?: AbortSignal;
  /** Trusted host configuration only; never a request parameter. */
  gitRoots?: readonly string[];
  /** Smaller limits for callers/tests; cannot raise production bounds. */
  limits?: Partial<Pick<typeof STORAGE_LIMITS, "entries" | "depth" | "milliseconds" | "errors">>;
}
const safeNumber = (n: bigint): number | null => n >= 0n && n <= BigInt(Number.MAX_SAFE_INTEGER) ? Number(n) : null;
const objectKey = (s: BigIntStats) => `${s.dev}:${s.ino}`;
const version = (s: BigIntStats) => `${s.dev}:${s.ino}:${s.mode}:${s.size}:${s.mtimeNs}:${s.ctimeNs}:${s.nlink}`;
function mountId(fd: number): string {
  const match = /^mnt_id:\s*(\d+)$/m.exec(readFileSync(`/proc/self/fdinfo/${fd}`, "utf8"));
  if (!match) throw new Error("mount-identity-unavailable");
  return match[1];
}
/** Resolve every component without following symlinks, including ancestors of a configured root. */
function openRoot(path: string): number {
  let fd = openSync("/", PATH | constants.O_DIRECTORY);
  try {
    for (const name of resolve(path).split(sep).filter(Boolean)) {
      const next = openSync(at(fd, name), PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
      closeSync(fd); fd = next;
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`)); };

/** Read only Git's fixed location markers through held, non-followed descriptors.
 * Config/includes, hooks, filters, helpers and object contents are never evaluated. */
function metadataGitPaths(root: string, allowed: readonly string[]): { path: string; objects: boolean }[] {
  const approved = (path: string) => inside(root, path) || allowed.some(value => inside(value, path));
  const text = (fd: number, parent: number): string => {
    const stat = fstatSync(fd, { bigint: true });
    if (!stat.isFile() || mountId(fd) !== mountId(parent) || stat.size > BigInt(STORAGE_LIMITS.gitBytes)) throw Error("git-metadata-unsupported");
    const file = openSync(at(fd), constants.O_RDONLY | constants.O_NONBLOCK);
    try {
      const buffer = Buffer.alloc(STORAGE_LIMITS.gitBytes + 1), size = readSync(file, buffer, 0, buffer.length, 0);
      if (size > STORAGE_LIMITS.gitBytes || version(fstatSync(file, { bigint: true })) !== version(stat)) throw Error("git-metadata-changed-or-over-budget");
      const value = buffer.subarray(0, size).toString("utf8").replace(/\n$/, "");
      if (!value || /[\r\n\0\ufffd]/.test(value)) throw Error("git-path-encoding-unsupported");
      return value;
    } finally { closeSync(file); }
  };
  let brain: number | undefined, marker: number | undefined, git: number | undefined, commonMarker: number | undefined;
  try {
    brain = openRoot(root);
    try { marker = openSync(at(brain, ".git"), PATH | constants.O_NOFOLLOW); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return []; throw error; }
    const stat = fstatSync(marker, { bigint: true });
    let gitDir = resolve(root, ".git");
    if (mountId(marker) !== mountId(brain)) throw Error("mount-boundary");
    if (!stat.isDirectory()) {
      const value = text(marker, brain);
      if (!value.startsWith("gitdir: ")) throw Error("git-location-marker-unsupported");
      gitDir = resolve(root, value.slice(8));
    }
    if (!approved(gitDir)) throw Error("external-git-root-not-approved");
    git = openRoot(gitDir);
    let common = gitDir;
    try {
      commonMarker = openSync(at(git, "commondir"), PATH | constants.O_NOFOLLOW);
      common = resolve(gitDir, text(commonMarker, git));
    } catch (error) { if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error; }
    if (!approved(common)) throw Error("external-git-root-not-approved");
    const objects = resolve(common, "objects");
    return [...new Set([gitDir, common, objects])].sort(compare).map(path => ({ path, objects: path === objects }));
  } finally {
    for (const fd of [commonMarker, git, marker, brain]) if (fd !== undefined) closeSync(fd);
  }
}

/** Bounded output and lifetime; every cancellation kills and awaits the child. No shell, hooks, filters or maintenance. */
async function gitPaths(root: string, signal: AbortSignal, deadline: number): Promise<{ path: string; objects: boolean }[]> {
  const env = Object.fromEntries(Object.entries(inheritedEnv({})).filter(([key]) => !key.startsWith("GIT_")));
  Object.assign(env, { GIT_OPTIONAL_LOCKS: "0", GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0" });
  const run = async (args: string[]) => {
    signal.throwIfAborted();
    const child = Bun.spawn(["git", "-c", "core.hooksPath=/dev/null", "-c", "maintenance.auto=false", "-c", "gc.auto=0", "-C", root, ...args], { env, stdin: "ignore", stdout: "pipe", stderr: "pipe" });
    let stopped = false;
    const stop = () => { stopped = true; child.kill("SIGKILL"); };
    signal.addEventListener("abort", stop, { once: true });
    const timer = setTimeout(stop, Math.max(1, deadline - performance.now()));
    let bytes = 0;
    const read = async (stream: ReadableStream<Uint8Array>) => {
      const chunks: Uint8Array[] = [];
      for await (const chunk of stream) {
        bytes += chunk.byteLength;
        if (bytes > STORAGE_LIMITS.gitBytes) { stop(); continue; }
        chunks.push(chunk);
      }
      return Buffer.concat(chunks).toString("utf8");
    };
    try {
      const [out, err, code] = await Promise.all([read(child.stdout), read(child.stderr), child.exited]);
      if (stopped) throw new Error(signal.aborted ? "cancelled" : "git-budget");
      if (code !== 0) {
        if (err.includes("not a git repository")) return null;
        throw new Error("git-resolution-failed");
      }
      return out.trimEnd();
    } finally { clearTimeout(timer); signal.removeEventListener("abort", stop); child.kill("SIGKILL"); await child.exited; }
  };
  const dirs = await run(["rev-parse", "--path-format=absolute", "--git-dir", "--git-common-dir", "--git-path", "objects"]);
  if (dirs === null) return [];
  const paths = dirs.split("\n");
  if (paths.length !== 3 || paths.some(path => !isAbsolute(path) || /[\r\n\0]/.test(path))) throw new Error("git-path-encoding-unsupported");
  const objects = resolve(paths[2]);
  return [...new Set(paths.map(path => resolve(path)))].sort(compare).map(path => ({ path, objects: path === objects }));
}

export async function collectStorageInventory(rootPath: string, options: Options = {}): Promise<StorageInventory> {
  const started = new Date(), startedClock = performance.now();
  // Host-selected root aliases are resolved once; traversal below them never follows links.
  const canonical = (path: string) => { try { return realpathSync(path); } catch { return resolve(path); } };
  const root = options.signal?.aborted ? resolve(rootPath) : canonical(rootPath);
  const allowedGitRoots = options.signal?.aborted ? [] : (options.gitRoots ?? []).map(canonical);
  const limits = { ...STORAGE_LIMITS };
  for (const key of ["entries", "depth", "milliseconds", "errors"] as const) {
    const value = options.limits?.[key];
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < 1 || value > STORAGE_LIMITS[key]) throw new Error(`Invalid ${key} limit`);
      limits[key] = value;
    }
  }
  const result: StorageInventory = {
    schema_version: 1, scanId: randomUUID(), revision: "", startedAt: started.toISOString(), finishedAt: "", expiresAt: "",
    status: "complete", consistency: "live-observation", allocationBasis: "512 * st_blocks; shared extents may be charged more than once",
    roots: [], entries: [], capacities: [], pages: [], totals: { entryLogicalBytes: 0, objectLogicalBytes: 0, objectAllocatedBytes: 0, objects: 0, entries: 0, lowerBound: false }, errors: [], omittedErrors: 0, limits,
  };
  const fail = (path: string, reason: string) => {
    if (result.status !== "unsupported") result.status = "partial";
    if (result.errors.length < limits.errors) result.errors.push({ path, reason }); else result.omittedErrors++;
  };
  const signal = options.signal ?? new AbortController().signal;
  const deadline = startedClock + limits.milliseconds;
  let halted = false;
  let visited = 0;
  const stop = () => {
    if (halted) return true;
    const reason = signal.aborted ? "cancelled" : performance.now() >= deadline ? "time-budget" : visited >= limits.entries ? "entry-budget" : null;
    if (reason) { fail("", reason); halted = true; }
    return halted;
  };
  let entryLogical = 0n, objectLogical = 0n, objectAllocated = 0n;
  const observedEntries = new Map<string, StorageEntry>();
  const seenObjects = new Set<string>(), seenDirectories = new Map<string, string>();
  const recordCapacity = (fd: number, s: BigIntStats, mount: string): string => {
    // Mount identity is explicit. Consumers must not sum capacity observations;
    // bind mounts can expose the same device with different quota visibility.
    const id = `mount:${mount}:device:${s.dev}`;
    if (!result.capacities.some(capacity => capacity.id === id)) {
      const capacity: StorageCapacity = { id, device: String(s.dev), mountId: mount, filesystemType: "unknown", totalBytes: null, usedBytes: null, freeBytes: null, availableBytes: null, reason: null, provenance: "statfs", quota: null, quotaReason: "unsupported" };
      try {
        const fs = statfsSync(at(fd), { bigint: true });
        capacity.filesystemType = `0x${fs.type.toString(16)}`;
        if (fs.type === 0x794c7630n) capacity.reason = "overlay-capacity-not-attributable";
        else {
          capacity.totalBytes = safeNumber(fs.blocks * fs.bsize); capacity.usedBytes = safeNumber((fs.blocks - fs.bfree) * fs.bsize);
          capacity.freeBytes = safeNumber(fs.bfree * fs.bsize); capacity.availableBytes = safeNumber(fs.bavail * fs.bsize);
          if ([capacity.totalBytes, capacity.usedBytes, capacity.freeBytes, capacity.availableBytes].includes(null)) capacity.reason = "unsafe-integer";
        }
      } catch { capacity.reason = "statfs-unavailable"; }
      result.capacities.push(capacity);
    }
    return id;
  };
  const walk = async (fd: number, path: string, parentId: string | null, rootId: string, mount: string, depth: number): Promise<void> => {
    if (stop()) return;
    visited++;
    const before = fstatSync(fd, { bigint: true });
    if (mountId(fd) !== mount) { fail(path, "mount-boundary"); return; }
    const kind: StorageKind = before.isFile() ? "file" : before.isDirectory() ? "directory" : before.isSymbolicLink() ? "symlink" : "special";
    const id = `${rootId}:${path}`, objectId = objectKey(before);
    const entry: StorageEntry = { id, parentId, rootId, path, name: path.split("/").at(-1) || rootId, kind,
      objectId, capacityId: recordCapacity(fd, before, mount), logicalBytes: kind === "file" ? safeNumber(before.size) : null,
      allocatedBytes: safeNumber(before.blocks * 512n), measurementReason: null, version: version(before), links: Number(before.nlink), pdfOver5MB: kind === "file" && /\.pdf$/i.test(path) && before.size > 5_000_000n, aliasOf: seenDirectories.get(objectId) ?? null };
    if (entry.allocatedBytes === null || (kind === "file" && entry.logicalBytes === null)) { entry.measurementReason = "unsafe-integer"; fail(path, "unsafe-integer"); }
    result.entries.push(entry); observedEntries.set(id, entry);
    entryLogical += kind === "file" ? before.size : 0n;
    if (!seenObjects.has(objectId)) {
      seenObjects.add(objectId); objectLogical += kind === "file" ? before.size : 0n; objectAllocated += before.blocks * 512n;
    }
    if (kind === "special") { entry.measurementReason = "special-file-not-opened"; return; }
    if (version(fstatSync(fd, { bigint: true })) !== entry.version) fail(path, "changed-during-scan");
    if (kind !== "directory" || entry.aliasOf) return;
    seenDirectories.set(objectId, id);
    if (depth >= limits.depth) { fail(path, "depth-budget"); return; }
    let directory;
    try {
      directory = await opendir(at(fd), { bufferSize: 32 });
      for await (const child of directory) {
        if (stop()) break;
        const childPath = path ? `${path}/${child.name}` : child.name;
        if (child.name.includes("\ufffd")) { fail(childPath, "filename-encoding-unsupported"); continue; }
        let childFd: number | undefined;
        try {
          childFd = openSync(at(fd, child.name), PATH | constants.O_NOFOLLOW);
          await walk(childFd, childPath, id, rootId, mount, depth + 1);
          // The name must still refer to the observed object before emission.
          const check = openSync(at(fd, child.name), PATH | constants.O_NOFOLLOW);
          try { const observed = observedEntries.get(`${rootId}:${childPath}`); if (observed && version(fstatSync(check, { bigint: true })) !== observed.version) fail(childPath, "changed-during-scan"); }
          finally { closeSync(check); }
        } catch (error) { visited++; fail(childPath, (error as NodeJS.ErrnoException).code ?? "metadata-unavailable"); }
        finally { if (childFd !== undefined) closeSync(childFd); }
        // Yield for cancellation even in a large flat directory.
        if (result.entries.length % 32 === 0) await new Promise<void>(resolve => setImmediate(resolve));
      }
    } catch (error) { fail(path, (error as NodeJS.ErrnoException).code ?? "directory-unavailable"); }
    if (version(fstatSync(fd, { bigint: true })) !== version(before)) fail(path, "changed-during-scan");
  };
  if (process.platform !== "linux") { result.status = "unsupported"; fail("", "linux-descriptor-metadata-required"); }
  else {
    const roots: { path: string; kind: "brain" | "git" }[] = [{ path: root, kind: "brain" }];
    if (!stop()) {
      try {
        const paths = options.metadataGit ? metadataGitPaths(root, allowedGitRoots) : await gitPaths(root, signal, deadline);
        const inspected = new Set<string>();
        // Only read alternate metadata after approving and opening its object
        // directory. `git count-objects` would traverse unapproved alternates.
        for (let index = 0; index < paths.length; index++) {
          if (stop()) break;
          if (index >= 64) { fail("git", "git-root-budget"); break; }
          const candidate = paths[index];
          const path = options.metadataGit ? resolve(candidate.path) : canonical(candidate.path);
          const resolutionId = `${candidate.objects ? "objects" : "store"}:${path}`;
          if (inspected.has(resolutionId)) continue;
          inspected.add(resolutionId);
          if (!inside(root, path) && !allowedGitRoots.some(allowed => inside(allowed, path))) { fail("git", "external-git-root-not-approved"); continue; }
          if (!roots.some(other => inside(other.path, path))) roots.push({ path, kind: "git" });
          if (!candidate.objects) continue;
          let directory: number | undefined, info: number | undefined, metadata: number | undefined, file: number | undefined;
          try {
            directory = openRoot(path);
            // Only resolved object directories give info/alternates meaning.
            info = openSync(at(directory, "info"), PATH | constants.O_DIRECTORY | constants.O_NOFOLLOW);
            if (mountId(info) !== mountId(directory)) throw new Error("mount-boundary");
            metadata = openSync(at(info, "alternates"), PATH | constants.O_NOFOLLOW);
            const stat = fstatSync(metadata, { bigint: true });
            if (!stat.isFile() || mountId(metadata) !== mountId(info) || stat.size > BigInt(STORAGE_LIMITS.gitBytes)) throw new Error("alternate-metadata-unsupported");
            file = openSync(at(metadata), constants.O_RDONLY | constants.O_NONBLOCK);
            const buffer = Buffer.alloc(STORAGE_LIMITS.gitBytes + 1);
            const length = readSync(file, buffer, 0, buffer.length, 0);
            if (length > STORAGE_LIMITS.gitBytes) throw new Error("git-budget");
            for (const line of buffer.subarray(0, length).toString("utf8").split("\n").filter(Boolean)) {
              // C-quoted paths need byte decoding, not JSON decoding. Refuse
              // unsupported encoding visibly rather than scan a wrong root.
              if (line.startsWith('"') || /[\r\0\ufffd]/.test(line)) { fail("git", "alternate-path-encoding-unsupported"); continue; }
              paths.push({ path: resolve(path, line), objects: true });
            }
            if (version(fstatSync(file, { bigint: true })) !== version(stat)) fail("git", "changed-during-scan");
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") fail("git", (error as NodeJS.ErrnoException).code ?? (error as Error).message);
          } finally { if (file !== undefined) closeSync(file); if (metadata !== undefined) closeSync(metadata); if (info !== undefined) closeSync(info); if (directory !== undefined) closeSync(directory); }
        }
      } catch (error) { fail("git", signal.aborted ? "cancelled" : (error as Error).message); }
    }
    for (const [index, configured] of roots.entries()) {
      if (stop()) break;
      const id = configured.kind === "brain" ? "brain" : `git-${index}`;
      result.roots.push({ id, ...configured });
      let fd: number | undefined;
      try {
        fd = openRoot(configured.path);
        await walk(fd, "", null, id, mountId(fd), 0);
        const check = openRoot(configured.path);
        try { if (objectKey(fstatSync(check, { bigint: true })) !== objectKey(fstatSync(fd, { bigint: true })) || mountId(check) !== mountId(fd)) fail(id, "changed-during-scan"); }
        finally { closeSync(check); }
      }
      catch (error) { fail(id, (error as NodeJS.ErrnoException).code ?? "root-unavailable"); }
      finally { if (fd !== undefined) closeSync(fd); }
    }
  }
  result.entries.sort((a, b) => compare(a.id, b.id));
  const digest = createHash("sha256");
  for (const entry of result.entries) digest.update(JSON.stringify(entry));
  digest.update(JSON.stringify(result.errors)); digest.update(String(result.omittedErrors));
  result.revision = digest.digest("hex");
  const groups = new Map<string | null, string[]>();
  for (const entry of result.entries) { const group = groups.get(entry.parentId) ?? []; group.push(entry.id); groups.set(entry.parentId, group); }
  for (const [parentId, ids] of groups) for (let offset = 0; offset < ids.length; offset += limits.page) {
    const cursor = (start: number) => Buffer.from(JSON.stringify([result.scanId, parentId, start])).toString("base64url");
    result.pages.push({ cursor: cursor(offset), parentId, entryIds: ids.slice(offset, offset + limits.page), nextCursor: offset + limits.page < ids.length ? cursor(offset + limits.page) : null });
  }
  result.totals.entries = result.entries.length; result.totals.objects = seenObjects.size; result.totals.lowerBound = result.status !== "complete";
  result.totals.entryLogicalBytes = safeNumber(entryLogical); result.totals.objectLogicalBytes = safeNumber(objectLogical); result.totals.objectAllocatedBytes = safeNumber(objectAllocated);
  if ([result.totals.entryLogicalBytes, result.totals.objectLogicalBytes, result.totals.objectAllocatedBytes].includes(null)) { fail("", "total-unsafe-integer"); result.totals.lowerBound = true; }
  result.finishedAt = new Date().toISOString(); result.expiresAt = new Date(Date.now() + limits.freshness).toISOString();
  return result;
}
