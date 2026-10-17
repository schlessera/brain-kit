/** Changed-only publication from a root-inspected trusted OverlayFS stage. */
import { closeSync, constants, fstatSync, fchmodSync, lstatSync, linkSync, mkdirSync, openSync, readdirSync, readlinkSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
import { open } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { hostOutputStagingLimits } from "./worker-state-limits.js";
import { WorkerStateError, processStateLedger } from "./worker-state-budget.js";
import { nativeWorkerStartupInput, retainWorkerStartupView, type WorkerStartupView } from "./worker-startup-view.js";
import { isEnvName, PROTECTED_TIER_A } from "./protected-paths.js";
import { FIRST_PARTY_FAILURE_CLASSES } from "../protocol.js";
import type { KeyedLock } from "./keyed-lock.js";
import { NativeBrainManagerError, type NativeStage } from "./native-brain-manager-protocol.js";
import { workerCleanupUnconfirmed, workerIdentityHelper } from "./worker-identity.js";

export interface WorkerOutputStorage {
  readonly root: string; readonly mount: string; readonly namespacePid: number; readonly allowanceBytes: number;
  /** Root-manager-created sealed metadata authority; never inherited by the payload. */
  readonly identityTicketFd?: number;
  readonly namespaceStart?: string;
  retain(): void; release(): void | Promise<void>;
}
export interface PreparedWorkerOutput {
  /** Exactly one owned checkpoint reference. Consumed by launchAgentWorker. */
  readonly view: WorkerStartupView;
  readonly output: { source: string; storage: WorkerOutputStorage };
  publish(): Promise<void>;
  publishLocked(lock: KeyedLock): Promise<void>;
  /** Await stage deletion, then release the owned checkpoint reference. Idempotent. */
  cleanup(): Promise<void>;
}
const executionDrain = new WeakMap<PreparedWorkerOutput, { exited?: Promise<void> }>();
/** Launcher-only ownership transfer: even a post-spawn failure must drain the child before deletion. */
export function bindPreparedWorkerOutputExit(output: PreparedWorkerOutput, exited: Promise<unknown>): void {
  const state = executionDrain.get(output);
  if (state) {
    state.exited = exited.then(() => {}, error => { if (workerCleanupUnconfirmed(error)) throw error; });
    // Preserve the failure for publication/cleanup without an unhandled
    // rejection while the backend drains its other owned streams first.
    void state.exited.catch(() => {});
  }
}
const DIRECTORY = constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW;
const FILE = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK;
const at = (fd: number, name: string) => `/proc/self/fd/${fd}/${name}`;
type Entry = { type: "file" | "directory" | "symlink"; mode: number; hash?: string; link?: string; members?: string[] };
type Captured = { entry: Entry | undefined; stamp: string | undefined };
const equal = (a: Entry | undefined, b: Entry | undefined, members = false) => JSON.stringify(a?.type === "directory" && !members ? { ...a, members: undefined } : a)
  === JSON.stringify(b?.type === "directory" && !members ? { ...b, members: undefined } : b);
function stamp(info: import("node:fs").BigIntStats) { return [info.dev, info.ino, info.mode, info.size, info.mtimeNs, info.ctimeNs].join(":"); }
function parent(root: string, rel: string) {
  const parts = rel.split("/");
  if (parts.some(p => !p || p === "." || p === ".." || p.includes("\u0000"))) throw Error("Invalid native output path");
  let fd = openSync(root, DIRECTORY);
  try { for (const part of parts.slice(0, -1)) { const child = openSync(at(fd, part), DIRECTORY); closeSync(fd); fd = child; } return { fd, name: parts.at(-1)! }; }
  catch (error) { closeSync(fd); throw error; }
}
/** New-directory children prepare in their nearest existing no-follow ancestor. */
function preparationDirectory(root: string, rel: string): number {
  let fd = openSync(root, DIRECTORY);
  try {
    for (const part of rel.split("/").slice(0,-1)) {
      let next: number;
      try { next = openSync(at(fd,part), DIRECTORY); }
      catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return fd; throw error; }
      closeSync(fd); fd = next;
    }
    return fd;
  } catch (error) { closeSync(fd); throw error; }
}
function absent(error: unknown) { return ["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? ""); }
async function inspect(root: string, rel: string, members = false): Promise<Captured> {
  let handle: ReturnType<typeof parent>;
  try { handle = parent(root, rel); } catch (error) { if (absent(error)) return { entry: undefined, stamp: undefined }; throw error; }
  try {
    const path = at(handle.fd, handle.name), info = lstatSync(path, { bigint: true, throwIfNoEntry: false });
    if (!info) return { entry: undefined, stamp: undefined };
    const version = stamp(info), mode = Number(info.mode & 0o777n);
    if (info.isSymbolicLink()) return { entry: { type: "symlink", mode, link: readlinkSync(path) }, stamp: version };
    if (info.isDirectory()) {
      const fd = openSync(path, DIRECTORY);
      try { if (stamp(fstatSync(fd, { bigint: true })) !== version) throw Error("Native output directory changed while opening");
        return { entry: { type: "directory", mode, ...(members ? { members: readdirSync(at(fd, "."), { encoding: "buffer" }).map(p => p.toString("hex")).sort() } : {}) }, stamp: version };
      } finally { closeSync(fd); }
    }
    if (!info.isFile()) throw Error("Native output must be a regular file, directory or link");
    const file = await open(path, FILE);
    try {
      if (stamp(await file.stat({ bigint: true })) !== version) throw Error("Native output changed while opening");
      const hash = createHash("sha256"), buffer = Buffer.alloc(64 * 1024); let total = 0;
      for (;;) { const { bytesRead } = await file.read(buffer); if (!bytesRead) break; total += bytesRead;
        if (total > 4 * 1024 ** 3) throw Error("Native output exceeds existing 4 GiB file bound");
        hash.update(buffer.subarray(0, bytesRead)); if (total % (1024 * 1024) === 0) await Bun.sleep(0);
      }
      if (stamp(await file.stat({ bigint: true })) !== version) throw Error("Native output changed while hashing");
      return { entry: { type: "file", mode, hash: hash.digest("hex") }, stamp: version };
    } finally { await file.close(); }
  } finally { closeSync(handle.fd); }
}
function versionAt(fd: number, name: string): string | undefined {
  const info = lstatSync(at(fd, name), { bigint: true, throwIfNoEntry: false }); return info ? stamp(info) : undefined;
}
function currentVersion(root: string, rel: string): string | undefined {
  let handle: ReturnType<typeof parent>; try { handle = parent(root, rel); } catch (error) { if (absent(error)) return undefined; throw error; }
  try { return versionAt(handle.fd, handle.name); } finally { closeSync(handle.fd); }
}
function processStart(pid: number) { return Bun.file(`/proc/${pid}/stat`).text().then(t => t.replace(/^.*\) /s, "").split(" ")[19]); }
/** Acquisition completes before any synchronous SDK spawn callback. No copy/userxattr fallback. */
export async function prepareNativeWorkerOutput(brain: string, options: { startupView: WorkerStartupView; areas?: readonly string[]; folderPaths?: readonly string[]; signal?: AbortSignal }): Promise<PreparedWorkerOutput> {
  options.signal?.throwIfAborted();
  const retainedFolders = Object.freeze([...(options.folderPaths ?? [])]);
  if (retainedFolders.some(rel => !rel || rel.startsWith("/") || rel.startsWith("~") || /^[A-Za-z]:/.test(rel) || rel.includes("\\")
    || /[\u0000-\u001f\u007f*?[\]{}()!]/u.test(rel) || rel.split("/").some(part => !part || part === "." || part === "..")))
    throw Error("Invalid retained provider folder path");
  const native = nativeWorkerStartupInput(options.startupView), view = retainWorkerStartupView(options.startupView);
  const limits = hostOutputStagingLimits(); let reservation: ReturnType<ReturnType<typeof processStateLedger>["reserve"]> | undefined;
  let prepared: PreparedWorkerOutput | undefined, stageRequested = false;
  const id = randomUUID(); let stage: NativeStage | undefined, fd: number | undefined, cleanupPromise: Promise<void> | undefined;
  let identityTicket: { fd: number; close(): void } | undefined;
  const cleanup = () => cleanupPromise ??= (async () => {
    if (prepared) await executionDrain.get(prepared)?.exited;
    identityTicket?.close(); identityTicket = undefined;
    if (fd !== undefined) { closeSync(fd); fd = undefined; }
    // The stage and checkpoint remain owned if the manager cannot confirm
    // deletion. Releasing capacity on that failure would hide retained bytes.
    if (stageRequested) await native.manager.releaseStage(id);
    reservation?.release(); await view.cleanup();
  })();
  try {
    reservation = processStateLedger().reserve(undefined, undefined, limits);
    stageRequested = true;
    stage = await native.manager.prepareStage(id, native.checkpoint.id, reservation.outputStagingBytes, options.signal);
    options.signal?.throwIfAborted();
    const expected = join(dirname(brain), ".brain-native", "stages", id);
    if (stage.id !== id || stage.path !== expected || stage.checkpointId !== native.checkpoint.id || stage.checkpointUuid !== native.checkpoint.uuid
      || stage.sourceUuid !== native.checkpoint.sourceUuid || stage.appUid !== process.getuid?.() || stage.appGid !== process.getgid?.()
      || stage.allowanceBytes !== reservation.outputStagingBytes || await processStart(stage.namespacePid) !== stage.namespaceStart)
      throw Error("Native stage did not prove its configured owner and checkpoint identity");
    fd = openSync(`/proc/${stage.namespacePid}/root${stage.path}`, DIRECTORY);
    const info = fstatSync(fd, { bigint: true });
    if (String(info.dev) !== stage.rootDevice || String(info.ino) !== stage.rootInode) throw Error("Native stage mounted-root identity differs from its receipt");
    if (workerIdentityHelper()) identityTicket = await native.manager.attestStage(id, options.signal);
    options.signal?.throwIfAborted();
    const root = `/proc/${process.pid}/fd/${fd}`, storage: WorkerOutputStorage = { root, mount: stage.path, namespacePid: stage.namespacePid,
      namespaceStart: stage.namespaceStart, ...(identityTicket ? { identityTicketFd: identityTicket.fd } : {}),
      allowanceBytes: stage.allowanceBytes, retain() { if (cleanupPromise) throw Error("Native output is closed"); }, release: cleanup };
    const output = { source: `${root}/merged`, storage };
    const permissionDenied = (error: unknown) => ["EACCES", "EPERM"].includes((error as NodeJS.ErrnoException)?.code ?? "");
    async function readerUid(): Promise<number> {
      const identity = (await import("./worker-launcher.js")).verifiedWorkerIdentity(brain);
      if (!identity) throw Error("Native private output requires a successfully qualified worker identity");
      return identity.workerUid;
    }
    async function privateStat(stageInput: boolean, rel: string) {
      const uid = await readerUid();
      return stageInput ? native.manager.statStage(id, rel, uid, options.signal)
        : native.manager.statCheckpoint(native.checkpoint.id, rel, uid, options.signal);
    }
    async function privateBytes(stageInput: boolean, rel: string, consume: (bytes: Uint8Array) => Promise<void>, bound?: number) {
      const uid = await readerUid(), maximum = Math.min(bound ?? 4 * 1024 ** 3, stage!.allowanceBytes);
      const copy = stageInput ? await native.manager.readStage(id, rel, maximum, uid, options.signal)
        : await native.manager.readCheckpoint(native.checkpoint.id, rel, maximum, uid, options.signal);
      const reader = copy.stream.getReader(); let total = 0;
      try {
        for (;;) {
          options.signal?.throwIfAborted();
          const chunk = await reader.read(); if (chunk.done) break;
          total += chunk.value.byteLength; if (total > maximum) throw Error("Native private output exceeds its existing bound");
          await consume(chunk.value);
        }
        const receipt = await copy.completed;
        if (receipt.bytes !== total || receipt.workerUid !== uid) throw Error("Native private output reader receipt changed");
      } finally { await reader.cancel(); await copy.completed.catch(() => {}); }
    }
    async function inspectInput(stageInput: boolean, rel: string, members = false): Promise<Captured> {
      try { return await inspect(stageInput ? output.source : view.root, rel, members); }
      catch (error) { if (!identityTicket || !permissionDenied(error)) throw error; }
      const info = await privateStat(stageInput, rel);
      if (!info) return { entry: undefined, stamp: undefined };
      const version = `worker:${info.stamp}:${info.mode}:${info.kind}`;
      if (info.kind === "symlink") return { entry: { type: "symlink", mode: info.mode, link: info.target }, stamp: version };
      if (info.kind === "directory") {
        const uid = await readerUid();
        const rows = members ? (stageInput ? await native.manager.listStage(id, rel, uid, options.signal)
          : await native.manager.listCheckpoint(native.checkpoint.id, rel, uid, options.signal)) : undefined;
        return { entry: { type: "directory", mode: info.mode, ...(rows ? { members: rows.map(row => Buffer.from(row.path.slice(rel.length + 1)).toString("hex")).sort() } : {}) }, stamp: version };
      }
      if (info.kind !== "file") throw Error("Native output must be a regular file, directory or link");
      const hash = createHash("sha256");
      await privateBytes(stageInput, rel, async bytes => { hash.update(bytes); });
      if ((await privateStat(stageInput, rel))?.stamp !== info.stamp) throw Error("Native private output changed while hashing");
      return { entry: { type: "file", mode: info.mode, hash: hash.digest("hex") }, stamp: version };
    }
    async function publish(lock?: KeyedLock) {
      if (cleanupPromise) throw Error("Native output is closed");
      if (prepared) await executionDrain.get(prepared)?.exited;
      if (identityTicket) options.signal?.throwIfAborted();
      const receipt = await native.manager.inspectStage(id), candidates = new Set<string>();
      let count = 0;
      async function expand(rel: string, depth = 0) {
        if (depth > 256) throw Error("Native output exceeds existing directory depth bound");
        const entry = await inspectInput(false, rel, true); if (entry.entry?.type !== "directory") return;
        // Only deletion/opaque prefixes expand sealed descendants; ordinary copy-up parents never do.
        for (const raw of entry.entry.members!) {
          const name = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(raw, "hex")), child = `${rel}/${name}`;
          add(child); await expand(child, depth + 1);
        }
      }
      function add(rel: string) { if (++count > 200_000) throw Error("Native output exceeds existing 200000 entry bound"); candidates.add(rel); }
      for await (const change of receipt.changes) {
        const rel = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(change.pathHex, "hex"));
        // Validate components before any host path walk.
        if (rel.split("/").some(p => !p || p === "." || p === ".." || p.includes("\u0000"))) throw Error("Invalid native stage path");
        add(rel); if (change.kind === "whiteout" || change.kind === "opaque") await expand(rel);
      }
      await receipt.completed;
      if (receipt.checkpointId !== native.checkpoint.id || receipt.checkpointUuid !== native.checkpoint.uuid) throw Error("Native output inspection changed its lower identity");
      const selected = (rel: string) => !options.areas || options.areas.some(area => rel === area || rel.startsWith(`${area}/`));
      const before = new Map<string, Captured>(), after = new Map<string, Captured>();
      for (const rel of [...candidates].filter(selected).sort()) {
        const next = await inspectInput(true, rel); after.set(rel, next);
        before.set(rel, await inspectInput(false, rel, !next.entry));
      }
      const changed = [...before.keys()].filter(rel => !equal(before.get(rel)!.entry, after.get(rel)!.entry));
      const releases: (() => void)[] = [];
      try {
        if (lock) for (const rel of changed) releases.push(await lock.acquire(`path:${join(brain, rel)}`));
        const authoritative = new Map<string, Captured>();
        for (const rel of changed) {
          const previous = before.get(rel)!.entry, next = after.get(rel)!.entry;
          if (previous && next && (previous.type === "directory") !== (next.type === "directory")) throw Error(`maintenance cannot replace a directory with a non-directory or vice versa: ${rel}`);
          if (next?.type !== "directory" && retainedFolders.some(root => root === rel || root.startsWith(`${rel}/`)))
            throw Error(`maintenance output cannot remove or replace retained provider folder topology ${rel}`);
          const removesProtectedAncestor = previous?.type === "directory" && !next
            && PROTECTED_TIER_A.some(p => p.startsWith(`${rel}/`));
          if (removesProtectedAncestor || isEnvName(rel.split("/")[0]!) || PROTECTED_TIER_A.some(p => rel === p || rel.startsWith(`${p}/`))) throw Error(`maintenance output cannot change protected input ${rel}`);
          if (next?.type === "symlink") {
            const target = resolve(brain, join(rel, ".."), next.link!);
            if ((target !== brain && !target.startsWith(`${brain}/`)) || rel.startsWith(".git/") || PROTECTED_TIER_A.some(p => p.startsWith(`${rel}/`))) throw Error(`maintenance output has an escaping link: ${rel}`);
          }
          const live = await inspect(brain, rel, previous?.type === "directory" && !next); authoritative.set(rel, live);
          if (!equal(previous, live.entry, previous?.type === "directory" && !next)) throw Error(`stale maintenance output: ${rel}`);
        }
        // Changed-byte copies yield; the final inode/stat predicate immediately precedes publication.
        const pending: { rel: string; fd: number; name: string; temporary?: string; next?: Entry; recovery?: ReturnType<ReturnType<typeof processStateLedger>["reserve"]> }[] = [];
        const directoryModes: { fd: number; mode: number; rel: string; parent: number; name: string; temporaryMode: number }[] = [];
        let publicationError: unknown;
        const finalizeDirectory = (directory: (typeof directoryModes)[number]) => {
          const held = fstatSync(directory.fd), visible = lstatSync(at(directory.parent,directory.name));
          if (!visible.isDirectory() || held.dev !== visible.dev || held.ino !== visible.ino || (held.mode & 0o777) !== directory.temporaryMode) throw Error(`stale maintenance output: ${directory.rel}`);
          fchmodSync(directory.fd,directory.mode);
        };
        try {
          for (const rel of changed) {
            const next = after.get(rel)!.entry; if (!next || next.type === "directory") continue;
            const handle = { fd: preparationDirectory(brain, rel), name: `.maintenance-${randomUUID()}` }, temporary = at(handle.fd, handle.name);
            pending.push({ rel, ...handle, temporary, next });
            if (next.type === "symlink") symlinkSync(next.link!, temporary);
            else {
              if (after.get(rel)!.stamp?.startsWith("worker:")) {
                const beforeRead = await privateStat(true, rel);
                if (`worker:${beforeRead?.stamp}:${beforeRead?.mode}:${beforeRead?.kind}` !== after.get(rel)!.stamp) throw Error(`Native private output changed before copy: ${rel}`);
                try {
                  pending.at(-1)!.recovery = processStateLedger().reserve(undefined, undefined, { allowanceBytes: beforeRead!.bytes, budgetBytes: hostOutputStagingLimits().budgetBytes });
                } catch { throw Error("Native private output recovery capacity unavailable; the turn already executed and its output was not published"); }
                const target = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, next.mode);
                try {
                  await privateBytes(true, rel, async bytes => {
                    let written = 0;
                    while (written < bytes.byteLength) {
                      const result = await target.write(bytes, written, bytes.byteLength - written);
                      if (!result.bytesWritten) throw Error("Native private output copy made no progress");
                      written += result.bytesWritten;
                    }
                  }, beforeRead!.bytes);
                  if ((await privateStat(true, rel))?.stamp !== beforeRead!.stamp) throw Error(`Native private output changed during copy: ${rel}`);
                  await target.chmod(next.mode);
                } finally { await target.close(); }
                continue;
              }
              const source = parent(output.source, rel);
              let input: Awaited<ReturnType<typeof open>>;
              try { input = await open(at(source.fd, source.name), FILE); }
              catch (error) { closeSync(source.fd); throw error; }
              let target: Awaited<ReturnType<typeof open>> | undefined;
              try {
                if (stamp(await input.stat({ bigint: true })) !== after.get(rel)!.stamp) throw Error(`Native output changed before copy: ${rel}`);
                target = await open(temporary, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, next.mode);
                const buffer = Buffer.alloc(64 * 1024);
                for (;;) { const { bytesRead } = await input.read(buffer); if (!bytesRead) break; let written = 0;
                  while (written < bytesRead) written += (await target.write(buffer, written, bytesRead - written)).bytesWritten;
                  await Bun.sleep(0);
                }
                if (stamp(await input.stat({ bigint: true })) !== after.get(rel)!.stamp) throw Error(`Native output changed during copy: ${rel}`);
                await target.chmod(next.mode);
              } finally { closeSync(source.fd); await input.close(); await target?.close(); }
            }
          }
          // Broker/keeper loss invalidates the stage even if an open mount descriptor survives.
          if (await processStart(stage!.namespacePid).catch(() => undefined) !== stage!.namespaceStart) throw Error("Native output stage was lost; discard outputs and reconcile ownership");
          // Recheck all bases after async preparation and before the first mutation.
          for (const rel of changed) {
            const current = currentVersion(brain, rel), expected = authoritative.get(rel)!.stamp;
            // Parent-local preparation changes only directory timestamps. The
            // established directory predicate guards inode/mode; deletion also
            // keeps the complete membership/version check before removal.
            const directory = before.get(rel)!.entry?.type === "directory" && after.get(rel)!.entry?.type === "directory";
            if (directory ? current?.split(":").slice(0,3).join(":") !== expected?.split(":").slice(0,3).join(":") : current !== expected) throw Error(`stale maintenance output: ${rel}`);
          }
          for (const rel of changed.filter(p => !after.get(p)!.entry).sort((a,b) => b.split("/").length-a.split("/").length)) {
            const handle = parent(brain, rel); try { const current = versionAt(handle.fd, handle.name), expected = authoritative.get(rel)!.stamp;
              if (before.get(rel)!.entry!.type === "directory" ? current?.split(":").slice(0,3).join(":") !== expected?.split(":").slice(0,3).join(":") : current !== expected) throw Error(`stale maintenance output: ${rel}`);
              if (before.get(rel)!.entry!.type === "directory") rmdirSync(at(handle.fd, handle.name)); else unlinkSync(at(handle.fd, handle.name));
            } finally { closeSync(handle.fd); }
          }
          for (const rel of changed.filter(p => after.get(p)!.entry?.type === "directory").sort((a,b) => a.split("/").length-b.split("/").length)) {
            const entry = after.get(rel)!.entry!, handle = parent(brain, rel);
            try {
              const current = versionAt(handle.fd, handle.name), expected = authoritative.get(rel)!.stamp;
              if (current?.split(":").slice(0,3).join(":") !== expected?.split(":").slice(0,3).join(":")) throw Error(`stale maintenance output: ${rel}`);
              if (!before.get(rel)!.entry) mkdirSync(at(handle.fd, handle.name), { mode: entry.mode | 0o700 });
              const directory = openSync(at(handle.fd, handle.name), DIRECTORY), temporaryMode = entry.mode | 0o700;
              fchmodSync(directory, temporaryMode); directoryModes.push({ fd: directory, mode: entry.mode, rel, parent: openSync(at(handle.fd, "."), DIRECTORY), name: handle.name, temporaryMode });
            } finally { closeSync(handle.fd); }
          }
          for (const item of pending) {
            const destination = parent(brain, item.rel);
            try {
              if (versionAt(destination.fd, destination.name) !== authoritative.get(item.rel)!.stamp) throw Error(`stale maintenance output: ${item.rel}`);
              if (before.get(item.rel)!.entry) renameSync(item.temporary!, at(destination.fd,destination.name));
              else { try { linkSync(item.temporary!, at(destination.fd,destination.name)); } catch (error) { if ((error as NodeJS.ErrnoException).code === "EEXIST") throw Error(`stale maintenance output: ${item.rel}`); throw error; } }
            } finally { closeSync(destination.fd); }
          }
        } catch (error) { publicationError = error; }
        finally {
          // Drain every retained descriptor; cleanup cannot replace the original refusal.
          for (const item of pending) {
            try { if (item.temporary) rmSync(item.temporary, { force: true }); item.recovery?.release(); } catch (error) { publicationError ??= error; }
            try { closeSync(item.fd); } catch (error) { publicationError ??= error; }
          }
          for (const directory of directoryModes.reverse()) {
            try { finalizeDirectory(directory); } catch (error) { publicationError ??= error; }
            try { closeSync(directory.fd); } catch (error) { publicationError ??= error; }
            try { closeSync(directory.parent); } catch (error) { publicationError ??= error; }
          }
        }
        if (publicationError) throw publicationError;
      } finally { for (const release of releases.reverse()) release(); }
    }
    prepared = { view, output, publish: () => publish(), publishLocked: publish, cleanup }; executionDrain.set(prepared, {}); return prepared;
  } catch (error) {
    const refusal = error instanceof NativeBrainManagerError && error.code === "capacity"
      ? new WorkerStateError(FIRST_PARTY_FAILURE_CLASSES.worker_state_busy, `Native worker output staging capacity refused before launch: ${error.message} Nothing was sent. Retry after another conversation finishes, or align the configured manager allowance and budget.`) : error;
    try { await cleanup(); } catch (releaseError) { throw new AggregateError([refusal, releaseError], `Native output ${id} has an unknown outcome; reconcile its durable ownership.`); }
    throw refusal;
  }
}
