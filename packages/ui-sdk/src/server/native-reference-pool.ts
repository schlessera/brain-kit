/**
 * Host-only reference pool (#2428): one separate Btrfs volume for reference
 * source, managed worktrees and staging, owned by the native manager.
 *
 * Mechanism, qualified in docs/decisions/reference-pool-accounting.md:
 * - Simple quotas (squota) charge every data extent and tree block once, to the
 *   root that allocated it. Each pool root is created with an atomic per-root
 *   kernel limit and membership in one fixed level-1 qgroup. Writes beyond
 *   either limit fail with EDQUOT at write time; nothing here polls.
 * - The aggregate charged to the combined allowance is the filesystem's own
 *   space_info `disk_used` across data, metadata and system, which counts each
 *   physical allocation once with its profile replication and includes global
 *   trees that no root owns.
 * - Admission reserves the physical bytes a reserved or writable root may still
 *   allocate before work starts. Measured use replaces that reservation as it
 *   materializes; sealing converts the rest to measured allocation.
 */
import { constants, closeSync, existsSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, readlinkSync, renameSync,
  rmdirSync, statSync, symlinkSync, unlinkSync, writeFileSync, ftruncateSync, chownSync, chmodSync, realpathSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, isAbsolute, join } from "node:path";
import { NativeBrainManagerError, nativeCheckpointId, nativePoolName, NATIVE_CONTROL_BYTES, REFERENCE_POOL_CHECKPOINT_BYTES, type NativePoolAccess, type NativePoolCheckpoint, type NativePoolRecord,
  type NativePoolSpace, type NativePoolState, type NativePoolStatus } from "./native-brain-manager-protocol.js";
import { NativeRecoveryIndex } from "./native-recovery-index.js";
import { POOL_HELPER } from "./native-reference-pool-helper.js";

const GIB = 1024 ** 3;
export const REFERENCE_POOL_COMBINED_BYTES = 10 * GIB;
export const REFERENCE_POOL_OPERATION_BYTES = 2 * GIB;
export const REFERENCE_POOL_MAX_IDENTITIES = 4096;
/** Fixed level-1 qgroup holding every pool root; its kernel limit backstops the combined allowance. */
export const REFERENCE_POOL_QGROUP = "1/2428";
const QGROUP_NUMBER = String((1n << 48n) | 2428n);
const PYTHON = "/usr/bin/python3", BTRFS = "/usr/bin/btrfs";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
/** Interval between transaction-thread wakes while a deleted root awaits its cleaner. */
const RECLAIM_WAKE_MS = 1_000;
const STATES: readonly NativePoolState[] = ["reserved", "writable", "sealed", "deleting", "deleted", "reclaimed"];
const PURPOSES = ["source", "worktree", "staging", "checkpoint"] as const;
/** Recently forgotten checkpoint identities kept across restarts; each still reads as reclaimed and is never recreated. */
const REFERENCE_POOL_FORGOTTEN = 512;

export interface NativeReferencePoolConfig {
  /** Root-owned mount of the pool volume's top-level tree, separate from the brain store. */
  storePath: string;
  devicePath: string;
  fsid: string;
  combinedLimitBytes?: number;
  operationLimitBytes?: number;
  /** Pool-local allocation released only to record recovery transitions under ENOSPC. */
  emergencyBytes: number;
  /** Free space kept on the physical backing; never spendable reference budget. */
  physicalFloorBytes: number;
  /** Required for sparse loop backing: a ledger file on the backing filesystem shared by every consumer. */
  headroomLedgerPath?: string;
  maxIdentities?: number;
}
export type QualifiedReferencePoolConfig = Required<Omit<NativeReferencePoolConfig, "headroomLedgerPath">> & { headroomLedgerPath?: string };

const fixedPath = (path: unknown) => typeof path === "string" && isAbsolute(path) && !path.includes("\0") && !path.split("/").includes("..") && path.length > 1;
const inside = (child: string, parent: string) => child === parent || child.startsWith(parent.endsWith("/") ? parent : parent + "/");
const page = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0 && (value as number) % 4096 === 0;

export function validateNativeReferencePoolConfig(pool: NativeReferencePoolConfig, store: { storePath: string; fsid: string; socketPath: string }): QualifiedReferencePoolConfig {
  if (!pool || typeof pool !== "object") throw new NativeBrainManagerError("invalid", "Reference pool configuration must be one object.");
  for (const key of ["storePath", "devicePath"] as const)
    if (!fixedPath(pool[key])) throw new NativeBrainManagerError("invalid", `Reference pool ${key} must be one absolute fixed path.`);
  if (pool.headroomLedgerPath !== undefined && !fixedPath(pool.headroomLedgerPath)) throw new NativeBrainManagerError("invalid", "Reference pool headroomLedgerPath must be one absolute fixed path.");
  if (typeof pool.fsid !== "string" || !UUID.test(pool.fsid)) throw new NativeBrainManagerError("invalid", "Reference pool needs its fixed filesystem UUID.");
  if (pool.fsid === store.fsid) throw new NativeBrainManagerError("invalid", "The reference pool must be a separate Btrfs volume from the brain store.");
  if (inside(pool.storePath, store.storePath) || inside(store.storePath, pool.storePath) || inside(store.socketPath, pool.storePath) || pool.devicePath === store.storePath)
    throw new NativeBrainManagerError("invalid", "Reference pool and brain store paths must not contain each other.");
  const fixed = { ...pool, combinedLimitBytes: pool.combinedLimitBytes ?? REFERENCE_POOL_COMBINED_BYTES, operationLimitBytes: pool.operationLimitBytes ?? REFERENCE_POOL_OPERATION_BYTES,
    maxIdentities: pool.maxIdentities ?? REFERENCE_POOL_MAX_IDENTITIES };
  for (const key of ["combinedLimitBytes", "operationLimitBytes", "emergencyBytes", "physicalFloorBytes"] as const)
    if (!page(fixed[key])) throw new NativeBrainManagerError("invalid", `Reference pool ${key} must be an explicit finite positive whole number of 4096-byte pages.`);
  if (fixed.operationLimitBytes > fixed.combinedLimitBytes) throw new NativeBrainManagerError("invalid", "Reference pool operation allowance exceeds its combined allowance.");
  if (!Number.isSafeInteger(fixed.maxIdentities) || fixed.maxIdentities < 1 || fixed.maxIdentities > 65_536)
    throw new NativeBrainManagerError("invalid", "Reference pool maxIdentities must be a finite bound from 1 to 65536.");
  return Object.freeze(fixed);
}

/** Helper output, validated before use; any other shape is unknown evidence. */
export interface PoolQgroup { referenced: number; exclusive: number; max_referenced: number; max_exclusive: number; limit_flags: number; rsv_data: number; rsv_meta_pertrans: number; rsv_meta_prealloc: number }
export interface PoolObservation {
  stable: boolean; reads: number; generation: string; mode: string; inconsistent: string; override: string;
  nodesize: number; sectorsize: number; features: string[]; statusFlags: string; enableGeneration: string;
  spaces: Record<"data" | "metadata" | "system", { profiles: string[]; disk_used: number; disk_total: number; bytes_used: number; bytes_reserved: number; bytes_may_use: number; bytes_pinned: number }>;
  qgroups: Record<string, PoolQgroup>;
  relations: [string, string][];
  subvolumes: { rootId: string; parentId: string; dirId: string; name: string }[];
  dropping: string[];
}
const digits = (value: unknown) => typeof value === "string" && /^[0-9]{1,20}$/.test(value);
const count = (value: unknown) => Number.isSafeInteger(value) && (value as number) >= 0;
export function parsePoolObservation(value: unknown): PoolObservation {
  const item = value as PoolObservation;
  const fail = (what: string): never => { throw new NativeBrainManagerError("unknown", `Reference pool allocation evidence is incomplete: ${what}.`); };
  if (!item || typeof item !== "object") fail("no observation");
  if (typeof item.stable !== "boolean" || !count(item.reads) || !digits(item.generation) || !digits(item.enableGeneration) || !digits(item.statusFlags)) fail("generation");
  for (const key of ["mode", "inconsistent", "override"] as const) if (typeof item[key] !== "string") fail(key);
  if (!count(item.nodesize) || !count(item.sectorsize) || !Array.isArray(item.features) || item.features.some(name => typeof name !== "string")) fail("features");
  for (const kind of ["data", "metadata", "system"] as const) {
    const space = item.spaces?.[kind];
    if (!space || !Array.isArray(space.profiles) || ["disk_used", "disk_total", "bytes_used", "bytes_reserved", "bytes_may_use", "bytes_pinned"].some(key => !count(space[key as keyof typeof space]))) fail(`${kind} space`);
  }
  if (!item.qgroups || typeof item.qgroups !== "object") fail("qgroups");
  for (const [id, qgroup] of Object.entries(item.qgroups))
    if (!/^[0-9]+\/[0-9]+$/.test(id) || ["referenced", "exclusive", "max_referenced", "max_exclusive", "limit_flags", "rsv_data", "rsv_meta_pertrans", "rsv_meta_prealloc"].some(key => !count(qgroup[key as keyof PoolQgroup]))) fail(`qgroup ${id}`);
  if (!Array.isArray(item.relations) || item.relations.some(pair => !Array.isArray(pair) || pair.length !== 2 || !pair.every(digits))) fail("qgroup relations");
  if (!Array.isArray(item.subvolumes) || item.subvolumes.some(root => !root || !digits(root.rootId) || !digits(root.parentId) || !digits(root.dirId) || typeof root.name !== "string")) fail("subvolume census");
  if (!Array.isArray(item.dropping) || !item.dropping.every(digits)) fail("dropping roots");
  return item;
}

/** Level-0 qgroup id in its sysfs/qgroup-show spelling. */
const level0 = (rootId: string) => `0/${rootId}`;
const relationId = (id: string) => { const [level, number] = id.split("/"); return String((BigInt(level!) << 48n) | BigInt(number!)); };
export const profileFactor = (profile: string) => profile === "single" ? 1 : profile === "dup" ? 2 : 0;
/**
 * Physical bytes one remaining owner-charged byte may still allocate: the worst
 * profile replication of the data or metadata it lands in, plus one eighth for
 * global trees (checksums, extent and free-space items) that squota charges to
 * no root. Native observations in the decision record bound the real ratio.
 */
export function poolReservationFactor(spaces: Pick<PoolObservation["spaces"], "data" | "metadata">): { numerator: number; denominator: number } {
  return { numerator: 8 * Math.max(profileFactor(spaces.data.profiles[0]!), profileFactor(spaces.metadata.profiles[0]!)) + 1, denominator: 8 };
}
export const reservePhysical = (bytes: number, factor: { numerator: number; denominator: number }) =>
  bytes <= 0 ? 0 : Math.ceil(bytes * factor.numerator / factor.denominator);

export interface PoolIntent extends NativePoolRecord {
  version: 1;
  fsid: string;
  /** Filesystem generation at reservation; an adopted root must be created at or after it. */
  reservedGeneration: string;
}

/** Owner-charged bytes: referenced allocation plus any pending kernel reservation. */
export const ownerCharge = (qgroup: PoolQgroup | undefined) => qgroup ? qgroup.referenced + qgroup.rsv_data + qgroup.rsv_meta_pertrans + qgroup.rsv_meta_prealloc : 0;

/**
 * Pure accounting over one stable observation. It refuses evidence it cannot
 * explain: unrecorded roots or qgroups, nested subvolumes, missing combined
 * membership, inconsistent or overridden quotas and unsupported profiles.
 */
export function referencePoolAccounting(input: {
  observation: PoolObservation; intents: PoolIntent[]; limits: QualifiedReferencePoolConfig;
  rootsDirId: string; emergencyAllocatedBytes: number;
  /** Directory inode of each reference view (#2429) that may hold its published sealed roots. */
  viewDirIds?: ReadonlyMap<string, string>;
  /** Directory inode of each open access generation (#2430) that may hold writable worktrees. */
  accessDirIds?: ReadonlyMap<string, string>;
}): { accounting: NonNullable<NativePoolStatus["accounting"]>; owner: Map<string, number>; refusal: NativePoolStatus["refusal"] } {
  const { observation, intents, limits } = input;
  let refusal: NativePoolStatus["refusal"] = null;
  const refuse = (code: NonNullable<NativePoolStatus["refusal"]>["code"], message: string) => { refusal ??= { code, message }; };
  if (!observation.stable) refuse("changing", "Reference pool allocation changed between consistent reads; retry once writers settle.");
  if (observation.mode !== "squota") refuse("unsupported", "Reference pool requires Btrfs simple quotas (squota); full qgroup accounting is not the qualified mechanism.");
  if (observation.inconsistent !== "0") refuse("unknown", "Reference pool quota accounting reports itself inconsistent.");
  if (observation.override !== "0") refuse("unsupported", "Reference pool quota_override would let privileged writers bypass allowances.");
  for (const feature of ["mixed_groups", "zoned", "raid56"]) if (observation.features.includes(feature)) refuse("unsupported", `Reference pool feature ${feature} is not qualified.`);
  if (!observation.features.includes("simple_quota")) refuse("unsupported", "Reference pool lacks the simple_quota incompat feature.");
  const spaces = {} as NonNullable<NativePoolStatus["accounting"]>["spaces"];
  for (const kind of ["data", "metadata", "system"] as const) {
    const space = observation.spaces[kind];
    if (space.profiles.length !== 1 || !profileFactor(space.profiles[0]!)) refuse("unsupported", `Reference pool ${kind} profile must be exactly one of single or dup; found ${space.profiles.join(",") || "none"}.`);
    spaces[kind] = { profile: (space.profiles[0] === "dup" ? "dup" : "single"), diskUsed: space.disk_used, diskTotal: space.disk_total, bytesUsed: space.bytes_used,
      bytesReserved: space.bytes_reserved, bytesMayUse: space.bytes_may_use, bytesPinned: space.bytes_pinned } satisfies NativePoolSpace;
  }
  const factor = poolReservationFactor(observation.spaces);
  // Pinned extents are freed but not yet reusable; reserved extents are allocated
  // but not yet accounted in bytes_used. Both still occupy physical space.
  const aggregate = (["data", "metadata", "system"] as const).reduce((sum, kind) => {
    const space = observation.spaces[kind], multiple = profileFactor(space.profiles[0] ?? "") || 2;
    return sum + space.disk_used + (space.bytes_pinned + space.bytes_reserved) * multiple;
  }, 0);
  // A fully dropped root id can be reused after remount; reclaimed identities no longer own one.
  const byRoot = new Map(intents.filter(intent => intent.root && intent.state !== "reclaimed").map(intent => [intent.root!.rootId, intent]));
  const combined = observation.qgroups[REFERENCE_POOL_QGROUP];
  if (!combined) refuse("unknown", `Reference pool combined qgroup ${REFERENCE_POOL_QGROUP} is missing.`);
  else if (combined.max_referenced !== limits.combinedLimitBytes || (combined.limit_flags & 3) !== 3)
    refuse("unknown", "Reference pool combined kernel limit differs from its configured allowance.");
  // Census first: a nested or impostor root is the precise reason, not its qgroup.
  for (const root of observation.subvolumes) {
    const intent = byRoot.get(root.rootId), place = poolPlace(root.dirId, input);
    if (root.parentId !== "5" || place === undefined)
      refuse("unknown", `Reference pool subvolume ${root.rootId} is nested or outside the managed roots directory; nested roots would escape their allowance.`);
    else if (!intent || intent.id !== root.name) refuse("unknown", `Reference pool subvolume ${root.name} has no recorded identity.`);
    else if (place.view !== (intent.view ?? null)) refuse("unknown", `Reference pool root ${intent.id} is outside its recorded view.`);
    else if (place.access !== (intent.access ?? null)) refuse("unknown", `Reference pool root ${intent.id} is outside its recorded access generation.`);
    else if (BigInt(intent.root!.otransid) < BigInt(observation.enableGeneration)) refuse("unknown", `Reference pool root ${intent.id} predates simple-quota enablement and is uncharged.`);
  }
  const live = new Set(observation.subvolumes.map(root => root.rootId)), dropping = new Set(observation.dropping);
  for (const intent of intents)
    if ((intent.state === "writable" || intent.state === "sealed") && !live.has(intent.root!.rootId) && !dropping.has(intent.root!.rootId))
      refuse("unknown", `Recorded reference pool root ${intent.id} is missing; release it to reconcile its identity.`);
  const members = new Set(observation.relations.filter(([, parent]) => parent === relationId(REFERENCE_POOL_QGROUP)).map(([child]) => child));
  for (const [child, parent] of observation.relations)
    if (parent !== relationId(REFERENCE_POOL_QGROUP)) refuse("unknown", `Reference pool has an unrecorded qgroup relation ${child}->${parent}.`);
  for (const id of Object.keys(observation.qgroups)) {
    if (id === REFERENCE_POOL_QGROUP || id === "0/5") continue;
    const [level, rootId] = id.split("/");
    // A fully dropped root can leave an empty level-0 qgroup behind; it holds nothing.
    if (level === "0" && !live.has(rootId!) && !dropping.has(rootId!) && ownerCharge(observation.qgroups[id]) === 0 && observation.qgroups[id]!.exclusive === 0) continue;
    if (level !== "0" || !byRoot.has(rootId!)) { refuse("unknown", `Reference pool qgroup ${id} has no recorded owner.`); continue; }
    if (!members.has(relationId(id))) refuse("unknown", `Reference pool root qgroup ${id} is outside the combined allowance.`);
  }
  const owner = new Map<string, number>();
  let ownerBytes = ownerCharge(observation.qgroups["0/5"]), pending = 0;
  for (const intent of intents) {
    const qgroup = intent.root && intent.state !== "reclaimed" ? observation.qgroups[level0(intent.root.rootId)] : undefined, charge = ownerCharge(qgroup);
    owner.set(intent.id, charge); ownerBytes += charge;
    // Kernel reservations (delalloc) are not yet in disk_used, so only referenced
    // allocation may replace a root's reservation; double-counting stays impossible.
    if (intent.state === "reserved" || intent.state === "writable") pending += reservePhysical(Math.max(0, intent.allowanceBytes - (qgroup?.referenced ?? 0)), factor);
    if (intent.state === "writable" && qgroup && (qgroup.max_referenced !== intent.allowanceBytes || (qgroup.limit_flags & 3) !== 3))
      refuse("unknown", `Reference pool root ${intent.id} lost its kernel allowance.`);
  }
  const charged = Math.max(0, aggregate - input.emergencyAllocatedBytes);
  const accounting = { basis: "btrfs-space-info-disk-used+simple-quota-owner" as const,
    observation: { generation: observation.generation, enableGeneration: observation.enableGeneration, reads: observation.reads },
    aggregateBytes: aggregate, emergencyAllocatedBytes: input.emergencyAllocatedBytes, chargedBytes: charged, ownerBytes,
    globalBytes: Math.max(0, aggregate - ownerBytes), spaces, pendingBytes: pending, reservationFactor: factor,
    availableBytes: limits.combinedLimitBytes - charged - pending };
  if (accounting.availableBytes < 0) refuse("capacity", "Reference pool allocation and reservations exceed the combined allowance; release or reclaim roots before new admission.");
  return { accounting, owner, refusal };
}

/** Which managed directory holds a root: roots (both null), one view or one access generation; undefined is unmanaged. */
function poolPlace(dirId: string, input: { rootsDirId: string; viewDirIds?: ReadonlyMap<string, string>; accessDirIds?: ReadonlyMap<string, string> })
  : { view: string | null; access: string | null } | undefined {
  if (dirId === input.rootsDirId) return { view: null, access: null };
  const view = input.viewDirIds?.get(dirId);
  if (view !== undefined) return { view, access: null };
  const access = input.accessDirIds?.get(dirId);
  return access === undefined ? undefined : { view: null, access };
}

/** Identity of the physical capacity a pool can still draw from. */
export interface PoolBacking { kind: "dedicated-device" | "sparse-loop"; deviceBytes: number; backingPath: string | null; backingAllocatedBytes: number | null; unbackedBytes: number }

export interface ReferencePoolContext {
  pool: QualifiedReferencePoolConfig;
  brain: { storePath: string; fsid: string; privatePaths: string[] };
  appGid: number;
  command(argv: string[], signal?: AbortSignal, permitFailure?: boolean): Promise<{ code: number; text: string; errors: string }>;
}

const unescapeMount = (text: string) => text.replace(/\\(040|011|012|134)/g, (_all, digits: string) => String.fromCharCode(parseInt(digits, 8)));
/** One read-write top-level mount of the pool device; aliases elsewhere would spend the same allowance unseen. */
export function referencePoolMount(mountinfo: string, pool: string, device: string): { options: string[] } {
  const rows = mountinfo.trim().split("\n").map(line => {
    const [left, right] = line.split(" - "), fields = left!.split(" "), fs = right?.split(" ");
    return { source: unescapeMount(fs?.[1] ?? ""), root: unescapeMount(fields[3] ?? ""), path: unescapeMount(fields[4] ?? ""), options: [...(fields[5] ?? "").split(","), ...(fs?.[2] ?? "").split(",")], type: fs?.[0] };
  });
  const mounted = rows.filter(row => row.path === pool);
  if (mounted.length !== 1 || mounted[0]!.type !== "btrfs" || mounted[0]!.root !== "/" || !mounted[0]!.options.includes("rw") || mounted[0]!.source !== device)
    throw new NativeBrainManagerError("unsupported", "Provision one read-write top-level Btrfs mount of the configured reference pool device.");
  // Btrfs reports anonymous per-subvolume st_dev numbers in mountinfo; the mount source names the volume.
  if (rows.some(row => row.source === device && row.path !== pool && !["/roots", "/views", "/access"].some(managed => row.root === managed || row.root.startsWith(managed + "/"))))
    throw new NativeBrainManagerError("unsupported", "The reference pool volume is also mounted outside its managed roots; one capacity must not be presented twice.");
  if (rows.some(row => row.path !== pool && inside(row.path, pool)))
    throw new NativeBrainManagerError("unsupported", "The reference pool must not contain nested mounts.");
  if (mounted[0]!.options.includes("user_subvol_rm_allowed"))
    throw new NativeBrainManagerError("unsupported", "Reference pool mounts must not let unprivileged users delete subvolumes.");
  return mounted[0]!;
}

export async function createNativeReferencePool(context: ReferencePoolContext) {
  const { pool } = context;
  const privateRoot = join(pool.storePath, ".reference-native"), state = join(privateRoot, "state"), emergency = join(privateRoot, "emergency"), roots = join(pool.storePath, "roots");
  // Reference views (#2429): one directory per sharing domain. A worker binds a
  // whole view, so a published root and its name swap stay visible to it.
  const views = join(pool.storePath, "views");
  // Access generations (#2430): one directory per worker generation. A worker
  // binds its whole generation, so a worktree moved into it appears there and
  // a parked one disappears, without a mount in the running namespace.
  const accessRoot = join(pool.storePath, "access");
  const rootPath = (id: string) => join(roots, id);
  const viewPath = (view: string) => join(views, view);
  const accessPath = (access: string) => join(accessRoot, access);
  /** A root lives in the roots directory until it is published into one view or held by one access generation. */
  const location = (intent: Pick<PoolIntent, "id" | "view"> & { access?: string | null }) =>
    intent.access ? join(accessPath(intent.access), intent.id) : intent.view ? join(viewPath(intent.view), intent.id) : rootPath(intent.id);
  let backing: PoolBacking | undefined, emergencyConsumed = false;
  const helper = async (args: string[], signal?: AbortSignal, permitFailure = false) => {
    const result = await context.command([PYTHON, "-I", "-S", "-c", POOL_HELPER, ...args], signal, permitFailure);
    return { ...result, value: result.text ? JSON.parse(result.text) : null };
  };
  function trusted(path: string, mode?: number) {
    const entry = lstatSync(path);
    if (!entry.isDirectory() || entry.uid !== 0 || (entry.mode & 0o022) || (mode !== undefined && (entry.mode & 0o777) !== mode))
      throw new NativeBrainManagerError("unsupported", `Reference pool requires a root-owned protected directory: ${path}`);
  }
  async function qualify(signal?: AbortSignal): Promise<PoolBacking> {
    for (let current = pool.storePath; ; current = dirname(current)) { trusted(current); if (current === "/") break; }
    if (realpathSync(pool.storePath) !== pool.storePath) throw new NativeBrainManagerError("unsupported", "Reference pool store path must be canonical.");
    const device = statSync(pool.devicePath, { bigint: true });
    if (!device.isBlockDevice()) throw new NativeBrainManagerError("unsupported", "Configure the reference pool's actual block device.");
    const major = Number((device.rdev >> 8n) & 0xfffn) + Number((device.rdev >> 32n) & 0xfffff000n), minor = Number(device.rdev & 0xffn) + Number((device.rdev >> 12n) & 0xffffff00n);
    const mount = referencePoolMount(readFileSync("/proc/self/mountinfo", "utf8"), pool.storePath, pool.devicePath);
    // Async discard returns freed sparse-backing blocks; synchronous discard would stall commits.
    if (mount.options.includes("discard") || mount.options.includes("discard=sync")) throw new NativeBrainManagerError("unsupported", "Reference pool must not use synchronous discard.");
    const top = JSON.parse((await context.command([PYTHON, "-I", "-S", "-c", POOL_HELPER, "inspect", pool.storePath], signal)).text);
    if (top.fsid !== pool.fsid || top.rootId !== "5" || top.devices !== 1) throw new NativeBrainManagerError("unsupported", "Reference pool fsid, top-level tree or single-device layout cannot be verified.");
    const sysDevice = `/sys/dev/block/${major}:${minor}`, members = readdirSync(`/sys/fs/btrfs/${pool.fsid}/devices`);
    if (members.length !== 1 || readFileSync(join(`/sys/fs/btrfs/${pool.fsid}/devices`, members[0]!, "dev"), "utf8").trim() !== `${major}:${minor}`)
      throw new NativeBrainManagerError("unsupported", "The configured reference pool device is not the volume's sole member.");
    const deviceBytes = Number(readFileSync(join(sysDevice, "size"), "utf8")) * 512;
    if (!Number.isSafeInteger(deviceBytes) || deviceBytes < pool.combinedLimitBytes + pool.emergencyBytes)
      throw new NativeBrainManagerError("unsupported", "Reference pool device is smaller than its combined allowance plus emergency allocation.");
    if (major === 7) {
      const path = readFileSync(join(sysDevice, "loop/backing_file"), "utf8").trim();
      if (!isAbsolute(path)) throw new NativeBrainManagerError("unsupported", "Reference pool loop backing identity is unavailable in this service namespace.");
      for (let current = dirname(path); ; current = dirname(current)) { trusted(current); if (current === "/") break; }
      const file = lstatSync(path, { bigint: true });
      if (!file.isFile() || file.uid !== 0n || file.nlink !== 1n || (file.mode & 0o077n) || Number(file.size) !== deviceBytes)
        throw new NativeBrainManagerError("unsupported", "Reference pool loop backing must be one root-owned private file of the device's exact size.");
      if (Number(readFileSync(join(sysDevice, "loop/offset"), "utf8")) !== 0 || Number(readFileSync(join(sysDevice, "loop/sizelimit"), "utf8")) !== 0)
        throw new NativeBrainManagerError("unsupported", "Reference pool loop offsets and size limits are unsupported.");
      const store = statSync(context.brain.storePath, { bigint: true });
      if (store.dev === file.dev) throw new NativeBrainManagerError("unsupported", "Reference pool backing must not draw from the brain store volume, whose writers do not share its headroom ledger.");
      const allocated = Number(file.blocks) * 512, unbacked = Math.max(0, deviceBytes - allocated);
      if (unbacked > 0) {
        if (!pool.headroomLedgerPath) throw new NativeBrainManagerError("unsupported", "Sparse reference pool backing requires headroomLedgerPath on its backing filesystem.");
        trusted(dirname(pool.headroomLedgerPath));
        if (statSync(dirname(pool.headroomLedgerPath), { bigint: true }).dev !== file.dev)
          throw new NativeBrainManagerError("unsupported", "The headroom ledger must live on the same physical backing filesystem as the pool backing.");
      }
      return backing = { kind: unbacked > 0 ? "sparse-loop" : "dedicated-device", deviceBytes, backingPath: path, backingAllocatedBytes: allocated, unbackedBytes: unbacked };
    }
    // Device-mapper, md, network and memory devices hide whether bytes are physically provisioned.
    if (![8, 179, 259].includes(major) || existsSync(join(sysDevice, "dm")) || existsSync(join(sysDevice, "md")))
      throw new NativeBrainManagerError("unsupported", "Reference pool needs a plain disk/partition or loop device whose physical provisioning can be verified.");
    return backing = { kind: "dedicated-device", deviceBytes, backingPath: null, backingAllocatedBytes: null, unbackedBytes: 0 };
  }
  await qualify();
  for (const [path, mode, gid] of [[privateRoot, 0o700, 0], [state, 0o700, 0], [roots, 0o750, context.appGid], [views, 0o750, context.appGid], [accessRoot, 0o750, context.appGid]] as const) {
    if (!existsSync(path)) { mkdirSync(path, { mode }); chownSync(path, 0, gid); chmodSync(path, mode); }
    trusted(path, mode);
  }
  const rootsDirId = String(statSync(roots, { bigint: true }).ino);
  for (const directory of [roots, views, accessRoot]) if (statSync(directory, { bigint: true }).dev !== statSync(pool.storePath, { bigint: true }).dev)
    throw new NativeBrainManagerError("unsupported", "Reference pool roots, views and access directories must live in the pool's top-level tree.");
  /** Directory inode → view identity for every manager-created view; anything else in views/ is unknown evidence. */
  function viewDirIds(): Map<string, string> {
    const result = new Map<string, string>();
    for (const name of readdirSync(views)) {
      if (!nativeCheckpointId.safeParse(name).success) throw new NativeBrainManagerError("unknown", `Reference pool views directory holds an unrecognized entry ${name}.`);
      trusted(viewPath(name), 0o755);
      result.set(String(statSync(viewPath(name), { bigint: true }).ino), name);
    }
    return result;
  }
  /** Directory inode → access generation for every manager-created access directory (#2430). */
  function accessDirIds(): Map<string, string> {
    const result = new Map<string, string>();
    for (const name of readdirSync(accessRoot)) {
      if (!nativeCheckpointId.safeParse(name).success) throw new NativeBrainManagerError("unknown", `Reference pool access directory holds an unrecognized entry ${name}.`);
      trusted(accessPath(name), 0o755);
      result.set(String(statSync(accessPath(name), { bigint: true }).ino), name);
    }
    return result;
  }
  // The combined kernel limit is configuration, reasserted at every start.
  await helper(["qgroup", pool.storePath, QGROUP_NUMBER, String(pool.combinedLimitBytes)]);
  const stateFd = openSync(state, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  async function ensureEmergency(signal?: AbortSignal) {
    if (!existsSync(emergency)) closeSync(openSync(emergency, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600));
    const item = lstatSync(emergency);
    if (!item.isFile() || item.uid !== 0 || item.nlink !== 1 || (item.mode & 0o077)) throw new NativeBrainManagerError("unsupported", "Reference pool emergency allocation must be one protected owned file.");
    if (item.size !== pool.emergencyBytes || item.blocks * 512 < pool.emergencyBytes) {
      await context.command(["/usr/bin/fallocate", "--length", String(pool.emergencyBytes), emergency], signal);
      const fd = openSync(emergency, constants.O_RDONLY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); }
    }
    const allocated = lstatSync(emergency);
    if (allocated.size !== pool.emergencyBytes || allocated.blocks * 512 < pool.emergencyBytes) throw new NativeBrainManagerError("capacity", "Reference pool emergency allocation could not be verified.");
    emergencyConsumed = false;
  }
  try { await ensureEmergency(); } catch (error) { if ((error as NativeBrainManagerError).code !== "capacity") { closeSync(stateFd); throw error; } emergencyConsumed = true; }

  function readIntent(id: string): PoolIntent | null {
    const path = join(state, `${id}.json`);
    if (!existsSync(path)) return null;
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      if (!info.isFile() || info.uid !== 0 || info.nlink !== 1 || info.size > NATIVE_CONTROL_BYTES) throw new NativeBrainManagerError("unknown", "Untrusted reference pool intent.");
      const intent = JSON.parse(readFileSync(fd, "utf8")) as PoolIntent;
      // Intents recorded before publication or access existed carry neither.
      intent.view ??= null;
      intent.access ??= null;
      const root = intent.root;
      if (intent.version !== 1 || intent.id !== id || intent.fsid !== pool.fsid || !STATES.includes(intent.state) || !PURPOSES.includes(intent.purpose)
        || (intent.from !== null && !nativeCheckpointId.safeParse(intent.from).success) || !page(intent.allowanceBytes) || !digits(intent.reservedGeneration)
        || (root !== null && (!digits(root?.rootId) || !/^[0-9a-f]{32}$/.test(root?.uuid ?? "") || !digits(root?.otransid)))
        || (intent.ownerBytes !== null && !count(intent.ownerBytes)) || (intent.reason !== null && typeof intent.reason !== "string")
        || (["writable", "sealed"].includes(intent.state) && root === null)
        || (intent.view !== null && (!nativeCheckpointId.safeParse(intent.view).success || ["reserved", "writable"].includes(intent.state)))
        || (intent.purpose === "checkpoint" && (intent.from === null || intent.state === "writable" || intent.view !== null))
        || (intent.access !== null && (!nativeCheckpointId.safeParse(intent.access).success || intent.purpose !== "worktree" || intent.view !== null
          || !["writable", "deleting"].includes(intent.state))))
        throw new NativeBrainManagerError("unknown", "Invalid reference pool intent.");
      return intent;
    } finally { closeSync(fd); }
  }
  async function writeIntent(intent: PoolIntent, recovery: boolean) {
    const destination = join(state, `${intent.id}.json`), temporary = join(state, `${intent.id}.tmp`), bytes = JSON.stringify(intent);
    if (Buffer.byteLength(bytes) > NATIVE_CONTROL_BYTES) throw new NativeBrainManagerError("unavailable", "Reference pool intent exceeded its durable bound.");
    const write = () => {
      if (existsSync(temporary)) unlinkSync(temporary);
      const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
      try { writeFileSync(fd, bytes); fsyncSync(fd); } finally { closeSync(fd); }
      renameSync(temporary, destination); fsyncSync(stateFd);
    };
    try { write(); }
    catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (!["ENOSPC", "EDQUOT"].includes(code ?? "")) throw new NativeBrainManagerError("unavailable", String(error));
      // Emergency allocation records recovery outcomes only; admission refuses instead.
      if (!recovery) throw new NativeBrainManagerError("capacity", "Reference pool cannot record a new reservation; nothing was admitted.");
      const fd = openSync(emergency, constants.O_WRONLY | constants.O_NOFOLLOW);
      try { ftruncateSync(fd, 0); fsyncSync(fd); } finally { closeSync(fd); }
      emergencyConsumed = true; await context.command([BTRFS, "filesystem", "sync", pool.storePath]);
      try { write(); } catch (again) { throw new NativeBrainManagerError("capacity", String(again)); }
    }
    try { index.remember(intent.id); }
    catch { throw new NativeBrainManagerError("unknown", "Reference pool intent is durable but recovery indexing failed; restart the manager to rebuild it."); }
  }
  const ids: string[] = [];
  for (const name of readdirSync(state)) {
    if (name.endsWith(".tmp")) continue;
    const id = name.slice(0, -5);
    if (!name.endsWith(".json") || !nativeCheckpointId.safeParse(id).success) { closeSync(stateFd); throw new NativeBrainManagerError("unknown", "Reference pool state contains an unrecognized identity."); }
    try { readIntent(id); } catch (error) { closeSync(stateFd); throw error; }
    ids.push(id);
  }
  const index = (() => { try { return new NativeRecoveryIndex(ids); } catch (error) { closeSync(stateFd); throw error; } })();
  // Startup reads every retained intent once; identities stay bounded by maxIdentities.
  const intents = new Map<string, PoolIntent>(ids.map(id => [id, readIntent(id)!]));
  // A publication interrupted between unseal and reseal leaves a sealed root writable.
  try {
    for (const intent of intents.values()) {
      if (intent.state !== "sealed") continue;
      // An interrupted publish may have moved the root before recording its view.
      const candidates = new Set([location(intent), rootPath(intent.id),
        ...readdirSync(views).filter(view => nativeCheckpointId.safeParse(view).success).map(view => join(viewPath(view), intent.id))]);
      for (const path of candidates) {
        if (!existsSync(path)) continue;
        const info = (await helper(["inspect", path])).value;
        if (info.rootId === intent.root?.rootId && info.uuid === intent.root?.uuid && !info.readOnly) await helper(["seal", path]);
      }
    }
  } catch (error) { index.close(); closeSync(stateFd); throw error; }

  async function observe(signal?: AbortSignal): Promise<PoolObservation> {
    const result = await helper(["observe", pool.storePath, pool.fsid, String(4 * pool.maxIdentities + 64)], signal);
    return parsePoolObservation(result.value);
  }
  async function physical(signal?: AbortSignal): Promise<NonNullable<NativePoolStatus["physical"]>> {
    const current = await qualify(signal);
    if (current.kind !== "sparse-loop") return { kind: current.kind, deviceBytes: current.deviceBytes, backingAllocatedBytes: current.backingAllocatedBytes, unbackedBytes: 0,
      backingAvailableBytes: null, otherConsumersBytes: null, headroomBytes: null };
    const ledger = (await helper(["ledger", pool.headroomLedgerPath!, `reference-pool:${pool.fsid}`, String(current.unbackedBytes), String(pool.physicalFloorBytes), dirname(current.backingPath!)], signal)).value;
    if (!count(ledger?.availableBytes) || !count(ledger?.otherBytes) || !Number.isSafeInteger(ledger?.headroomBytes))
      throw new NativeBrainManagerError("unknown", "Reference pool headroom ledger result is unreadable.");
    return { kind: current.kind, deviceBytes: current.deviceBytes, backingAllocatedBytes: current.backingAllocatedBytes, unbackedBytes: current.unbackedBytes,
      backingAvailableBytes: ledger.availableBytes, otherConsumersBytes: ledger.otherBytes, headroomBytes: ledger.headroomBytes };
  }
  /** Reconcile durable intents against one observation; only proven outcomes move state. */
  async function reconcile(observation: PoolObservation, places: { viewDirIds: ReadonlyMap<string, string>; accessDirIds: ReadonlyMap<string, string> }, signal?: AbortSignal): Promise<void> {
    const census = new Map(observation.subvolumes.map(root => [root.name, root]));
    for (const intent of [...intents.values()]) {
      // A publish, access, park or release interrupted between its rename and
      // its durable record: adopt the root's actual directory once its
      // identity is proven. Sealed roots only move between roots and views;
      // writable worktrees only between roots and access generations.
      const found = intent.root && intent.state !== "reserved" ? observation.subvolumes.find(root => root.rootId === intent.root!.rootId && root.name === intent.id) : undefined;
      const actual = found ? poolPlace(found.dirId, { rootsDirId, ...places }) : undefined;
      const moved = actual && (actual.view !== intent.view || actual.access !== intent.access);
      if (moved && ((intent.state === "sealed" && actual.access === null) || (intent.purpose === "worktree" && (intent.state === "writable" || intent.state === "deleting") && actual.view === null)
        || (intent.state === "deleting" && (actual.view === null || actual.access === null)))) {
        const adopted = await verifyRoot({ ...intent, ...actual }, signal);
        if (intent.state === "sealed" && !adopted.readOnly) await helper(["seal", location({ id: intent.id, ...actual })], signal);
        await commit({ ...intent, ...actual }, true);
        continue;
      }
      if (intent.state === "reserved") {
        const found = census.get(intent.id);
        if (!found) continue;
        // A create whose reply was lost: adopt only the root created in our directory after reservation.
        const info = (await helper(["inspect", rootPath(intent.id)], signal)).value;
        const checkpoint = intent.purpose === "checkpoint";
        if (info.rootId !== found.rootId || info.fsid !== pool.fsid || BigInt(info.otransid) < BigInt(intent.reservedGeneration) || info.readOnly !== checkpoint || info.parentUuid !== (intent.from ? intents.get(intent.from)?.root?.uuid : "0".repeat(32)))
          throw new NativeBrainManagerError("unknown", `Reference pool root ${intent.id} does not match its reservation; no adoption is authorized.`);
        await commit({ ...intent, state: checkpoint ? "sealed" : "writable", root: { rootId: info.rootId, uuid: info.uuid, otransid: info.otransid }, path: rootPath(intent.id), view: null, access: null }, true);
      } else if (intent.state === "deleted" && !intent.root) {
        // Never created: nothing was allocated, so nothing remains to reclaim.
        await commit({ ...intent, state: "reclaimed", ownerBytes: 0 }, true);
      } else if ((intent.state === "deleting" || intent.state === "deleted") && intent.root) {
        const present = observation.subvolumes.some(root => root.rootId === intent.root!.rootId), dropping = observation.dropping.includes(intent.root.rootId);
        const qgroup = observation.qgroups[level0(intent.root.rootId)];
        if (intent.state === "deleting" && !present && !dropping) await commit({ ...intent, state: "deleted", path: null, ownerBytes: ownerCharge(qgroup), access: null }, true);
        const current = intents.get(intent.id)!;
        // Credit only after the cleaner dropped the root and squota shows no retained owner charge.
        if (current.state === "deleted" && !present && !dropping && observation.stable && (!qgroup || ownerCharge(qgroup) === 0))
          await commit({ ...current, state: "reclaimed", ownerBytes: 0, reason: null }, true);
        // Keep the qgroup census bounded; the kernel refuses this while any usage or root item remains.
        if (intents.get(intent.id)!.state === "reclaimed" && qgroup) await helper(["qgroup-remove", pool.storePath, current.root!.rootId], signal, true);
        else if (current.state === "deleted" && qgroup && ownerCharge(qgroup) !== current.ownerBytes)
          await commit({ ...current, ownerBytes: ownerCharge(qgroup), reason: "Shared extents still referenced by other roots retain this allocation." }, true);
      }
      // Rootless refusals and checkpoints reclaimed before a restart are forgotten too. A
      // qgroup a crash left behind holds nothing once reclaimed; removal is best effort,
      // and an empty leftover qgroup is ignored by accounting.
      const settled = intents.get(intent.id);
      if (settled?.purpose === "checkpoint" && settled.state === "reclaimed") {
        if (settled.root && observation.qgroups[level0(settled.root.rootId)]) await helper(["qgroup-remove", pool.storePath, settled.root.rootId], signal, true);
        forget(intent.id);
      }
    }
  }
  async function commit(intent: PoolIntent, recovery: boolean) { await writeIntent(intent, recovery); intents.set(intent.id, intent); }
  /**
   * A worktree takes a checkpoint at every journal observation (#2430):
   * reclaimed checkpoint identities are forgotten, whatever led there, so they
   * never exhaust the identity bound. This manager remembers them for the rest
   * of its life: a retried release still reads as reclaimed, and the identity
   * is never created again.
   */
  const forgottenPath = join(privateRoot, "forgotten.json");
  const forgotten = new Set<string>(loadForgotten());
  /** The most recent forgotten identities survive a restart, so a release retried after one still reads as reclaimed. */
  function loadForgotten(): string[] {
    if (!existsSync(forgottenPath)) return [];
    const fd = openSync(forgottenPath, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = fstatSync(fd);
      const ids = info.isFile() && info.uid === 0 && info.nlink === 1 && info.size <= NATIVE_CONTROL_BYTES ? JSON.parse(readFileSync(fd, "utf8")) : null;
      if (!Array.isArray(ids) || ids.length > REFERENCE_POOL_FORGOTTEN || ids.some(id => !nativeCheckpointId.safeParse(id).success))
        throw new NativeBrainManagerError("unknown", "Reference pool forgotten checkpoint record is untrusted.");
      return ids;
    } finally { closeSync(fd); }
  }
  function forget(id: string) {
    forgotten.delete(id); forgotten.add(id);
    while (forgotten.size > REFERENCE_POOL_FORGOTTEN) forgotten.delete(forgotten.values().next().value!);
    const temporary = `${forgottenPath}.tmp`;
    if (existsSync(temporary)) unlinkSync(temporary);
    const fd = openSync(temporary, constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW, 0o600);
    try { writeFileSync(fd, JSON.stringify([...forgotten])); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(temporary, forgottenPath); syncDirectory(privateRoot);
    unlinkSync(join(state, `${id}.json`)); fsyncSync(stateFd);
    intents.delete(id); index.forget(id);
  }
  function emergencyAllocated(dataFactor: number): number {
    try { return lstatSync(emergency).blocks * 512 * dataFactor; } catch { return 0; }
  }
  async function measure(signal?: AbortSignal) {
    const observation = await observe(signal), places = { viewDirIds: viewDirIds(), accessDirIds: accessDirIds() };
    await reconcile(observation, places, signal);
    const result = referencePoolAccounting({ observation, intents: [...intents.values()], limits: pool, rootsDirId, ...places,
      emergencyAllocatedBytes: emergencyAllocated(profileFactor(observation.spaces.data.profiles[0] ?? "") || 1) });
    return { observation, ...result };
  }
  function counts(): NativePoolStatus["counts"] {
    const result = Object.fromEntries(STATES.map(state => [state, 0])) as NativePoolStatus["counts"];
    for (const intent of intents.values()) result[intent.state]++;
    return result;
  }
  async function status(signal?: AbortSignal): Promise<NativePoolStatus> {
    const base = { fsid: pool.fsid, limits: { combinedBytes: pool.combinedLimitBytes, operationBytes: pool.operationLimitBytes, emergencyBytes: pool.emergencyBytes,
      physicalFloorBytes: pool.physicalFloorBytes, maxIdentities: pool.maxIdentities }, counts: counts(), identities: intents.size };
    let physicalView: NativePoolStatus["physical"] = null;
    try {
      physicalView = await physical(signal);
      const measured = await measure(signal);
      let refusal = measured.refusal;
      if (!refusal && emergencyConsumed) refusal = { code: "capacity", message: "Reference pool recovery consumed its emergency allocation; free capacity and restart to rearm it." };
      if (!refusal && physicalView.headroomBytes !== null && physicalView.headroomBytes < 0)
        refusal = { code: "capacity", message: "Physical backing free space no longer covers the pool's unbacked capacity, other ledger consumers and the recovery floor." };
      return { ...base, counts: counts(), identities: intents.size, qualified: refusal === null, refusal, accounting: measured.accounting, physical: physicalView };
    } catch (error) {
      if (!(error instanceof NativeBrainManagerError)) throw error;
      if (error.code === "unavailable") throw error;
      return { ...base, qualified: false, refusal: { code: error.code === "capacity" ? "capacity" : error.code === "unsupported" ? "unsupported" : "unknown", message: error.message },
        accounting: null, physical: physicalView };
    }
  }
  function publicRecord(intent: PoolIntent, owner?: number): NativePoolRecord {
    return { id: intent.id, purpose: intent.purpose, from: intent.from, allowanceBytes: intent.allowanceBytes, state: intent.state, root: intent.root,
      path: intent.state === "writable" || intent.state === "sealed" ? location(intent) : null, ownerBytes: owner ?? intent.ownerBytes, reason: intent.reason, view: intent.view,
      access: intent.access };
  }
  async function verifyRoot(intent: PoolIntent, signal?: AbortSignal) {
    const info = (await helper(["inspect", location(intent)], signal)).value;
    if (!intent.root || info.fsid !== pool.fsid || info.rootId !== intent.root.rootId || info.uuid !== intent.root.uuid || info.otransid !== intent.root.otransid || info.parentId !== "5")
      throw new NativeBrainManagerError("unknown", "Recorded reference pool root identity changed; no use or deletion is authorized.");
    return info as { readOnly: boolean; ctransid: string; parentUuid: string };
  }
  async function create(request: { id: string; purpose: NativePoolRecord["purpose"]; from: string | null; allowanceBytes: number }, signal?: AbortSignal): Promise<NativePoolRecord> {
    if ((request.purpose as string) === "checkpoint") throw new NativeBrainManagerError("invalid", "Worktree checkpoints are created only from their writable worktree.");
    if (!page(request.allowanceBytes) || request.allowanceBytes > pool.operationLimitBytes)
      throw new NativeBrainManagerError("capacity", "Requested reference allowance exceeds the configured per-operation allowance; nothing ran.");
    const existing = intents.get(request.id);
    if (existing && (existing.purpose !== request.purpose || existing.from !== request.from || existing.allowanceBytes !== request.allowanceBytes))
      throw new NativeBrainManagerError("invalid", "An existing reference pool identity cannot change its purpose, source or allowance.");
    if (existing && ["deleting", "deleted", "reclaimed"].includes(existing.state)) throw new NativeBrainManagerError("released", "This reference pool identity was released; it cannot be recreated.");
    const measured = await measure(signal), refreshed = intents.get(request.id);
    if (refreshed?.state === "writable" || refreshed?.state === "sealed") { await verifyRoot(refreshed, signal); return publicRecord(refreshed, measured.owner.get(refreshed.id)); }
    if (measured.refusal) throw new NativeBrainManagerError(measured.refusal.code === "changing" ? "unavailable" : measured.refusal.code === "capacity" ? "capacity" : measured.refusal.code === "unsupported" ? "unsupported" : "unknown", measured.refusal.message);
    if (!refreshed) {
      if (emergencyConsumed) throw new NativeBrainManagerError("capacity", "Reference pool recovery consumed its emergency allocation; admission refuses until it is rearmed.");
      if (intents.size >= pool.maxIdentities) throw new NativeBrainManagerError("capacity", "Reference pool retained identities reached their configured bound; nothing was admitted.");
      if (existsSync(rootPath(request.id))) throw new NativeBrainManagerError("unknown", "Unrecorded reference pool storage occupies this identity.");
      if (request.from !== null) {
        const source = intents.get(request.from);
        if (!source || source.state !== "sealed" || source.purpose === "checkpoint") throw new NativeBrainManagerError("unknown", "A reference snapshot requires one retained sealed pool root.");
      }
      const physicalView = await physical(signal);
      if (physicalView.headroomBytes !== null && physicalView.headroomBytes < 0)
        throw new NativeBrainManagerError("capacity", "Physical backing headroom does not cover the reference pool and other ledger consumers; nothing was admitted.");
      const needed = reservePhysical(request.allowanceBytes, measured.accounting.reservationFactor);
      if (needed > measured.accounting.availableBytes)
        throw new NativeBrainManagerError("capacity", `Reference pool combined allowance cannot reserve ${needed} physical bytes (${measured.accounting.availableBytes} available); nothing was admitted.`);
      await commit({ version: 1, fsid: pool.fsid, id: request.id, purpose: request.purpose, from: request.from, allowanceBytes: request.allowanceBytes, state: "reserved",
        root: null, path: null, ownerBytes: null, reason: null, view: null, access: null, reservedGeneration: measured.observation.generation }, false);
    }
    const reserved = intents.get(request.id)!;
    signal?.throwIfAborted();
    const source = reserved.from ? intents.get(reserved.from)! : null;
    if (source) { const info = await verifyRoot(source, signal); if (!info.readOnly) throw new NativeBrainManagerError("unknown", "Reference snapshot source is no longer sealed."); }
    const made = await helper(["create", roots, reserved.id, String(reserved.allowanceBytes), QGROUP_NUMBER, source ? location(source) : "-"], signal, true);
    if (made.code === 3) {
      // A known refusal created nothing; the identity stays fenced and its charge is released.
      await commit({ ...reserved, state: "deleted", reason: `Reference pool root creation refused: ${made.value.error}.`, ownerBytes: 0 }, true);
      throw new NativeBrainManagerError("capacity", `Reference pool root creation refused with ${made.value.error}; the reservation was released.`);
    }
    if (made.code !== 0) throw new NativeBrainManagerError("unknown", `Reference pool root creation outcome is unknown; its reservation remains charged. ${made.errors.trim()}`);
    const info = made.value;
    if (info.fsid !== pool.fsid || info.parentId !== "5" || info.readOnly || BigInt(info.otransid) < BigInt(reserved.reservedGeneration))
      throw new NativeBrainManagerError("unknown", "Created reference pool root identity cannot be verified; its reservation remains charged.");
    // The app's acquisition writers fill a writable root through its group (#2429).
    chownSync(rootPath(reserved.id), 0, context.appGid); chmodSync(rootPath(reserved.id), 0o770);
    const writable: PoolIntent = { ...reserved, state: "writable", root: { rootId: info.rootId, uuid: info.uuid, otransid: info.otransid }, path: rootPath(reserved.id) };
    await commit(writable, true);
    return publicRecord(writable, 0);
  }
  async function seal(id: string, signal?: AbortSignal): Promise<NativePoolRecord> {
    let intent = intents.get(id);
    if (!intent) throw new NativeBrainManagerError("unknown", "This reference pool identity has no recorded intent.");
    if (intent.state === "reserved") { await measure(signal); intent = intents.get(id)!; }
    if (intent.state === "sealed") { await verifyRoot(intent, signal); return publicRecord(intent); }
    if (intent.state !== "writable") throw new NativeBrainManagerError("released", "Only a writable reference pool root can be sealed.");
    await verifyRoot(intent, signal);
    // Readers under any worker identity may traverse a sealed root; its writers lose group write.
    const sealing = lstatSync(rootPath(id));
    if (!sealing.isDirectory() || sealing.uid !== 0) throw new NativeBrainManagerError("unknown", "Reference pool root top directory changed ownership.");
    if ((sealing.mode & 0o7777) !== 0o755) { chownSync(rootPath(id), 0, 0); chmodSync(rootPath(id), 0o755); }
    // Read-only first: no owned work can grow the root while its use is measured.
    await helper(["seal", rootPath(id)], signal);
    const measured = await measure(signal);
    if (!measured.observation.stable) throw new NativeBrainManagerError("unavailable", "Reference pool allocation is still changing; the root stays charged at its allowance until a stable seal.");
    const qgroup = measured.observation.qgroups[level0(intent.root!.rootId)];
    if (!qgroup) throw new NativeBrainManagerError("unknown", "Sealed reference pool root has no owner accounting.");
    const sealed: PoolIntent = { ...intent, state: "sealed", ownerBytes: ownerCharge(qgroup) };
    await commit(sealed, true);
    return publicRecord(sealed);
  }
  async function syncDeleted(rootId: string, signal?: AbortSignal) {
    let settled = false;
    const sync = context.command([BTRFS, "subvolume", "sync", pool.storePath, rootId], signal);
    const done = sync.then(() => { settled = true; }, () => { settled = true; });
    const wakes = new AbortController(), wakeSignal = signal ? AbortSignal.any([signal, wakes.signal]) : wakes.signal;
    while (!settled) {
      await Promise.race([done, Bun.sleep(RECLAIM_WAKE_MS)]);
      if (settled) break;
      const wake = context.command([BTRFS, "filesystem", "sync", pool.storePath], wakeSignal, true).then(() => {}, () => {});
      await Promise.race([done, wake]);
      if (settled) { wakes.abort(); await wake; }
    }
    await sync;
  }
  async function release(id: string, signal?: AbortSignal): Promise<NativePoolRecord> {
    let intent = intents.get(id);
    // A retry after its reply was lost: the checkpoint was reclaimed and forgotten.
    if (!intent && forgotten.has(id)) return { id, purpose: "checkpoint", from: null, allowanceBytes: REFERENCE_POOL_CHECKPOINT_BYTES, state: "reclaimed", root: null, path: null,
      ownerBytes: 0, reason: null, view: null, access: null };
    if (!intent) {
      // Fence a lost or never-arrived create with its generated identity.
      if (existsSync(rootPath(id))) throw new NativeBrainManagerError("unknown", "Unrecorded reference pool storage cannot be released.");
      const generation = (await observe(signal)).generation;
      await commit({ version: 1, fsid: pool.fsid, id, purpose: "source", from: null, allowanceBytes: 4096, state: "deleted", root: null, path: null, ownerBytes: 0,
        reason: "Released before any reservation was recorded.", view: null, access: null, reservedGeneration: generation }, true);
      return publicRecord(intents.get(id)!);
    }
    if ([...intents.values()].some(other => other.from === id && (other.state === "reserved" && !other.root)))
      throw new NativeBrainManagerError("unavailable", "A pending reference snapshot is still being created from this root.");
    // Requests run one at a time, so this refusal is atomic with grants (#2729): no
    // caller, in this process or another, deletes a worktree a generation holds.
    if (intent.state === "writable" && intent.access)
      throw new NativeBrainManagerError("invalid", "This worktree is held by an access generation; park it before releasing it.");
    if (intent.state === "reserved") {
      await measure(signal); intent = intents.get(id)!;
      if (intent.state === "reserved") { await commit({ ...intent, state: "deleted", ownerBytes: 0, reason: "Released before its root was created." }, true); return publicRecord(intents.get(id)!); }
    }
    if (intent.state === "writable" || intent.state === "sealed") {
      const observed = await observe(signal);
      const present = observed.subvolumes.some(root => root.rootId === intent!.root!.rootId) || observed.dropping.includes(intent.root!.rootId);
      // A vanished root needs no delete; an impostor at its path is never deleted.
      if (present || existsSync(location(intent))) await verifyRoot(intent, signal);
      await commit({ ...intent, state: "deleting", path: null }, true);
      intent = intents.get(id)!;
    }
    if (intent.state === "deleting") {
      signal?.throwIfAborted();
      // Its published names go first: no reader resolves a name to a root being deleted.
      if (intent.view) unlinkNames(intent.view, id);
      if (existsSync(location(intent)) && (await observe(signal)).subvolumes.some(root => root.rootId === intent!.root!.rootId)) {
        await verifyRoot(intent, signal);
        await context.command([BTRFS, "subvolume", "delete", "--commit-after", location(intent)], signal);
      }
      // A retained descriptor, cwd or mount keeps the root alive: the deadline expires and its charge stays.
      await syncDeleted(intent.root!.rootId, signal);
    }
    const last = intents.get(id)!;
    await measure(signal);
    // A reclaimed checkpoint is forgotten by the measurement that proved it.
    return publicRecord(intents.get(id) ?? { ...last, state: "reclaimed", path: null, ownerBytes: 0, access: null });
  }
  /** Remove every name in one view that resolves to `id`; other entries are left alone. */
  function unlinkNames(view: string, id: string) {
    if (!existsSync(viewPath(view))) return;
    let removed = false;
    for (const name of readdirSync(viewPath(view))) {
      const entry = join(viewPath(view), name);
      if (lstatSync(entry).isSymbolicLink() && readlinkSync(entry) === id) { unlinkSync(entry); removed = true; }
    }
    if (removed) syncDirectory(viewPath(view));
  }
  function syncDirectory(path: string) { const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW); try { fsyncSync(fd); } finally { closeSync(fd); } }
  function ensureView(view: string) {
    if (!existsSync(viewPath(view))) { mkdirSync(viewPath(view), { mode: 0o755 }); chownSync(viewPath(view), 0, 0); chmodSync(viewPath(view), 0o755); syncDirectory(views); }
    trusted(viewPath(view), 0o755);
  }
  /**
   * Publish one sealed source root under `name` in `view` (#2429). The root
   * moves into the view's directory once; the name is then replaced by a
   * single rename, so a reader that binds the view resolves either the whole
   * previous root or the whole new one, never staging.
   */
  async function publish(request: { id: string; view: string; name: string }, signal?: AbortSignal): Promise<NativePoolRecord> {
    nativePoolName.parse(request.name);
    let intent = intents.get(request.id);
    if (!intent || intent.purpose !== "source") throw new NativeBrainManagerError("unknown", "Only a recorded reference source root can be published.");
    if (intent.state !== "sealed") throw new NativeBrainManagerError(["deleting", "deleted", "reclaimed"].includes(intent.state) ? "released" : "invalid", "Only a sealed reference source root can be published.");
    if (intent.view && intent.view !== request.view) throw new NativeBrainManagerError("invalid", "A published reference root belongs to exactly one view.");
    await verifyRoot(intent, signal);
    ensureView(request.view);
    if (!intent.view) intent = await move(intent, request.view, signal);
    // Every publication, including a retry after an interrupted reseal, exposes only a read-only root.
    if (!(await verifyRoot(intent, signal)).readOnly) {
      await helper(["seal", location(intent)], signal);
      if (!(await verifyRoot(intent, signal)).readOnly) throw new NativeBrainManagerError("unknown", "A published reference root did not reseal.");
    }
    const name = join(viewPath(request.view), request.name), temporary = join(viewPath(request.view), `.${request.name}.${randomUUID()}`);
    if (existsSync(name) && !lstatSync(name).isSymbolicLink()) throw new NativeBrainManagerError("unknown", "A reference view name is occupied by something other than a published name.");
    symlinkSync(intent.id, temporary);
    try { renameSync(temporary, name); } catch (error) { unlinkSync(temporary); throw error; }
    syncDirectory(viewPath(request.view));
    return publicRecord(intent);
  }
  /**
   * Move a sealed root between the masked roots directory and one view. Btrfs
   * refuses to move a read-only subvolume; the root's top directory is
   * root-owned and its writers already finished, so it is unsealed only for the
   * rename and resealed before this serialized request returns. Startup
   * reseals an interrupted one, and measurement adopts its actual directory.
   */
  async function move(intent: PoolIntent, view: string | null, signal?: AbortSignal): Promise<PoolIntent> {
    const from = location(intent), to = location({ id: intent.id, view });
    if (existsSync(to)) throw new NativeBrainManagerError("unknown", "Unrecorded storage occupies this root's destination.");
    await helper(["unseal", from], signal);
    try { renameSync(from, to); }
    finally { await helper(["seal", existsSync(to) ? to : from]); }
    syncDirectory(dirname(from)); syncDirectory(dirname(to));
    await commit({ ...intent, view }, true);
    const moved = intents.get(intent.id)!;
    if (!(await verifyRoot(moved, signal)).readOnly) throw new NativeBrainManagerError("unknown", "A moved reference root did not reseal.");
    return moved;
  }
  /**
   * Create one read-only checkpoint of a writable worktree (#2430). The
   * snapshot shares every extent with the worktree; its deltas feed the
   * worktree's own journal observer, never the brain's.
   */
  async function checkpoint(request: { id: string; from: string }, signal?: AbortSignal): Promise<NativePoolCheckpoint> {
    const existing = intents.get(request.id);
    if (existing && (existing.purpose !== "checkpoint" || existing.from !== request.from))
      throw new NativeBrainManagerError("invalid", "An existing reference pool identity cannot change its purpose or source.");
    if ((existing && ["deleting", "deleted", "reclaimed"].includes(existing.state)) || forgotten.has(request.id))
      throw new NativeBrainManagerError("released", "This reference pool identity was released; it cannot be recreated.");
    if (existing?.state === "sealed") return checkpointRecord(existing, signal);
    const worktree = intents.get(request.from);
    if (!worktree || worktree.purpose !== "worktree" || worktree.state !== "writable")
      throw new NativeBrainManagerError("unknown", "A worktree checkpoint requires one retained writable worktree root.");
    const measured = await measure(signal), refreshed = intents.get(request.id);
    if (refreshed?.state === "sealed") return checkpointRecord(refreshed, signal);
    if (measured.refusal) throw new NativeBrainManagerError(measured.refusal.code === "changing" ? "unavailable" : measured.refusal.code === "capacity" ? "capacity" : measured.refusal.code === "unsupported" ? "unsupported" : "unknown", measured.refusal.message);
    if (!refreshed) {
      if (emergencyConsumed) throw new NativeBrainManagerError("capacity", "Reference pool recovery consumed its emergency allocation; admission refuses until it is rearmed.");
      if (intents.size >= pool.maxIdentities) throw new NativeBrainManagerError("capacity", "Reference pool retained identities reached their configured bound; nothing was admitted.");
      if (existsSync(rootPath(request.id))) throw new NativeBrainManagerError("unknown", "Unrecorded reference pool storage occupies this identity.");
      const physicalView = await physical(signal);
      if (physicalView.headroomBytes !== null && physicalView.headroomBytes < 0)
        throw new NativeBrainManagerError("capacity", "Physical backing headroom does not cover the reference pool and other ledger consumers; nothing was admitted.");
      const needed = reservePhysical(REFERENCE_POOL_CHECKPOINT_BYTES, measured.accounting.reservationFactor);
      if (needed > measured.accounting.availableBytes)
        throw new NativeBrainManagerError("capacity", `Reference pool combined allowance cannot reserve ${needed} physical bytes for a checkpoint (${measured.accounting.availableBytes} available); nothing was admitted.`);
      await commit({ version: 1, fsid: pool.fsid, id: request.id, purpose: "checkpoint", from: request.from, allowanceBytes: REFERENCE_POOL_CHECKPOINT_BYTES, state: "reserved",
        root: null, path: null, ownerBytes: null, reason: null, view: null, access: null, reservedGeneration: measured.observation.generation }, false);
    }
    const reserved = intents.get(request.id)!;
    signal?.throwIfAborted();
    const source = intents.get(request.from)!;
    if ((await verifyRoot(source, signal)).readOnly) throw new NativeBrainManagerError("unknown", "A worktree checkpoint source is no longer writable.");
    const made = await helper(["create", roots, reserved.id, String(reserved.allowanceBytes), QGROUP_NUMBER, location(source), "readonly"], signal, true);
    if (made.code === 3) {
      await commit({ ...reserved, state: "deleted", reason: `Reference pool checkpoint creation refused: ${made.value.error}.`, ownerBytes: 0 }, true);
      throw new NativeBrainManagerError("capacity", `Reference pool checkpoint creation refused with ${made.value.error}; the reservation was released.`);
    }
    if (made.code !== 0) throw new NativeBrainManagerError("unknown", `Reference pool checkpoint creation outcome is unknown; its reservation remains charged. ${made.errors.trim()}`);
    const info = made.value;
    if (info.fsid !== pool.fsid || info.parentId !== "5" || !info.readOnly || info.parentUuid !== source.root!.uuid || BigInt(info.otransid) < BigInt(reserved.reservedGeneration))
      throw new NativeBrainManagerError("unknown", "Created reference pool checkpoint identity cannot be verified; its reservation remains charged.");
    const sealed: PoolIntent = { ...reserved, state: "sealed", root: { rootId: info.rootId, uuid: info.uuid, otransid: info.otransid }, path: rootPath(reserved.id) };
    await commit(sealed, true);
    return { ...publicRecord(sealed), purpose: "checkpoint", state: "sealed", transaction: info.ctransid, readOnly: true };
  }
  async function checkpointRecord(intent: PoolIntent, signal?: AbortSignal): Promise<NativePoolCheckpoint> {
    const info = await verifyRoot(intent, signal);
    if (!info.readOnly) throw new NativeBrainManagerError("unknown", "A worktree checkpoint is no longer read-only.");
    return { ...publicRecord(intent), purpose: "checkpoint", state: "sealed", transaction: info.ctransid, readOnly: true };
  }
  /** One retained sealed checkpoint, verified, for a fixed worker-UID read or a delta endpoint. */
  async function checkpointPath(id: string, signal?: AbortSignal): Promise<{ path: string; from: string }> {
    const intent = intents.get(id);
    if (!intent || intent.purpose !== "checkpoint" || intent.state !== "sealed")
      throw new NativeBrainManagerError("unknown", "Worktree checkpoint reading requires one retained sealed checkpoint identity.");
    await checkpointRecord(intent, signal);
    return { path: location(intent), from: intent.from! };
  }
  /** Both ends of a worktree delta: two sealed checkpoints of the same worktree, never another root. */
  async function deltaRoots(from: string, to: string, signal?: AbortSignal): Promise<{ from: string; to: string }> {
    const before = await checkpointPath(from, signal), after = await checkpointPath(to, signal);
    if (before.from !== after.from) throw new NativeBrainManagerError("invalid", "A worktree delta compares two checkpoints of the same worktree.");
    return { from: before.path, to: after.path };
  }
  function ensureAccess(access: string) {
    if (!existsSync(accessPath(access))) { mkdirSync(accessPath(access), { mode: 0o755 }); chownSync(accessPath(access), 0, 0); chmodSync(accessPath(access), 0o755); syncDirectory(accessRoot); }
    trusted(accessPath(access), 0o755);
  }
  const held = (access: string) => [...intents.values()].filter(intent => intent.access === access && intent.state === "writable").map(intent => intent.id).sort();
  /** Open one access generation (#2430): an empty root-owned directory its worker binds whole. */
  function accessOpen(access: string): NativePoolAccess {
    ensureAccess(access);
    return { access, path: accessPath(access), roots: held(access) };
  }
  /**
   * Move one writable worktree into an open access generation. The worker
   * bound to that generation sees it on its next path lookup; no mount is
   * added to a running namespace. A worktree held by another generation must
   * be parked first, so a stale generation can never keep or take a grant.
   */
  async function grant(request: { id: string; access: string }, signal?: AbortSignal): Promise<NativePoolRecord> {
    const intent = intents.get(request.id);
    if (!intent || intent.purpose !== "worktree") throw new NativeBrainManagerError("unknown", "Only a recorded worktree root can be made accessible.");
    if (intent.state !== "writable") throw new NativeBrainManagerError(["deleting", "deleted", "reclaimed"].includes(intent.state) ? "released" : "invalid", "Only a writable worktree can be made accessible.");
    if (intent.access === request.access) { await verifyRoot(intent, signal); return publicRecord(intent); }
    if (intent.access) throw new NativeBrainManagerError("invalid", "This worktree is held by another access generation; park it first.");
    if (!existsSync(accessPath(request.access))) throw new NativeBrainManagerError("unavailable", "This access generation is not open.");
    trusted(accessPath(request.access), 0o755);
    await verifyRoot(intent, signal);
    return publicRecord(await relocate(intent, request.access, signal));
  }
  /** Return a worktree to the masked roots directory; its generation no longer reaches it by name or identity. */
  async function park(id: string, signal?: AbortSignal): Promise<NativePoolRecord> {
    const intent = intents.get(id);
    if (!intent || intent.purpose !== "worktree") throw new NativeBrainManagerError("unknown", "Only a recorded worktree root can be parked.");
    if (!intent.access) return publicRecord(intent);
    await verifyRoot(intent, signal);
    return publicRecord(await relocate(intent, null, signal));
  }
  /** Park everything an access generation holds and remove its directory. */
  async function accessClose(access: string, signal?: AbortSignal): Promise<NativePoolAccess> {
    const parked = held(access);
    for (const id of parked) await park(id, signal);
    if (existsSync(accessPath(access))) {
      trusted(accessPath(access), 0o755);
      const left = readdirSync(accessPath(access));
      if (left.length) throw new NativeBrainManagerError("unknown", "An access generation holds unrecorded entries; it is not removed.");
      rmdirSync(accessPath(access)); syncDirectory(accessRoot);
    }
    return { access, path: accessPath(access), roots: parked };
  }
  /** Writable worktrees rename freely; Btrfs refuses only read-only subvolume moves. */
  async function relocate(intent: PoolIntent, access: string | null, signal?: AbortSignal): Promise<PoolIntent> {
    const from = location(intent), to = location({ id: intent.id, view: null, access });
    if (existsSync(to)) throw new NativeBrainManagerError("unknown", "Unrecorded storage occupies this root's destination.");
    renameSync(from, to);
    syncDirectory(dirname(from)); syncDirectory(dirname(to));
    await commit({ ...intent, access }, true);
    const moved = intents.get(intent.id)!;
    if ((await verifyRoot(moved, signal)).readOnly) throw new NativeBrainManagerError("unknown", "A moved worktree became read-only.");
    return moved;
  }
  /**
   * Withdraw one published root from its view (#2429): its names go first, then
   * the root returns to the masked roots directory, so no reader of the view
   * can reach it by name or identity. Open files and working directories keep
   * what they already hold; the root stays charged until released.
   */
  async function withdraw(id: string, signal?: AbortSignal): Promise<NativePoolRecord> {
    const intent = intents.get(id);
    if (!intent || intent.purpose !== "source") throw new NativeBrainManagerError("unknown", "Only a recorded reference source root can be withdrawn.");
    if (!intent.view) return publicRecord(intent);
    if (intent.state !== "sealed") throw new NativeBrainManagerError("released", "Only a sealed published root can be withdrawn; release it instead.");
    await verifyRoot(intent, signal);
    unlinkNames(intent.view, id);
    return publicRecord(await move(intent, null, signal));
  }
  /** Remove one published name; its root stays charged and retained until released. */
  function unpublish(request: { view: string; name: string }): { view: string; name: string; removed: boolean } {
    nativePoolName.parse(request.name);
    const name = join(viewPath(request.view), request.name);
    if (!existsSync(viewPath(request.view)) || !existsSync(name) && !isLink(name)) return { ...request, removed: false };
    trusted(viewPath(request.view), 0o755);
    if (!lstatSync(name).isSymbolicLink()) throw new NativeBrainManagerError("unknown", "A reference view name is occupied by something other than a published name.");
    unlinkSync(name); syncDirectory(viewPath(request.view));
    return { ...request, removed: true };
  }
  function isLink(path: string) { try { return lstatSync(path).isSymbolicLink(); } catch { return false; } }
  function list(after: string | null): { records: NativePoolRecord[]; next: string | null } {
    const candidates = index.page(after), records: NativePoolRecord[] = [];
    let last = after;
    for (const id of candidates.slice(0, 64)) {
      const record = publicRecord(intents.get(id)!);
      if (Buffer.byteLength(JSON.stringify({ records: [...records, record], next: id })) > NATIVE_CONTROL_BYTES) break;
      records.push(record); last = id;
    }
    if (!records.length && candidates.length) throw new NativeBrainManagerError("unavailable", "A reference pool record exceeds the control response bound.");
    return { records, next: last && candidates.some(id => id > last!) ? last : null };
  }
  return {
    /** Mandatory worker masks for pool private state, roots, views and access generations; a worker sees only what is bound for it. */
    privatePaths: [privateRoot, roots, views, accessRoot, pool.devicePath, ...(backing?.backingPath ? [backing.backingPath] : []), ...(pool.headroomLedgerPath ? [dirname(pool.headroomLedgerPath)] : [])],
    status, create, seal, release, publish, unpublish, withdraw, list, rearm: ensureEmergency,
    checkpoint, checkpointPath, deltaRoots, accessOpen, grant, park, accessClose,
    close() { index.close(); closeSync(stateFd); },
  };
}
export type NativeReferencePool = Awaited<ReturnType<typeof createNativeReferencePool>>;
