/**
 * Host-only Btrfs broker for one explicitly provisioned finite store (#1790).
 * Run in a separate trusted service, never in the app or an agent worker.
 * It cannot format, resize, execute repository code or accept caller host paths.
 * Its fixed staging operation mounts one bounded private trusted OverlayFS.
 */
import { constants, openSync, closeSync, fsyncSync, fstatSync, writeFileSync, readFileSync, renameSync, lstatSync, statSync,
  mkdirSync, chmodSync, chownSync, readdirSync, realpathSync, existsSync, unlinkSync, ftruncateSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";
import { nativeCheckpointId, nativeManagerRequest, nativeManagerFrame, NativeBrainManagerError, NATIVE_CONTROL_BYTES, NATIVE_DATA_CHUNK_BYTES, NATIVE_MANAGER_OPERATION_TIMEOUT_MS, NATIVE_MANAGER_MAX_DELTA_BYTES,
  type NativeCheckpoint, type NativeManagerReady, type NativeManagerRequest, type NativeRecoveryRecord } from "./native-brain-manager-protocol.js";
import { startNativeStage } from "./native-brain-stage.js";
import { randomUUID } from "node:crypto";
import { nativeCheckpointReaderPath, startNativeCheckpointRead } from "./native-checkpoint-reader.js";
import { NativeRecoveryIndex } from "./native-recovery-index.js";

const BTRFS = "/usr/bin/btrfs", PYTHON = "/usr/bin/python3", FALLOCATE = "/usr/bin/fallocate";
const ENV = Object.freeze({ PATH: "/usr/bin:/bin", LC_ALL: "C", LANG: "C" });
const BTRFS_MAGIC = 0x9123683e;
/** Interval between transaction-thread wakes while a deleted root awaits its cleaner. */
const RECLAIM_WAKE_MS = 1_000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Kernel UAPI: GET_SUBVOL_INFO supplies ctransid independently of generation/otransid. */
const INSPECT = `import os,sys,fcntl,struct,json,uuid
fd=os.open(sys.argv[1],os.O_RDONLY|os.O_DIRECTORY|os.O_NOFOLLOW)
try:
 s=os.fstat(fd)
 if s.st_ino!=256: raise RuntimeError("not a subvolume root")
 root=bytearray(504); fcntl.ioctl(fd,0x81f8943c,root,True)
 fs=bytearray(1024); fcntl.ioctl(fd,0x8400941f,fs,True)
 q=lambda offset: str(struct.unpack_from("<Q",root,offset)[0])
 u=lambda offset: bytes(root[offset:offset+16]).hex()
 print(json.dumps({"rootId":q(0),"uuid":u(296),"parentUuid":u(312),"receivedUuid":u(328),"transaction":q(344),"readOnly":bool(int(q(288))&1),"fsid":str(uuid.UUID(bytes=bytes(fs[16:32]))),"devices":struct.unpack_from("<Q",fs,8)[0]}))
finally: os.close(fd)
`;
const LOOP_IDENTITY = `import os,sys,fcntl,struct,json
fd=os.open(sys.argv[1],os.O_RDONLY|os.O_NOFOLLOW)
try:
 info=bytearray(232); fcntl.ioctl(fd,0x4c05,info,True)
 print(json.dumps({"device":str(struct.unpack_from("<Q",info,0)[0]),"inode":str(struct.unpack_from("<Q",info,8)[0])}))
finally: os.close(fd)
`;

export interface NativeBrainManagerConfig {
  /** Root-owned mount of the configured Btrfs device's top-level tree. */
  storePath: string;
  devicePath: string;
  fsid: string;
  /** Fixed existing store/brain root identity, independent of paths/inodes. */
  brainUuid: string;
  socketPath: string;
  appGid: number;
  /** Fixed app identity and existing configured output-staging bounds. */
  appUid?: number;
  /** Fixed identity used by the configured worker identity helper; never caller-selected. */
  workerUid?: number;
  stageAllowanceBytes?: number;
  stageBudgetBytes?: number;
  capacityBytes: number;
  recoveryReserveBytes: number;
  operationTimeoutMs?: number;
  maxDeltaBytes?: number;
}
type RootInfo = { rootId: string; uuid: string; parentUuid: string; receivedUuid: string; transaction: string; readOnly: boolean; fsid: string; devices: number };
type Intent = NativeRecoveryRecord & { version: 1; sourceUuid: string };

export function validateNativeBrainManagerConfig(config: NativeBrainManagerConfig): void {
  for (const key of ["storePath", "devicePath", "socketPath"] as const)
    if (!isAbsolute(config[key]) || config[key].includes("\0") || config[key].split("/").includes("..")) throw new NativeBrainManagerError("invalid", `Native manager ${key} must be one absolute fixed path.`);
  if (!UUID.test(config.fsid) || !/^[0-9a-f]{32}$/.test(config.brainUuid)) throw new NativeBrainManagerError("invalid", "Native manager needs fixed filesystem and live-subvolume UUIDs.");
  for (const key of ["capacityBytes", "recoveryReserveBytes"] as const)
    if (!Number.isSafeInteger(config[key]) || config[key] <= 0) throw new NativeBrainManagerError("invalid", `Native manager ${key} requires an explicit finite positive integer.`);
  for (const [name, value] of [["operationTimeoutMs", config.operationTimeoutMs ?? NATIVE_MANAGER_OPERATION_TIMEOUT_MS], ["maxDeltaBytes", config.maxDeltaBytes ?? NATIVE_MANAGER_MAX_DELTA_BYTES]] as const)
    if (!Number.isSafeInteger(value) || value <= 0) throw new NativeBrainManagerError("invalid", `Native manager ${name} must be a finite positive transport bound.`);
  if (config.recoveryReserveBytes >= config.capacityBytes || config.recoveryReserveBytes % 4096 !== 0)
    throw new NativeBrainManagerError("invalid", "Native manager recovery reserve must be whole pages smaller than the configured capacity.");
  if (!Number.isSafeInteger(config.appGid) || config.appGid < 0) throw new NativeBrainManagerError("invalid", "Native manager needs an explicit app group identity.");
  if (config.workerUid !== undefined && (!Number.isSafeInteger(config.workerUid) || config.workerUid <= 0 || config.workerUid >= 0xffffffff ||
    !Number.isSafeInteger(config.appUid) || config.workerUid === config.appUid))
    throw new NativeBrainManagerError("invalid", "Native checkpoint reader requires a fixed nonzero worker UID distinct from its fixed app UID.");
  if ([config.appUid, config.stageAllowanceBytes, config.stageBudgetBytes].some(value => value !== undefined)) {
    if (!Number.isSafeInteger(config.appUid) || config.appUid! < 0 || config.appUid! >= 0xffffffff)
      throw new NativeBrainManagerError("invalid", "Native staging requires a fixed app UID.");
    for (const value of [config.stageAllowanceBytes, config.stageBudgetBytes])
      if (!Number.isSafeInteger(value) || value! <= 0 || value! % 4096 !== 0) throw new NativeBrainManagerError("invalid", "Native staging requires the explicit finite page-aligned output allowance and aggregate budget.");
    if (config.stageAllowanceBytes! > config.stageBudgetBytes!) throw new NativeBrainManagerError("invalid", "Native stage allowance exceeds its configured aggregate budget.");
  }
}

const unescapeMount = (text: string) => text.replace(/\\(040|011|012|134)/g, (_all, digits: string) => String.fromCharCode(parseInt(digits, 8)));
/** No nested mount is omitted by the live root's checkpoint. */
export function nativeStoreMount(mountinfo: string, store: string, brain: string): { options: string[]; source: string } {
  const rows = mountinfo.trim().split("\n").map(line => {
    const [left, right] = line.split(" - "), fields = left!.split(" "), fs = right?.split(" ");
    return { root: unescapeMount(fields[3] ?? ""), path: unescapeMount(fields[4] ?? ""), options: [...(fields[5] ?? "").split(","), ...(fs?.[2] ?? "").split(",")], type: fs?.[0], source: unescapeMount(fs?.[1] ?? "") };
  });
  const mounted = rows.filter(row => row.path === store);
  if (mounted.length !== 1 || mounted[0]!.type !== "btrfs" || mounted[0]!.root !== "/" || !mounted[0]!.options.includes("rw"))
    throw new NativeBrainManagerError("unsupported", "Provision one read-write top-level Btrfs mount at the configured native store; no directory/full-copy fallback exists.");
  if (rows.some(row => row.path === brain || row.path.startsWith(brain + "/")))
    throw new NativeBrainManagerError("unsupported", "The managed brain must not contain nested mounts.");
  return mounted[0]!;
}

function trustedDirectory(path: string, expectedMode?: number): void {
  const entry = lstatSync(path);
  if (!entry.isDirectory() || entry.isSymbolicLink() || entry.uid !== 0 || (entry.mode & 0o022) !== 0 || (expectedMode !== undefined && (entry.mode & 0o777) !== expectedMode))
    throw new NativeBrainManagerError("unsupported", `Native manager requires a root-owned protected directory: ${path}`);
}
function trustedAncestors(path: string): void {
  for (let current = path; ; current = dirname(current)) { trustedDirectory(current); if (current === "/") break; }
}
function errorCode(error: unknown): string | undefined { return (error as NodeJS.ErrnoException)?.code; }
function plainError(error: unknown): NativeBrainManagerError {
  if (error instanceof NativeBrainManagerError) return error;
  return new NativeBrainManagerError(["ENOSPC", "EDQUOT"].includes(errorCode(error) ?? "") ? "capacity" : "unavailable", String(error));
}
async function collect(stream: ReadableStream<Uint8Array>, maximum: number): Promise<Uint8Array> {
  const reader = stream.getReader(), pieces: Uint8Array[] = []; let bytes = 0;
  try { for (;;) {
    const item = await reader.read(); if (item.done) break;
    bytes += item.value.byteLength;
    if (bytes > maximum) throw new NativeBrainManagerError("unavailable", "Native manager command output exceeded its bound.");
    pieces.push(item.value);
  } } finally { await reader.cancel(); }
  const result = new Uint8Array(bytes); let offset = 0;
  for (const part of pieces) { result.set(part, offset); offset += part.byteLength; } return result;
}

export async function createNativeBrainManager(config: NativeBrainManagerConfig) {
  validateNativeBrainManagerConfig(config);
  if (process.platform !== "linux" || process.arch !== "x64" || process.geteuid?.() !== 0)
    throw new NativeBrainManagerError("unsupported", "Native manager requires the separately qualified trusted Linux x86-64 root service; the app and workers remain unprivileged.");
  const fixed = Object.freeze({ ...config, operationTimeoutMs: config.operationTimeoutMs ?? NATIVE_MANAGER_OPERATION_TIMEOUT_MS, maxDeltaBytes: config.maxDeltaBytes ?? NATIVE_MANAGER_MAX_DELTA_BYTES }), brain = join(fixed.storePath, "brain"), privateRoot = join(fixed.storePath, ".brain-native"), state = join(privateRoot, "state"), roots = join(privateRoot, "checkpoints"), reserve = join(privateRoot, "emergency"), stages = join(privateRoot, "stages");
  trustedAncestors(fixed.storePath); trustedAncestors(dirname(fixed.socketPath));
  if (realpathSync(fixed.storePath) !== fixed.storePath || fixed.socketPath === brain || fixed.socketPath.startsWith(brain + "/"))
    throw new NativeBrainManagerError("unsupported", "Native store and socket require protected canonical paths outside the live brain.");
  for (const binary of [BTRFS, PYTHON, FALLOCATE]) {
    const executable = statSync(binary);
    if (!executable.isFile() || executable.uid !== 0 || (executable.mode & 0o022)) throw new NativeBrainManagerError("unsupported", `Native manager requires trusted system executable ${binary}.`);
  }
  let closed = false, pending = Promise.resolve(), active = new Set<AbortController>(), backingPath: string | undefined;
  const activeStages = new Map<string, Awaited<ReturnType<typeof startNativeStage>>>();
  const stageReservations = new Map<string, { checkpointId: string; allowanceBytes: number }>();
  const checkpointReaders = new Map<string, { checkpointId: string; close(): Promise<void> }>();
  let stagedBytes = 0;
  async function acquire(signal?: AbortSignal): Promise<() => void> {
    signal?.throwIfAborted(); if (closed) throw new NativeBrainManagerError("unavailable", "Native manager is closing.");
    let release!: () => void;
    const before = pending; pending = new Promise<void>(done => { release = done; });
    await before;
    if (closed || signal?.aborted) { release(); signal?.throwIfAborted(); throw new NativeBrainManagerError("unavailable", "Native manager is closing."); }
    return release;
  }
  function spawn(command: string[], signal?: AbortSignal) {
    const controller = new AbortController(); active.add(controller);
    const stop = () => controller.abort(signal?.reason); signal?.addEventListener("abort", stop, { once: true });
    if (signal?.aborted) stop();
    const timer = setTimeout(() => controller.abort(new Error("Native manager transport operation timeout exceeded; configure operationTimeoutMs for this host workload.")), fixed.operationTimeoutMs);
    let child: ReturnType<typeof Bun.spawn>;
    try { controller.signal.throwIfAborted(); child = Bun.spawn(command, { env: ENV, cwd: "/", stdin: "ignore", stdout: "pipe", stderr: "pipe" }); }
    catch (error) { clearTimeout(timer); signal?.removeEventListener("abort", stop); active.delete(controller); throw error; }
    const kill = () => child.kill("SIGKILL"); controller.signal.addEventListener("abort", kill, { once: true });
    const finished = child.exited.finally(() => { clearTimeout(timer); signal?.removeEventListener("abort", stop); controller.signal.removeEventListener("abort", kill); active.delete(controller); });
    return { child, finished, signal: controller.signal, kill };
  }
  async function command(argv: string[], signal?: AbortSignal, permitFailure = false): Promise<{ code: number; text: string; errors: string }> {
    const running = spawn(argv, signal);
    try {
      const [output, errors, code] = await Promise.all([collect(running.child.stdout as ReadableStream<Uint8Array>, NATIVE_CONTROL_BYTES), collect(running.child.stderr as ReadableStream<Uint8Array>, NATIVE_CONTROL_BYTES), running.finished]);
      if (running.signal.aborted) throw new NativeBrainManagerError("unknown", `Native manager command was interrupted; reconcile recorded intent. ${String(running.signal.reason)}`);
      const text = new TextDecoder("utf-8", { fatal: true }).decode(output), detail = new TextDecoder().decode(errors);
      if (code !== 0 && !permitFailure) throw new NativeBrainManagerError(/No space left on device|Disk quota exceeded/.test(detail) ? "capacity" : "unavailable", `Native command refused: ${detail.trim()}`);
      return { code, text, errors: detail };
    } catch (error) { running.kill(); await running.finished; throw error; }
  }
  // Btrfs queues a deleted root for its cleaner only once the root's last
  // in-memory reference drops. A reference released after delete's
  // --commit-after wake otherwise waits a whole commit interval (30 s by
  // default) for the next transaction-thread pass, and `subvolume sync` only
  // polls. Waking that thread while waiting reclaims a transiently held root
  // promptly; a retained reference still reaches the unchanged deadline.
  async function syncDeleted(rootId: string, signal?: AbortSignal): Promise<void> {
    let settled = false;
    const sync = command([BTRFS, "subvolume", "sync", fixed.storePath, rootId], signal);
    const done = sync.then(() => { settled = true; }, () => { settled = true; });
    // Wakes only accelerate reclamation: their failure never decides the outcome,
    // and one still running is cancelled and reaped once the sync settles.
    const wakes = new AbortController(), wakeSignal = signal ? AbortSignal.any([signal, wakes.signal]) : wakes.signal;
    while (!settled) {
      await Promise.race([done, Bun.sleep(RECLAIM_WAKE_MS)]);
      if (settled) break;
      const wake = command([BTRFS, "filesystem", "sync", fixed.storePath], wakeSignal, true).then(() => {}, () => {});
      await Promise.race([done, wake]);
      if (settled) { wakes.abort(); await wake; }
    }
    await sync;
  }
  async function inspect(path: string, signal?: AbortSignal): Promise<RootInfo> {
    const result = await command([PYTHON, "-I", "-S", "-c", INSPECT, path], signal), info = JSON.parse(result.text) as RootInfo;
    if (info.fsid !== fixed.fsid || info.devices !== 1 || !/^[0-9a-f]{32}$/.test(info.uuid) || !/^\d+$/.test(info.rootId) || !/^\d+$/.test(info.transaction) || info.receivedUuid !== "0".repeat(32))
      throw new NativeBrainManagerError("unsupported", "Native root identity or single-device store cannot be verified.");
    return info;
  }
  async function qualify(signal?: AbortSignal): Promise<RootInfo> {
    trustedDirectory(fixed.storePath);
    const mount = nativeStoreMount(readFileSync("/proc/self/mountinfo", "utf8"), fixed.storePath, brain);
    // Btrfs emits enabled sync/async discard in mountinfo; nodiscard itself is omitted.
    if (mount.options.some(option => option === "discard" || option.startsWith("discard=")))
      throw new NativeBrainManagerError("unsupported", "Native managed store requires explicitly disabled discard, including for fully allocated loop backing.");
    const device = statSync(fixed.devicePath, { bigint: true });
    if (!device.isBlockDevice()) throw new NativeBrainManagerError("unsupported", "Configure the actual fixed block device, not a directory or image filename.");
    const major = Number((device.rdev >> 8n) & 0xfffn) + Number((device.rdev >> 32n) & 0xfffff000n), minor = Number(device.rdev & 0xffn) + Number((device.rdev >> 12n) & 0xffffff00n);
    const sysDevice = `/sys/dev/block/${major}:${minor}`;
    const devices = readdirSync(`/sys/fs/btrfs/${fixed.fsid}/devices`);
    if (devices.length !== 1 || readFileSync(join(`/sys/fs/btrfs/${fixed.fsid}/devices`, devices[0]!, "dev"), "utf8").trim() !== `${major}:${minor}` || Number(readFileSync(join(sysDevice, "size"), "utf8")) * 512 !== fixed.capacityBytes)
      throw new NativeBrainManagerError("unsupported", "The configured capacity must equal the actual sole Btrfs device capacity; resize/autogrow is unsupported.");
    if (major === 7) {
      const backing = readFileSync(join(sysDevice, "loop/backing_file"), "utf8").trim();
      if (!isAbsolute(backing)) throw new NativeBrainManagerError("unsupported", "Native loop backing identity is unavailable in this service namespace.");
      trustedAncestors(dirname(backing)); const file = lstatSync(backing);
      if (!file.isFile() || file.uid !== 0 || file.nlink !== 1 || (file.mode & 0o022) || file.size !== fixed.capacityBytes || file.blocks * 512 < file.size)
        throw new NativeBrainManagerError("unsupported", "Native loop storage requires owned fixed fully allocated non-sparse backing; provision it explicitly with discard disabled.");
      const kernelBacking = JSON.parse((await command([PYTHON, "-I", "-S", "-c", LOOP_IDENTITY, fixed.devicePath], signal)).text);
      const backingIdentity = lstatSync(backing, { bigint: true });
      if (kernelBacking.device !== String(backingIdentity.dev) || kernelBacking.inode !== String(backingIdentity.ino))
        throw new NativeBrainManagerError("unsupported", "Native loop kernel backing identity differs from its owned preallocated file.");
      if (Number(readFileSync(join(sysDevice, "loop/offset"), "utf8")) !== 0 || Number(readFileSync(join(sysDevice, "loop/sizelimit"), "utf8")) !== 0)
        throw new NativeBrainManagerError("unsupported", "Native loop offsets and implicit size limits are unsupported.");
      backingPath = backing;
    }
    const root = await inspect(brain, signal);
    if (root.uuid !== fixed.brainUuid || root.readOnly) throw new NativeBrainManagerError("unsupported", "The fixed live brain subvolume identity changed or is read-only.");
    if ((await command([BTRFS, "subvolume", "list", "-o", brain], signal)).text.trim()) throw new NativeBrainManagerError("unsupported", "Nested brain subvolumes are unsupported and would be omitted by checkpoints.");
    const quotas = await command([BTRFS, "qgroup", "show", "--raw", fixed.storePath], signal, true);
    if (quotas.code === 0 || !/quotas? (?:not|is not) enabled|quota not enabled/i.test(quotas.errors)) throw new NativeBrainManagerError("unsupported", "Native store must have qgroups disabled; absence could not be verified.");
    return root;
  }
  await qualify();
  for (const [path, mode] of [[privateRoot, 0o710], [state, 0o700], [roots, 0o750], [stages, 0o710]] as const) {
    if (!existsSync(path)) { mkdirSync(path, { mode }); chownSync(path, 0, fixed.appGid); chmodSync(path, mode); }
    trustedDirectory(path, mode);
  }
  const stateFd = openSync(state, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  let reserveConsumed = false;
  async function ensureReserve(signal?: AbortSignal) {
    if (!existsSync(reserve)) {
      const fd = openSync(reserve, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600); closeSync(fd);
    }
    const item = lstatSync(reserve);
    if (!item.isFile() || item.uid !== 0 || item.nlink !== 1 || (item.mode & 0o077)) throw new NativeBrainManagerError("unsupported", "Native emergency reserve must be one protected owned file.");
    if (item.size !== fixed.recoveryReserveBytes || item.blocks * 512 < fixed.recoveryReserveBytes) {
      await command([FALLOCATE, "--length", String(fixed.recoveryReserveBytes), reserve], signal);
      const fd = openSync(reserve, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    const allocated = lstatSync(reserve);
    if (allocated.size !== fixed.recoveryReserveBytes || allocated.blocks * 512 < fixed.recoveryReserveBytes) throw new NativeBrainManagerError("capacity", "Native emergency allocation could not be verified.");
    reserveConsumed = false;
  }
  // A full existing store must still serve release/recovery. Ready/checkpoint refuse until rearmed.
  try { await ensureReserve(); } catch (error) { if (plainError(error).code !== "capacity") { closeSync(stateFd); throw error; } reserveConsumed = true; }
  function readIntent(id: string): Intent | null {
    const path = join(state, `${id}.json`);
    if (!existsSync(path)) return null;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd); if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || info.size > NATIVE_CONTROL_BYTES) throw Error("Untrusted native intent.");
      const result = JSON.parse(readFileSync(fd, "utf8")) as Intent;
      if ((result.kind !== undefined && result.kind !== "stage") || result.version !== 1 || result.id !== id || result.sourceUuid !== fixed.brainUuid || !["creating", "sealed", "deleting", "deleted"].includes(result.state)) throw Error("Invalid native intent.");
      return result;
    } finally { closeSync(fd); }
  }
  async function writeIntent(intent: Intent) {
    const destination = join(state, `${intent.id}.json`), temporary = join(state, `${intent.id}.tmp`), bytes = JSON.stringify(intent);
    if (Buffer.byteLength(bytes) > NATIVE_CONTROL_BYTES) throw new NativeBrainManagerError("unavailable", "Native intent exceeded its durable bound.");
    const write = () => {
      if (existsSync(temporary)) unlinkSync(temporary);
      const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, destination); fsyncSync(stateFd);
    };
    try { write(); }
    catch (error) {
      if (!["ENOSPC", "EDQUOT"].includes(errorCode(error) ?? "")) throw plainError(error);
      // Release actual allocated bytes only for intent/reconciliation, never to admit a worker.
      const fd = openSync(reserve, constants.O_WRONLY | constants.O_NOFOLLOW);
      try { ftruncateSync(fd, 0); fsyncSync(fd); } finally { closeSync(fd); }
      reserveConsumed = true; await command([BTRFS, "filesystem", "sync", fixed.storePath]);
      try { write(); } catch (again) { throw plainError(again); }
    }
    // The durable intent remains authoritative if indexing is interrupted.
    // An index failure refuses later pages until a restart rebuilds it.
    try { recoveryIndex.remember(intent.id); }
    catch { throw new NativeBrainManagerError("unknown", "Native intent is durable but recovery indexing failed; restart the manager to rebuild it."); }
    rememberStage(intent);
  }
  function rememberStage(intent: Intent): void {
    if (intent.kind !== "stage") return;
    const old = stageReservations.get(intent.id);
    if (old) { stagedBytes -= old.allowanceBytes; stageReservations.delete(intent.id); }
    if (intent.state === "deleted") return;
    const request = intent.stageRequest;
    if (!request || !nativeCheckpointId.safeParse(request.checkpointId).success || !/^[0-9a-f]{32}$/.test(request.checkpointUuid)
      || !Number.isSafeInteger(request.allowanceBytes) || request.allowanceBytes <= 0 || request.allowanceBytes % 4096)
      throw new NativeBrainManagerError("unknown", "Native stage reservation receipt is incomplete; no new stage admission is authorized.");
    stageReservations.set(intent.id, request); stagedBytes += request.allowanceBytes;
    if (!Number.isSafeInteger(stagedBytes)) throw new NativeBrainManagerError("unknown", "Native stage reservation accounting overflowed.");
  }
  // Recover bounded stage accounting once at service startup; warm admission
  // never rescans all checkpoint tombstones or any live-brain bytes.
  const recoveredIds: string[] = [];
  for (const name of readdirSync(state).filter(name => name.endsWith(".json"))) {
    const id = name.slice(0, -5);
    if (!nativeCheckpointId.safeParse(id).success) throw new NativeBrainManagerError("unknown", "Native state contains an unrecognized identity.");
    rememberStage(readIntent(id)!);
    recoveredIds.push(id);
  }
  // This one-time rebuild remains O(history). The private in-memory B-tree
  // is disposable; neither its loss nor a lost reply retires an identity.
  const recoveryIndex = (() => {
    try { return new NativeRecoveryIndex(recoveredIds); }
    catch (error) { closeSync(stateFd); throw error; }
  })();
  const rootPath = (id: string) => join(roots, id);
  async function verifyOwned(intent: Intent, signal?: AbortSignal): Promise<NativeCheckpoint> {
    if (intent.kind === "stage") throw new NativeBrainManagerError("invalid", "A staged namespace is not a native checkpoint identity.");
    const info = await inspect(rootPath(intent.id), signal);
    if (!info.readOnly || info.parentUuid !== fixed.brainUuid || (intent.checkpoint && (info.uuid !== intent.checkpoint.uuid || info.rootId !== intent.checkpoint.rootId || info.transaction !== intent.checkpoint.transaction)))
      throw new NativeBrainManagerError("unknown", "Recorded checkpoint native identity or immutability changed; no deletion or use is authorized.");
    return { id: intent.id, sourceUuid: info.parentUuid, path: rootPath(intent.id), fsid: fixed.fsid, rootId: info.rootId, uuid: info.uuid, transaction: info.transaction, readOnly: true };
  }
  async function reconcile(intent: Intent, signal?: AbortSignal): Promise<Intent> {
    if (intent.kind === "stage") return intent;
    if (intent.state === "creating" && existsSync(rootPath(intent.id))) {
      const checkpoint = await verifyOwned(intent, signal); intent = { ...intent, state: "sealed", checkpoint }; await writeIntent(intent);
    }
    if (intent.state === "deleting" && !existsSync(rootPath(intent.id))) {
      if (!intent.checkpoint) throw new NativeBrainManagerError("unknown", "Deletion intent lacks its native root identity.");
      await syncDeleted(intent.checkpoint.rootId, signal);
      intent = { ...intent, state: "deleted" }; await writeIntent(intent);
    }
    return intent;
  }
  async function ready(signal?: AbortSignal): Promise<NativeManagerReady> {
    const identity = await qualify(signal); await ensureReserve(signal);
    const { statfsSync } = await import("node:fs"), space = statfsSync(fixed.storePath);
    if (space.type !== BTRFS_MAGIC) throw new NativeBrainManagerError("unsupported", "Native store filesystem type changed.");
    return { brainPath: brain, brainUuid: identity.uuid, brainRootId: identity.rootId,
      privatePaths: [...new Set([privateRoot, dirname(fixed.socketPath), fixed.devicePath, ...(backingPath ? [backingPath] : [])])],
      fsid: fixed.fsid, capacityBytes: fixed.capacityBytes, availableBytes: space.bavail * space.bsize, recoveryReserveBytes: fixed.recoveryReserveBytes,
      reserveAllocatedBytes: lstatSync(reserve).blocks * 512 };
  }
  async function run(request: NativeManagerRequest, signal?: AbortSignal): Promise<Response> {
    nativeManagerRequest.parse(request); const release = await acquire(signal); let handedToStream = false;
    try {
      if (request.operation === "ready") return Response.json(await ready(signal));
      if (request.operation === "cancelCheckpointRead") {
        const reader = checkpointReaders.get(request.id);
        if (reader) await reader.close();
        return Response.json({ id: request.id, closed: true });
      }
      if (request.operation === "readStage") {
        if (fixed.workerUid === undefined || fixed.appUid === undefined) throw new NativeBrainManagerError("unsupported", "Configure the fixed worker identity before private stage reads.");
        if (checkpointReaders.size >= 8) throw new NativeBrainManagerError("unavailable", "Native reader slots are busy.");
        const intent = readIntent(request.id), handle = activeStages.get(request.id);
        if (!intent || intent.kind !== "stage" || intent.state !== "sealed" || !handle)
          throw new NativeBrainManagerError("unavailable", "Stage reading requires one active manager-owned stage.");
        const maximum = Math.min(request.maximum, request.action === "file" ? handle.stage.allowanceBytes : fixed.maxDeltaBytes);
        const id = randomUUID(), token = randomUUID(), socketPath = nativeCheckpointReaderPath(fixed.socketPath, id);
        const reader = await handle.read({ id, token, socketPath, request: { action: request.action, path: request.path, maximum } }, signal);
        const close = async () => { try { await reader.close(); } finally { checkpointReaders.delete(id); } };
        checkpointReaders.set(id, { checkpointId: handle.stage.checkpointId, close });
        if (signal?.aborted) { await close(); signal.throwIfAborted(); }
        return Response.json({ id, token, socketPath, workerUid: fixed.workerUid, maximum });
      }
      if (request.operation === "readCheckpoint") {
        if (fixed.workerUid === undefined || fixed.appUid === undefined)
          throw new NativeBrainManagerError("unsupported", "Configure the native manager's fixed workerUid to match the qualified identity helper before private checkpoint reads.");
        if (checkpointReaders.size >= 8) throw new NativeBrainManagerError("unavailable", "Native checkpoint reader slots are busy.");
        const intent = readIntent(request.id);
        if (!intent || intent.kind === "stage" || intent.state !== "sealed")
          throw new NativeBrainManagerError("unknown", "Checkpoint reading requires one retained sealed checkpoint identity.");
        const checkpoint = await verifyOwned(intent, signal);
        const maximum = Math.min(request.maximum, request.action === "file" ? fixed.capacityBytes : fixed.maxDeltaBytes);
        const id = randomUUID(), token = randomUUID(), socketPath = nativeCheckpointReaderPath(fixed.socketPath, id);
        const rootFd = openSync(checkpoint.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          signal?.throwIfAborted();
          const reader = await startNativeCheckpointRead({ id, token, socketPath, workerUid: fixed.workerUid, maximum, rootFd,
            appUid: fixed.appUid, appGid: fixed.appGid, timeoutMs: fixed.operationTimeoutMs, request: { action: request.action, path: request.path, maximum } });
          checkpointReaders.set(id, { checkpointId: request.id, close: reader.close });
          void reader.finished.finally(() => checkpointReaders.delete(id)).catch(() => {});
          if (signal?.aborted) { await reader.close(); signal.throwIfAborted(); }
          return Response.json({ id, token, socketPath, workerUid: fixed.workerUid, maximum });
        } finally { closeSync(rootFd); }
      }
      if (request.operation === "attestStage") {
        if (fixed.workerUid === undefined || fixed.appUid === undefined)
          throw new NativeBrainManagerError("unsupported", "Stage identity authority requires the configured fixed worker identity.");
        if (checkpointReaders.size >= 8) throw new NativeBrainManagerError("unavailable", "Native descriptor transfer slots are busy.");
        const intent = readIntent(request.id), handle = activeStages.get(request.id);
        if (!intent || intent.kind !== "stage" || intent.state !== "sealed" || !handle)
          throw new NativeBrainManagerError("unavailable", "Only a live manager-owned stage can authorize a worker mount namespace.");
        const stage = handle.stage;
        const start = readFileSync(`/proc/${stage.namespacePid}/stat`, "utf8").replace(/^.*\) /s, "").split(" ")[19];
        if (start !== stage.namespaceStart || stage.appUid !== fixed.appUid || stage.appGid !== fixed.appGid)
          throw new NativeBrainManagerError("unavailable", "Stage keeper identity changed before attestation.");
        const source = readIntent(stage.checkpointId);
        if (!source || source.kind === "stage" || source.state !== "sealed")
          throw new NativeBrainManagerError("unknown", "Stage checkpoint authority is no longer retained.");
        const checkpoint = await verifyOwned(source, signal);
        if (checkpoint.uuid !== stage.checkpointUuid) throw new NativeBrainManagerError("unknown", "Stage checkpoint identity changed.");
        const rootFd = openSync(checkpoint.path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
        try {
          const info = fstatSync(rootFd, { bigint: true });
          const authority = { version: 1 as const, kind: "brain-worker-stage" as const, id: stage.id,
            appUid: stage.appUid, appGid: stage.appGid,
            keeper: { pid: stage.namespacePid, start: stage.namespaceStart, mountNamespaceInode: handle.mountNamespaceInode },
            root: { path: stage.path + "/merged", dev: handle.mergedDevice, ino: handle.mergedInode },
            checkpoint: { path: checkpoint.path, dev: String(info.dev), ino: String(info.ino), uuid: checkpoint.uuid },
            allowanceBytes: stage.allowanceBytes };
          const id = randomUUID(), token = randomUUID(), socketPath = nativeCheckpointReaderPath(fixed.socketPath, id);
          const transfer = await startNativeCheckpointRead({ id, token, socketPath, workerUid: fixed.workerUid, maximum: NATIVE_CONTROL_BYTES, rootFd,
            appUid: fixed.appUid, appGid: fixed.appGid, timeoutMs: fixed.operationTimeoutMs, request: { action: "authority", authority } });
          checkpointReaders.set(id, { checkpointId: checkpoint.id, close: transfer.close });
          void transfer.finished.finally(() => checkpointReaders.delete(id)).catch(() => {});
          if (signal?.aborted) { await transfer.close(); signal.throwIfAborted(); }
          return Response.json({ id, token, socketPath });
        } finally { closeSync(rootFd); }
      }
      if (request.operation === "listRecovery") {
        const ids = recoveryIndex.page(request.after);
        const page = ids.slice(0, 64), records: NativeRecoveryRecord[] = [];
        let last: string | null = request.after;
        for (const id of page) {
          const record = await reconcile(readIntent(id)!, signal);
          const publicRecord: NativeRecoveryRecord = { id: record.id, state: record.state,
            ...(record.checkpoint ? { checkpoint: record.checkpoint } : {}), ...(record.kind ? { kind: record.kind } : {}),
            ...(record.stage ? { stage: record.stage } : {}), ...(record.stageRequest ? { stageRequest: record.stageRequest } : {}) };
          if (Buffer.byteLength(JSON.stringify({ records: [...records, publicRecord], next: id })) > NATIVE_CONTROL_BYTES) break;
          records.push(publicRecord); last = id;
        }
        if (!records.length && page.length) throw new NativeBrainManagerError("unavailable", "A native recovery record exceeds the control response bound.");
        return Response.json({ records, next: last && ids.some(id => id > last!) ? last : null });
      }
      if (request.operation === "prepareStage") {
        if (fixed.appUid === undefined || fixed.stageAllowanceBytes === undefined || fixed.stageBudgetBytes === undefined)
          throw new NativeBrainManagerError("unsupported", "Configure fixed appUid and existing output staging allowance/budget before native output admission.");
        if (!Number.isSafeInteger(request.allowanceBytes) || request.allowanceBytes % 4096 || request.allowanceBytes > fixed.stageAllowanceBytes)
          throw new NativeBrainManagerError("capacity", "Requested native staging allowance exceeds its configured finite bound.");
        let intent = readIntent(request.id);
        if (intent && intent.kind !== "stage") throw new NativeBrainManagerError("invalid", "This identity belongs to a checkpoint, not a stage.");
        if (intent?.state === "deleted" || intent?.state === "deleting") throw new NativeBrainManagerError("released", "This stage identity was released; it cannot be recreated.");
        if (intent?.state === "sealed") {
          const running = activeStages.get(request.id);
          if (!running) throw new NativeBrainManagerError("unavailable", "Staged output was lost across broker restart; stop the worker and discard its outputs.");
          if (running.stage.checkpointId !== request.checkpointId || running.stage.allowanceBytes !== request.allowanceBytes)
            throw new NativeBrainManagerError("invalid", "An existing stage cannot change its checkpoint or allowance.");
          return Response.json(running.stage);
        }
        if (intent) throw new NativeBrainManagerError("unavailable", "Interrupted stage preparation must be released before retry with a new identity.");
        const source = readIntent(request.checkpointId);
        if (!source || source.kind === "stage" || source.state !== "sealed") throw new NativeBrainManagerError("unknown", "Native staging requires one retained sealed checkpoint.");
        const checkpoint = await verifyOwned(source, signal);
        if (stagedBytes + request.allowanceBytes > fixed.stageBudgetBytes) throw new NativeBrainManagerError("capacity", "Native output staging aggregate budget is busy; nothing ran.");
        const path = join(stages, request.id);
        if (!intent) {
          if (existsSync(path)) throw new NativeBrainManagerError("unknown", "Unrecorded staging storage occupies this identity.");
          intent = { version: 1, id: request.id, sourceUuid: fixed.brainUuid, kind: "stage", state: "creating",
            stageRequest: { checkpointId: request.checkpointId, checkpointUuid: checkpoint.uuid, allowanceBytes: request.allowanceBytes } }; await writeIntent(intent);
          mkdirSync(path, { mode: 0o700 });
        } else if (existsSync(path)) throw new NativeBrainManagerError("unavailable", "Interrupted stage preparation must be released before retry with a new identity.");
        let handle: Awaited<ReturnType<typeof startNativeStage>> | undefined;
        try {
          handle = await startNativeStage({ id: request.id, checkpointId: request.checkpointId, checkpointUuid: checkpoint.uuid,
            sourceUuid: fixed.brainUuid, path, lower: checkpoint.path, workerUid: fixed.workerUid, appUid: fixed.appUid, appGid: fixed.appGid,
            allowanceBytes: request.allowanceBytes, timeoutMs: fixed.operationTimeoutMs, signal });
          activeStages.set(request.id, handle); await writeIntent({ ...intent, state: "sealed", stage: handle.stage });
          return Response.json(handle.stage);
        } catch (error) { await handle?.close(); activeStages.delete(request.id); throw plainError(error); }
      }
      if (request.operation === "releaseStage") {
        let intent = readIntent(request.id); const path = join(stages, request.id);
        if (!intent) {
          if (existsSync(path)) throw new NativeBrainManagerError("unknown", "Unrecorded staged storage cannot be released.");
          await writeIntent({ version: 1, id: request.id, sourceUuid: fixed.brainUuid, kind: "stage", state: "deleted" });
          return Response.json({ id: request.id, state: "deleted" });
        }
        if (intent.kind !== "stage") throw new NativeBrainManagerError("invalid", "This identity belongs to a checkpoint, not a stage.");
        if (intent.state === "deleted") return Response.json({ id: request.id, state: "deleted" });
        await writeIntent({ ...intent, state: "deleting" });
        await activeStages.get(request.id)?.close(); activeStages.delete(request.id);
        if (existsSync(path)) {
          const info = lstatSync(path); if (!info.isDirectory() || info.uid !== 0 || readdirSync(path).length)
            throw new NativeBrainManagerError("unknown", "Stage placeholder identity is unsafe; no removal is authorized.");
          const { rmdirSync } = await import("node:fs"); rmdirSync(path);
        }
        await writeIntent({ ...intent, state: "deleted" }); return Response.json({ id: request.id, state: "deleted" });
      }
      if (request.operation === "inspectStage") {
        const intent = readIntent(request.id), handle = activeStages.get(request.id);
        if (intent?.kind !== "stage" || intent.state !== "sealed" || !handle)
          throw new NativeBrainManagerError("unavailable", "Staged output is unavailable; stop the worker, discard outputs and release its recorded ownership.");
        const iterator = handle.inspect(signal)[Symbol.asyncIterator](); let bytes = 0, finished = false;
        const finish = async () => { if (!finished) { finished = true; await iterator.return?.(undefined); release(); } };
        const body = new ReadableStream<Uint8Array>({ async pull(controller) {
          try {
            const next = await iterator.next();
            if (next.done) { controller.enqueue(nativeManagerFrame(2, new TextEncoder().encode(JSON.stringify({ ok: true, exitCode: 0, bytes })))); controller.close(); await finish(); return; }
            const row = new TextEncoder().encode(JSON.stringify(next.value) + "\n"); bytes += row.byteLength;
            if (bytes > fixed.maxDeltaBytes) throw new NativeBrainManagerError("capacity", "Stage metadata exceeded its configured transport bound.");
            controller.enqueue(nativeManagerFrame(1, row));
          } catch (error) { controller.error(error); await finish(); }
        }, async cancel() { await finish(); } });
        handedToStream = true;
        return new Response(body, { headers: { "content-type": "application/x-brain-native-stage", "x-brain-stage-id": request.id,
          "x-brain-stage-checkpoint": handle.stage.checkpointId, "x-brain-stage-lower": handle.stage.checkpointUuid } });
      }
      if (request.operation === "checkpoint") {
        await qualify(signal);
        let intent = readIntent(request.id);
        if (intent) intent = await reconcile(intent, signal);
        if (intent?.state === "deleted" || intent?.state === "deleting") throw new NativeBrainManagerError("released", "This checkpoint identity was released; it cannot be recreated.");
        if (intent?.state === "sealed") return Response.json(await verifyOwned(intent, signal));
        await ensureReserve(signal);
        if (!intent) {
          if (existsSync(rootPath(request.id))) throw new NativeBrainManagerError("unknown", "An unrecorded checkpoint occupies the requested identity.");
          intent = { version: 1, id: request.id, sourceUuid: fixed.brainUuid, state: "creating" }; await writeIntent(intent);
        }
        if (reserveConsumed) throw new NativeBrainManagerError("capacity", "Native recovery consumed emergency allocation; rearm capacity before checkpoint admission.");
        signal?.throwIfAborted();
        await command([BTRFS, "subvolume", "snapshot", "-r", brain, rootPath(request.id)], signal);
        const checkpoint = await verifyOwned(intent, signal); await writeIntent({ ...intent, state: "sealed", checkpoint });
        return Response.json(checkpoint);
      }
      if (request.operation === "release") {
        if ([...checkpointReaders.values()].some(reader => reader.checkpointId === request.id))
          throw new NativeBrainManagerError("unavailable", "Close the checkpoint's active fixed-reader handle before releasing its native view.");
        let intent = readIntent(request.id);
        if (intent?.kind === "stage") throw new NativeBrainManagerError("invalid", "Use releaseStage for staged namespace ownership.");
        if ([...stageReservations.values()].some(stage => stage.checkpointId === request.id))
          throw new NativeBrainManagerError("unavailable", "Release the checkpoint's staged output references before its native view.");
        if (!intent) {
          // Fence a lost/never-arrived creation request using its fixed UUID.
          // An unrecorded existing root still has no verified deletion authority.
          if (existsSync(rootPath(request.id))) throw new NativeBrainManagerError("unknown", "An unrecorded native root cannot be released.");
          await writeIntent({ version: 1, id: request.id, sourceUuid: fixed.brainUuid, state: "deleted" });
          return Response.json({ id: request.id, state: "deleted" });
        }
        intent = await reconcile(intent, signal);
        if (intent.state === "deleted") return Response.json({ id: request.id, state: "deleted" });
        if (intent.state === "creating" && !existsSync(rootPath(request.id))) { await writeIntent({ ...intent, state: "deleted" }); return Response.json({ id: request.id, state: "deleted" }); }
        const checkpoint = await verifyOwned(intent, signal);
        await writeIntent({ ...intent, state: "deleting", checkpoint });
        signal?.throwIfAborted();
        await command([BTRFS, "subvolume", "delete", "--commit-after", rootPath(request.id)], signal);
        await syncDeleted(checkpoint.rootId, signal);
        await writeIntent({ ...intent, state: "deleted", checkpoint });
        return Response.json({ id: request.id, state: "deleted" });
      }
      const from = readIntent(request.from), to = readIntent(request.to);
      if (!from || !to || from.state !== "sealed" || to.state !== "sealed") throw new NativeBrainManagerError("unknown", "Native delta requires two retained sealed checkpoint identities.");
      await verifyOwned(from, signal); await verifyOwned(to, signal);
      const running = spawn([BTRFS, "send", "--no-data", "--proto", "1", "-p", rootPath(from.id), rootPath(to.id)], signal);
      const reader = (running.child.stdout as ReadableStream<Uint8Array>).getReader(), errors = collect(running.child.stderr as ReadableStream<Uint8Array>, NATIVE_CONTROL_BYTES);
      let bytes = 0, finished = false, released = false;
      const releaseSend = () => { if (!released) { released = true; release(); } };
      // A stalled/disconnected consumer must not retain the broker lock after its owned command exits.
      void errors.catch(() => running.kill());
      void running.finished.then(releaseSend, releaseSend);
      const finish = async () => { if (finished) return; finished = true; running.kill(); await running.finished; await errors.catch(() => {}); releaseSend(); };
      const body = new ReadableStream<Uint8Array>({
        async pull(controller) {
          try {
            const item = await reader.read();
            if (!item.done) {
              bytes += item.value.byteLength; if (bytes > fixed.maxDeltaBytes) throw new NativeBrainManagerError("capacity", "Native send exceeded the maxDeltaBytes transport work bound; configure it for this host workload. This is not a history quota.");
              for (let offset = 0; offset < item.value.byteLength; offset += NATIVE_DATA_CHUNK_BYTES) controller.enqueue(nativeManagerFrame(1, item.value.slice(offset, offset + NATIVE_DATA_CHUNK_BYTES)));
              return;
            }
            const code = await running.finished, detail = new TextDecoder().decode(await errors);
            if (code !== 0 || running.signal.aborted) throw new NativeBrainManagerError("unavailable", `Native send did not complete: ${detail.trim()}`);
            controller.enqueue(nativeManagerFrame(2, new TextEncoder().encode(JSON.stringify({ ok: true, exitCode: 0, bytes }))));
            controller.close(); await finish();
          } catch (error) {
            try {
              const known = plainError(error);
              controller.enqueue(nativeManagerFrame(2, new TextEncoder().encode(JSON.stringify({ ok: false, code: known.code, message: known.message })))); controller.close();
            } catch { /* A disconnected/cancelled receiver gets no successful completion. */ }
            finally { await reader.cancel(error); await finish(); }
          }
        },
        async cancel(reason) { await reader.cancel(reason); await finish(); },
      });
      handedToStream = true;
      return new Response(body, { headers: { "content-type": "application/x-brain-native-delta" } });
    } finally { if (!handedToStream) release(); }
  }
  return {
    /** Only an already authenticated Unix endpoint invokes this fixed operation set. */
    run,
    async close() { closed = true; for (const controller of active) controller.abort(); await pending;
      try {
        for (const reader of checkpointReaders.values()) await reader.close(); checkpointReaders.clear();
        for (const stage of activeStages.values()) await stage.close(); activeStages.clear();
      } finally { recoveryIndex.close(); closeSync(stateFd); } },
  };
}

/** Unix socket only; filesystem ownership is authentication, and workers must mask the endpoint. */
export async function serveNativeBrainManager(config: NativeBrainManagerConfig) {
  const fixed = Object.freeze({ ...config }), manager = await createNativeBrainManager(fixed);
  if (existsSync(fixed.socketPath)) { await manager.close(); throw new NativeBrainManagerError("unsupported", "Native manager socket already exists; reconcile its service ownership before starting."); }
  let server: ReturnType<typeof Bun.serve>;
  try {
    server = Bun.serve({ unix: fixed.socketPath, maxRequestBodySize: 1024,
      async fetch(request) {
        try {
          if (request.method !== "POST" || new URL(request.url).pathname !== "/native-brain" || request.headers.get("content-type") !== "application/json")
            throw new NativeBrainManagerError("invalid", "Native manager accepts fixed JSON operations only.");
          const raw = await request.text(); if (Buffer.byteLength(raw) > 1024) throw new NativeBrainManagerError("invalid", "Native request exceeded its bound.");
          const parsed = nativeManagerRequest.safeParse(JSON.parse(raw));
          if (!parsed.success) throw new NativeBrainManagerError("invalid", "Native manager operation or identity is invalid.");
          const response = await manager.run(parsed.data, request.signal);
          if (response.headers.get("content-type")?.startsWith("application/json") && Number(response.headers.get("content-length") ?? "0") > NATIVE_CONTROL_BYTES)
            throw new NativeBrainManagerError("unavailable", "Native control response exceeded its bound.");
          return response;
        } catch (error) { const known = plainError(error); return Response.json({ code: known.code, message: known.message }, { status: known.code === "invalid" ? 400 : 503 }); }
      },
    });
    chownSync(fixed.socketPath, 0, fixed.appGid); chmodSync(fixed.socketPath, 0o660);
  } catch (error) { await manager.close(); throw error; }
  return { socketPath: fixed.socketPath, async close() { server.stop(true); await manager.close(); } };
}
