/** Changed-only publication from a root-inspected trusted OverlayFS stage. */
import { closeSync, constants, fstatSync, fchmodSync, lstatSync, linkSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync, rmSync, rmdirSync, symlinkSync, unlinkSync } from "node:fs";
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
import { maintenanceEnvMaskQueries, hostEnvMaskQuery, type EnvMaskQuery } from "./maintenance-env-masks.js";
import { captureMaintenanceGitFiles, maintenanceGitDigest, type MaintenanceGitManifest, type MaintenanceGitScaffold, type MaintenanceGitScaffoldReceipt } from "./maintenance-git-input.js";
import type { WorkerLaunch } from "./worker-launcher.js";
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
type GitInputReceipt = { inode: string; digest: string; scaffolds?: MaintenanceGitScaffoldReceipt[]; parentInode?: string };
type NativeMaintenanceOwner = {
  protected: boolean;
  generation: number;
  index(input: WorkerLaunch): Promise<NativeMaintenanceIndexPreparation>;
  finishIndex(preparation: NativeMaintenanceIndexPreparation, success: boolean): void;
  bindExecution(exited: Promise<unknown>): void;
  assertCurrent(input: WorkerLaunch): void;
  masks(input: WorkerLaunch, signal?: AbortSignal): Promise<string[]>;
  git(input: WorkerLaunch, spec: NonNullable<NonNullable<WorkerLaunch["maintenance"]>["git"]>, signal?: AbortSignal): Promise<NativeMaintenanceGitPreparation>;
  finishGit(preparation: NativeMaintenanceGitPreparation, receipt: GitInputReceipt | undefined, signal?: AbortSignal): Promise<void>;
};
type NativeMaintenanceIndexPreparation = { owner: NativeMaintenanceOwner; generation: number; maximum: number; retained: WorkerLaunch; retainedContext: string; launch?: WorkerLaunch; context?: string };
const nativeIndexPreparations = new WeakSet<NativeMaintenanceIndexPreparation>();
const nativeIndexWriters = new WeakMap<WorkerLaunch, NativeMaintenanceIndexPreparation>();
/** Fixed derived-index preparation, using only the existing retained stage. */
export async function prepareNativeMaintenanceIndex(input: WorkerLaunch): Promise<NativeMaintenanceIndexPreparation | undefined> {
  const owner = maintenanceOwner(input); if (!owner) return undefined;
  const preparation = await owner.index(input); nativeIndexPreparations.add(preparation); return preparation;
}
export function authorizeNativeMaintenanceIndex(input: WorkerLaunch, preparation: NativeMaintenanceIndexPreparation): void {
  if (!nativeIndexPreparations.has(preparation) || maintenanceOwner(input) !== preparation.owner || preparation.launch || preparation.generation !== preparation.owner.generation)
    throw Error("Foreign disposable index preparation");
  preparation.launch = input; preparation.context = maskContext(input); nativeIndexWriters.set(input, preparation);
}
export function finishNativeMaintenanceIndex(preparation: NativeMaintenanceIndexPreparation, success: boolean): void {
  if (!nativeIndexPreparations.delete(preparation)) throw Error("Replayed disposable index preparation");
  preparation.owner.finishIndex(preparation, success);
  if (preparation.launch) nativeIndexWriters.delete(preparation.launch);
}
type GitSpec = NonNullable<NonNullable<WorkerLaunch["maintenance"]>["git"]>;
type NativeGitLease = { owner: NativeMaintenanceOwner; relative: string; hostSource: string; spec: GitSpec; inode?: string; digest?: string; ready: boolean };
export type NativeMaintenanceGitPreparation = { owner: NativeMaintenanceOwner; lease: NativeGitLease; manifest: MaintenanceGitManifest; generation: number };
const nativeGitPreparations = new WeakSet<NativeMaintenanceGitPreparation>();
const nativeGitSpecs = new WeakMap<GitSpec, NativeGitLease>();
const nativeGitWriters = new WeakMap<WorkerLaunch, NativeMaintenanceGitPreparation>();
const nativeMaintenanceOwners = new WeakMap<WorkerOutputStorage, NativeMaintenanceOwner>();
const nativeMaintenancePlans = new WeakMap<WorkerLaunch, { owner: NativeMaintenanceOwner; context: string; generation: number; masks: string[] }>();
const maskContext = (input: WorkerLaunch) => JSON.stringify({ brain: input.brainPath, view: input.startupView?.root,
  command: input.command, env: input.env, maintenance: input.maintenance && { ...input.maintenance,
    output: input.maintenance.output && { source: input.maintenance.output.source, target: input.maintenance.output.target } } });
function maintenanceOwner(input: WorkerLaunch): NativeMaintenanceOwner | undefined {
  const output = input.maintenance?.output;
  if (!output?.storage || input.maintenance?.credentials) return undefined;
  const owner = nativeMaintenanceOwners.get(output.storage);
  if (!owner && workerIdentityHelper()) throw Error("native maintenance requires its retained attested stage owner");
  return owner?.protected ? owner : undefined;
}
/** Concrete Git input only, tied to an existing retained stage and fixed producer. */
export async function prepareNativeMaintenanceGit(input: WorkerLaunch, spec: GitSpec, signal?: AbortSignal): Promise<NativeMaintenanceGitPreparation | undefined> {
  const owner = maintenanceOwner(input); if (!owner) return undefined;
  owner.assertCurrent(input);
  const preparation = await owner.git(input, spec, signal);
  nativeGitPreparations.add(preparation); return preparation;
}
export function authorizeNativeMaintenanceGitWriter(input: WorkerLaunch, preparation: NativeMaintenanceGitPreparation): void {
  if (!nativeGitPreparations.has(preparation) || maintenanceOwner(input) !== preparation.owner || preparation.generation !== preparation.owner.generation || input.maintenance?.git)
    throw Error("Foreign maintenance Git input preparation");
  nativeGitWriters.set(input, preparation);
  try { preparation.owner.assertCurrent(input); } catch (error) { nativeGitWriters.delete(input); throw error; }
}
export async function finishNativeMaintenanceGit(preparation: NativeMaintenanceGitPreparation, receipt: GitInputReceipt | undefined, signal?: AbortSignal): Promise<GitSpec> {
  if (!nativeGitPreparations.delete(preparation)) throw Error("Replayed maintenance Git input preparation");
  await preparation.owner.finishGit(preparation, receipt, signal); return preparation.lease.spec;
}
/** Package-private concrete preparation; no caller-provided reader or receipt is authority. */
export async function prepareNativeMaintenanceMasks(input: WorkerLaunch, signal?: AbortSignal): Promise<void> {
  nativeMaintenancePlans.delete(input);
  const owner = maintenanceOwner(input); if (!owner) return;
  try {
    if (!input.startupView) throw Error("native maintenance requires an explicit prepared startup view");
    signal?.throwIfAborted();
    owner.assertCurrent(input); const context = maskContext(input), generation = owner.generation, masks = await owner.masks(input, signal);
    owner.assertCurrent(input);
    signal?.throwIfAborted();
    if (generation !== owner.generation || context !== maskContext(input)) throw Error("changed maintenance command");
    nativeMaintenancePlans.set(input, { owner, context, generation, masks });
  } catch { throw Error("native maintenance mask metadata is unavailable or changed"); }
}
/** Transfer only between the same concrete envelope before its single synchronous launch. */
export function transferNativeMaintenanceMasks(from: WorkerLaunch, to: WorkerLaunch): void {
  const plan = nativeMaintenancePlans.get(from); nativeMaintenancePlans.delete(from);
  if (!plan) return;
  if (plan.generation !== plan.owner.generation || plan.context !== maskContext(to)) throw Error("native maintenance command changed after mask preparation");
  const indexWriter = nativeIndexWriters.get(from); nativeIndexWriters.delete(from);
  if (indexWriter) { indexWriter.launch = to; nativeIndexWriters.set(to, indexWriter); }
  const writer = nativeGitWriters.get(from); nativeGitWriters.delete(from);
  if (writer) nativeGitWriters.set(to, writer);
  plan.owner.assertCurrent(to); nativeMaintenancePlans.set(to, plan);
}
/** A protected stage never falls back to direct host traversal or a prior command's plan. */
export function consumeNativeMaintenanceMasks(input: WorkerLaunch): string[] | undefined {
  const plan = nativeMaintenancePlans.get(input); nativeMaintenancePlans.delete(input);
  const owner = maintenanceOwner(input); if (!owner) return undefined;
  if (!plan || plan.owner !== owner || plan.generation !== owner.generation || plan.context !== maskContext(input)) throw Error("native maintenance masks require fresh asynchronous preparation");
  owner.assertCurrent(input); nativeGitWriters.delete(input); owner.generation++; return [...plan.masks];
}
/** Concrete stage ownership only; a completed command invalidates every earlier plan. */
export function bindNativeMaintenanceExit(input: WorkerLaunch, exited: Promise<unknown>): void {
  maintenanceOwner(input)?.bindExecution(exited);
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
  const gitControls = new Map<string, NativeGitLease>();
  let indexPreparation: NativeMaintenanceIndexPreparation | undefined, indexPoisoned = false;
  const gitScaffolds = new Map<MaintenanceGitScaffold["name"], MaintenanceGitScaffoldReceipt>();
  let gitPreparation: NativeMaintenanceGitPreparation | undefined, gitPoisoned = false, gitParentInode: string | undefined;
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
    const retainedHelper = workerIdentityHelper();
    if (retainedHelper) identityTicket = await native.manager.attestStage(id, options.signal);
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
    async function validateGitScaffolds(signal?: AbortSignal, live = false) {
      if (!gitParentInode && gitScaffolds.size === 0) return;
      const uid = await readerUid();
      if (gitParentInode) {
        const parent = await native.manager.statStage(id, ".git", uid, signal);
        if (!parent || parent.kind !== "directory" || parent.inode !== gitParentInode) throw Error("Git mask scaffold parent changed");
      }
      for (const [name, expected] of gitScaffolds) {
        const rel = `.git/${name}`;
        if (await native.manager.statCheckpoint(native.checkpoint.id, rel, uid, signal)) throw Error("Git mask scaffold lower identity changed");
        const item = await native.manager.statStage(id, rel, uid, signal);
        if (!item || item.kind !== "directory" || item.inode !== expected.inode || item.stamp !== expected.stamp || item.mode !== 0o700
          || (await native.manager.listStage(id, rel, uid, signal)).length)
          throw Error("Git mask scaffold changed");
        if (live && (await inspect(brain, rel)).entry) throw Error("Git mask scaffold live absence changed");
      }
    }
    async function publish(lock?: KeyedLock) {
      if (gitPoisoned || gitPreparation) throw Error("Git input preparation is incomplete; discard stage");
      if (indexPoisoned || indexPreparation) throw Error("Disposable index preparation is incomplete; discard stage");
      if (cleanupPromise) throw Error("Native output is closed");
      if (prepared) await executionDrain.get(prepared)?.exited;
      if (identityTicket) options.signal?.throwIfAborted();
      await validateGitScaffolds(options.signal, true);
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
      const isGitControl = (rel: string) => [...gitControls.keys()].some(root => rel === root || rel.startsWith(`${root}/`));
      function add(rel: string) { if (isGitControl(rel)) return; if (++count > 200_000) throw Error("Native output exceeds existing 200000 entry bound"); candidates.add(rel); }
      for await (const change of receipt.changes) {
        const rel = new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(change.pathHex, "hex"));
        if (isGitControl(rel)) continue;
        if ([...gitScaffolds.keys()].some(name => rel === `.git/${name}`)) continue;
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
        if (lock) for (const rel of [...new Set([...changed, ...[...gitScaffolds.keys()].map(name => `.git/${name}`)])].sort())
          releases.push(await lock.acquire(`path:${join(brain, rel)}`));
        await validateGitScaffolds(options.signal, true);
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
    prepared = { view, output, publish: () => publish(), publishLocked: publish, cleanup };
    const maintenanceOwner: NativeMaintenanceOwner = {
      protected: Boolean(identityTicket), generation: 0,
      async index(input) {
        if (prepared) await executionDrain.get(prepared)?.exited;
        this.assertCurrent(input);
        if (indexPreparation) throw Error("Disposable index preparation is already active");
        const preparation = { owner: this, generation: this.generation, maximum: storage.allowanceBytes, retained: input, retainedContext: maskContext(input) };
        indexPreparation = preparation; return preparation;
      },
      finishIndex(preparation, success) {
        try {
          if (!success || indexPreparation !== preparation || !preparation.launch || preparation.generation + 1 !== this.generation)
            throw Error("Disposable index preparation did not complete");
          if (maskContext(preparation.retained) !== preparation.retainedContext) throw Error("Changed disposable index owner envelope");
          indexPreparation = undefined;
          this.assertCurrent(preparation.retained);
        } catch (error) { indexPoisoned = true; indexPreparation = undefined; throw error; }
      },
      bindExecution(exited) { if (prepared) bindPreparedWorkerOutputExit(prepared, exited); },
      assertCurrent(input) {
        if (gitPoisoned || gitPreparation && nativeGitWriters.get(input) !== gitPreparation)
          throw Error("Git input stage requires complete preparation or discard");
        if (indexPoisoned || indexPreparation && (nativeIndexWriters.get(input) !== indexPreparation
          || indexPreparation.context !== maskContext(input))) throw Error("Disposable index stage requires complete preparation or discard");
        if (cleanupPromise || fd === undefined || !stage || input.maintenance?.output?.storage !== storage
          || input.maintenance.output.source !== output.source || workerIdentityHelper() !== retainedHelper
          || input.brainPath !== brain || storage.root !== root || storage.mount !== stage.path
          || storage.namespacePid !== stage.namespacePid || storage.namespaceStart !== stage.namespaceStart
          || storage.identityTicketFd !== identityTicket?.fd)
          throw Error("native maintenance stage owner is closed or foreign");
        const current = fstatSync(fd, { bigint: true });
        if (current.dev !== info.dev || current.ino !== info.ino
          || readFileSync(`/proc/${stage.namespacePid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[19] !== stage.namespaceStart)
          throw Error("native maintenance stage identity changed");
        if (!input.startupView || input.startupView.root !== native.checkpoint.path || input.startupView.brain !== brain)
          throw Error("native maintenance checkpoint owner is absent or changed");
        const git = input.maintenance?.git;
        if (git) {
          const lease = nativeGitSpecs.get(git);
          if (!lease || lease.owner !== this || !lease.ready || !lease.inode || !lease.digest || gitControls.get(lease.relative) !== lease
            || git.source !== join(output.source, lease.relative) || git.target !== "/tmp/brain-maintenance-git")
            throw Error("Unprepared or foreign concrete maintenance Git input");
        }
        const checkpoint = nativeWorkerStartupInput(input.startupView);
        if (checkpoint.manager !== native.manager || checkpoint.checkpoint.id !== native.checkpoint.id
          || checkpoint.checkpoint.uuid !== native.checkpoint.uuid)
          throw Error("native maintenance checkpoint owner is foreign");
      },
      async git(input, spec, commandSignal) {
        const signal = commandSignal && options.signal ? AbortSignal.any([commandSignal, options.signal]) : commandSignal ?? options.signal;
        signal?.throwIfAborted();
        if (prepared) await executionDrain.get(prepared)?.exited;
        this.assertCurrent(input);
        const prior = nativeGitSpecs.get(spec), hostSource = join(dirname(output.source), "git-adapter");
        if (spec.target !== "/tmp/brain-maintenance-git" || (prior ? prior.owner !== this || prior.hostSource !== hostSource : spec.source !== hostSource))
          throw Error("Foreign concrete maintenance Git input");
        const lease: NativeGitLease = prior ?? { owner: this, relative: `.brain-maintenance-git-${randomUUID()}`, hostSource,
          spec: { ...spec, source: "" }, ready: false };
        if (!prior) {
          if (await native.manager.statStage(id, lease.relative, await readerUid(), signal)) throw Error("Maintenance Git control path already exists");
          lease.spec.source = join(output.source, lease.relative);
          gitControls.set(lease.relative, lease); nativeGitSpecs.set(lease.spec, lease);
        }
        await validateGitScaffolds(signal);
        const uid = await readerUid(), scaffolds: MaintenanceGitScaffold[] = [];
        const parent = await native.manager.statStage(id, ".git", uid, signal);
        if (!parent || parent.kind !== "directory") throw Error("Git mask scaffold parent is not a directory");
        for (const name of ["hooks", "info", "modules"] as const) {
          const rel = `.git/${name}`;
          const lower = await native.manager.statCheckpoint(native.checkpoint.id, rel, uid, signal);
          if (lower) {
            if (lower.kind !== "directory") throw Error("Git mask input is not a directory");
            continue;
          }
          const expected = gitScaffolds.get(name), item = await native.manager.statStage(id, rel, uid, signal);
          if (item && !expected) throw Error("Unregistered Git mask scaffold");
          if (expected && (!item || item.inode !== expected.inode || item.stamp !== expected.stamp)) throw Error("Changed Git mask scaffold");
          scaffolds.push({ name, ...(expected ? { previous: { inode: expected.inode, stamp: expected.stamp } } : {}) });
        }
        const files = captureMaintenanceGitFiles(hostSource, storage.allowanceBytes);
        const manifest: MaintenanceGitManifest = { scaffolds, relative: lease.relative, maximum: storage.allowanceBytes, files,
          ...(lease.inode && lease.digest ? { previous: { inode: lease.inode, digest: lease.digest } } : {}) };
        if (Buffer.byteLength(JSON.stringify(manifest)) > storage.allowanceBytes) throw Error("Maintenance Git input exceeds its existing stage allowance");
        lease.ready = false;
        gitPreparation = { owner: this, lease, manifest, generation: this.generation };
        return gitPreparation;
      },
      async finishGit(preparation, receipt, commandSignal) {
        try {
          if (!receipt || gitPreparation !== preparation) throw Error("Incomplete Git input preparation");
          if (cleanupPromise || preparation.owner !== this || preparation.generation + 1 !== this.generation || gitControls.get(preparation.lease.relative) !== preparation.lease)
            throw Error("Closed or foreign maintenance Git input");
          const item = await native.manager.statStage(id, preparation.lease.relative, await readerUid(), commandSignal ?? options.signal);
          if (!item || item.kind !== "directory" || item.mode !== 0o700 || item.inode !== receipt.inode
            || receipt.digest !== maintenanceGitDigest(preparation.manifest.files)) throw Error("Changed maintenance Git input receipt");
          const expected = preparation.manifest.scaffolds ?? [], received = receipt.scaffolds;
          if (!Array.isArray(received) || received.length !== expected.length || new Set(received.map(row => row.name)).size !== received.length)
            throw Error("Changed Git mask scaffold receipt");
          const uid = await readerUid();
          const parent = await native.manager.statStage(id, ".git", uid, commandSignal ?? options.signal);
          if (!parent || parent.kind !== "directory" || typeof receipt.parentInode !== "string" || parent.inode !== receipt.parentInode
            || gitParentInode && gitParentInode !== parent.inode) throw Error("Changed Git mask scaffold parent receipt");
          gitParentInode = parent.inode;
          for (const row of received) {
            if (!expected.some(item => item.name === row.name) || row.uid !== uid || row.mode !== 0o700
              || typeof row.inode !== "string" || typeof row.stamp !== "string") throw Error("Foreign Git mask scaffold receipt");
            gitScaffolds.set(row.name, row);
          }
          await validateGitScaffolds(commandSignal ?? options.signal);
          preparation.lease.inode = receipt.inode; preparation.lease.digest = receipt.digest; preparation.lease.ready = true;
          gitPreparation = undefined;
        } catch (error) { gitPoisoned = true; gitPreparation = undefined; throw error; }
      },
      async masks(input, commandSignal) {
        const signal = commandSignal && options.signal ? AbortSignal.any([commandSignal, options.signal]) : commandSignal ?? options.signal;
        signal?.throwIfAborted();
        if (prepared) await executionDrain.get(prepared)?.exited;
        signal?.throwIfAborted();
        if (!nativeGitWriters.has(input)) await validateGitScaffolds(signal);
        const uid = await readerUid(), source = output.source;
        const copies = [{ from: brain, to: input.maintenance!.output!.target }];
        const plan = maintenanceEnvMaskQueries(source, brain, copies); let step = plan.next();
        while (!step.done) {
          const query: EnvMaskQuery = step.value;
          // The held root permits metadata on the merged directory itself;
          // only its contents require the already-authorized fixed reader.
          if (query.path === source && query.operation === "stat" || !(query.path === source || query.path.startsWith(`${source}/`))) {
            step = plan.next(hostEnvMaskQuery(query)); continue;
          }
          const rel = query.path === source ? "" : query.path.slice(source.length + 1);
          if (query.operation === "list") step = plan.next((await native.manager.listStage(id, rel, uid, signal)).map(row => row.path.slice(rel ? rel.length + 1 : 0)));
          else {
            const item = await native.manager.statStage(id, rel, uid, signal);
            step = plan.next(item ? { kind: item.kind, ...(item.kind === "symlink" ? { target: item.target } : {}) } : undefined);
          }
          if (cleanupPromise) throw Error("native maintenance stage closed during metadata preparation");
        }
        const writer = nativeGitWriters.get(input);
        return [...step.value, ...(!writer ? [...gitScaffolds.keys()].flatMap(name => {
          const target = join(input.maintenance!.output!.target, ".git", name);
          return ["--tmpfs", target, "--remount-ro", target];
        }) : []), ...[...gitControls.values()].flatMap(control => writer?.lease === control ? []
          : ["--tmpfs", join(input.maintenance!.output!.target, control.relative), "--remount-ro", join(input.maintenance!.output!.target, control.relative)])];
      },
    };
    nativeMaintenanceOwners.set(storage, maintenanceOwner);
    executionDrain.set(prepared, {}); return prepared;
  } catch (error) {
    const refusal = error instanceof NativeBrainManagerError && error.code === "capacity"
      ? new WorkerStateError(FIRST_PARTY_FAILURE_CLASSES.worker_state_busy, `Native worker output staging capacity refused before launch: ${error.message} Nothing was sent. Retry after another conversation finishes, or align the configured manager allowance and budget.`) : error;
    try { await cleanup(); } catch (releaseError) { throw new AggregateError([refusal, releaseError], `Native output ${id} has an unknown outcome; reconcile its durable ownership.`); }
    throw refusal;
  }
}
