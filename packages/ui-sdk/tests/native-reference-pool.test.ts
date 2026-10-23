import { expect, test } from "bun:test";
import { nativeManagerRequest } from "../src/server/native-brain-manager-protocol";
import { validateNativeBrainManagerConfig } from "../src/server/native-brain-manager";
import { parsePoolObservation, referencePoolAccounting, referencePoolMount, reservePhysical, poolReservationFactor, validateNativeReferencePoolConfig,
  REFERENCE_POOL_COMBINED_BYTES, REFERENCE_POOL_OPERATION_BYTES, REFERENCE_POOL_QGROUP, type PoolIntent, type PoolObservation, type QualifiedReferencePoolConfig } from "../src/server/native-reference-pool";

const MIB = 1024 ** 2;
const ID = "11111111-1111-4111-8111-111111112428", SECOND = "22222222-2222-4222-8222-222222222428";
const store = { storePath: "/mnt/odysseus", devicePath: "/dev/odysseus", socketPath: "/run/odysseus/native.sock", appGid: 1000,
  fsid: "11111111-1111-4111-8111-111111111790", brainUuid: "11111111111141118111111111111790", capacityBytes: 1024 ** 3, recoveryReserveBytes: 4096 };
const pool = () => ({ storePath: "/srv/ithaca-reference", devicePath: "/dev/ithaca-reference", fsid: "33333333-3333-4333-8333-333333332428",
  emergencyBytes: 4 * MIB, physicalFloorBytes: 64 * MIB, combinedLimitBytes: 256 * MIB, operationLimitBytes: 32 * MIB });
const limits = (): QualifiedReferencePoolConfig => validateNativeReferencePoolConfig(pool(), store);
const COMBINED = String((1n << 48n) | 2428n);
const qgroup = (referenced: number, limit = 0) => ({ referenced, exclusive: referenced, max_referenced: limit, max_exclusive: limit, limit_flags: limit ? 3 : 0, rsv_data: 0, rsv_meta_pertrans: 0, rsv_meta_prealloc: 0 });
const space = (profile: string, used: number) => ({ profiles: [profile], disk_used: used, disk_total: 64 * MIB, bytes_used: profile === "dup" ? used / 2 : used, bytes_reserved: 0, bytes_may_use: 0, bytes_pinned: 0 });
function observation(roots: Array<{ id: string; rootId: string; referenced: number; limit?: number }>, data: number, metadata: number): PoolObservation {
  return { stable: true, reads: 2, generation: "40", mode: "squota", inconsistent: "0", override: "0", nodesize: 16384, sectorsize: 4096,
    features: ["free_space_tree", "no_holes", "simple_quota", "skinny_metadata"], statusFlags: "17", enableGeneration: "6",
    spaces: { data: space("single", data), metadata: space("dup", metadata), system: space("dup", 32768) },
    qgroups: { "0/5": qgroup(16384), [REFERENCE_POOL_QGROUP]: qgroup(roots.reduce((sum, root) => sum + root.referenced, 0), 256 * MIB),
      ...Object.fromEntries(roots.map(root => [`0/${root.rootId}`, qgroup(root.referenced, root.limit ?? 32 * MIB)])) },
    relations: roots.map(root => [root.rootId, COMBINED] as [string, string]),
    subvolumes: roots.map(root => ({ rootId: root.rootId, parentId: "5", dirId: "257", name: root.id })), dropping: [] };
}
const intent = (id: string, rootId: string | null, state: PoolIntent["state"], from: string | null = null): PoolIntent => ({ version: 1, fsid: pool().fsid, id, purpose: from ? "worktree" : "source", from,
  allowanceBytes: 32 * MIB, state, root: rootId ? { rootId, uuid: "a".repeat(32), otransid: "10" } : null, path: null, ownerBytes: null, reason: null, view: null, access: null, reservedGeneration: "9" });
const VIEW = "44444444-4444-4444-8444-444444442429";
const account = (observed: PoolObservation, intents: PoolIntent[]) =>
  referencePoolAccounting({ observation: observed, intents, limits: limits(), rootsDirId: "257", emergencyAllocatedBytes: 4 * MIB, viewDirIds: new Map([["900", VIEW]]) });

test("pool operations accept only generated identities and bounded allowances, never host paths", () => {
  for (const operation of [
    { operation: "poolCreate", id: ID, purpose: "source", from: null, allowanceBytes: MIB, path: "/srv/other" },
    { operation: "poolCreate", id: "../roots", purpose: "source", from: null, allowanceBytes: MIB },
    { operation: "poolCreate", id: ID, purpose: "cache", from: null, allowanceBytes: MIB },
    { operation: "poolCreate", id: ID, purpose: "worktree", from: "/srv/ithaca", allowanceBytes: MIB },
    { operation: "poolRelease", id: ID, recursive: true },
    { operation: "poolStatus", fsid: pool().fsid },
  ]) expect(nativeManagerRequest.safeParse(operation).success, "REFERENCE_POOL_NO_CALLER_PATH").toBe(false);
  expect(nativeManagerRequest.parse({ operation: "poolCreate", id: SECOND, purpose: "worktree", from: ID, allowanceBytes: MIB }).operation).toBe("poolCreate");
});

test("pool configuration is a separate volume with explicit finite page-aligned bounds and the ruled defaults", () => {
  const fixed = validateNativeReferencePoolConfig({ ...pool(), combinedLimitBytes: undefined, operationLimitBytes: undefined }, store);
  expect([fixed.combinedLimitBytes, fixed.operationLimitBytes], "REFERENCE_POOL_RULED_DEFAULTS").toEqual([10 * 1024 ** 3, 2 * 1024 ** 3]);
  expect([REFERENCE_POOL_COMBINED_BYTES, REFERENCE_POOL_OPERATION_BYTES]).toEqual([10 * 1024 ** 3, 2 * 1024 ** 3]);
  for (const input of [
    { ...pool(), fsid: store.fsid }, { ...pool(), storePath: "/mnt/odysseus/reference" }, { ...pool(), storePath: "/mnt" },
    { ...pool(), operationLimitBytes: 512 * MIB }, { ...pool(), emergencyBytes: 4097 }, { ...pool(), physicalFloorBytes: 0 },
    { ...pool(), combinedLimitBytes: Infinity }, { ...pool(), maxIdentities: 0 }, { ...pool(), headroomLedgerPath: "relative/ledger" },
    { ...pool(), devicePath: "/dev/../sda" },
  ]) expect(() => validateNativeReferencePoolConfig(input as never, store), "REFERENCE_POOL_SEPARATE_FINITE_CONFIG").toThrow();
  expect(() => validateNativeBrainManagerConfig({ ...store, referencePool: { ...pool(), fsid: store.fsid } }), "REFERENCE_POOL_VALIDATED_WITH_MANAGER").toThrow();
  expect(() => validateNativeBrainManagerConfig({ ...store, referencePool: pool() })).not.toThrow();
});

test("pool mount is one top-level read-write tree with no unmanaged alias or nested mount", () => {
  const top = "51 25 7:2429 / /srv/ithaca-reference rw,nosuid,nodev - btrfs /dev/ithaca-reference rw,discard=async,subvolid=5,subvol=/\n";
  const device = "/dev/ithaca-reference";
  expect(referencePoolMount(top, "/srv/ithaca-reference", device).options).toContain("discard=async");
  expect(() => referencePoolMount(top + "52 25 0:41 /roots/x /run/view ro - btrfs /dev/ithaca-reference ro\n", "/srv/ithaca-reference", device)).not.toThrow();
  expect(() => referencePoolMount(top + "52 25 0:41 /views/x /run/reference ro - btrfs /dev/ithaca-reference ro\n", "/srv/ithaca-reference", device)).not.toThrow();
  for (const input of [top.replace("btrfs", "ext4"), top.replace(" / /srv", " /roots /srv"), top.replace("btrfs /dev/ithaca-reference", "btrfs /dev/other"),
    top + "52 25 0:41 / /srv/alias rw - btrfs /dev/ithaca-reference rw\n",
    top + "53 51 0:40 / /srv/ithaca-reference/roots/x rw - tmpfs tmpfs rw\n",
    top.replace("rw,discard=async", "rw,user_subvol_rm_allowed")])
    expect(() => referencePoolMount(input, "/srv/ithaca-reference", device), "REFERENCE_POOL_ONE_PRESENTED_CAPACITY").toThrow();
});

test("observations with missing or malformed counters are unknown evidence", () => {
  const good = observation([], 0, 262144);
  expect(parsePoolObservation(good)).toBe(good);
  for (const broken of [{ ...good, generation: 40 }, { ...good, spaces: { ...good.spaces, metadata: undefined } },
    { ...good, qgroups: { "0/5": { ...qgroup(0), referenced: -1 } } }, { ...good, relations: [["1", "x"]] }, { ...good, subvolumes: [{ rootId: "256" }] }])
    expect(() => parsePoolObservation(broken), "REFERENCE_POOL_INCOMPLETE_EVIDENCE_REFUSES").toThrow(/incomplete/);
});

test("aggregate is the filesystem's unique physical allocation with replication, not a sum of root charges", () => {
  // A sealed 40 MiB source and a snapshot that wrote 4 MiB: squota charges each
  // extent once to its owner, and disk_used holds the union with DUP metadata.
  const observed = observation([{ id: ID, rootId: "256", referenced: 40 * MIB }, { id: SECOND, rootId: "257", referenced: 4 * MIB }], 44 * MIB, 2 * MIB);
  const { accounting, refusal } = account(observed, [intent(ID, "256", "sealed"), intent(SECOND, "257", "writable", ID)]);
  expect(refusal).toBeNull();
  expect(accounting.aggregateBytes, "REFERENCE_POOL_UNION_INCLUDES_METADATA_REPLICATION").toBe(44 * MIB + 2 * MIB + 32768);
  // Summing what each root references would charge the source again for its snapshot.
  expect(accounting.chargedBytes, "REFERENCE_POOL_SHARED_EXTENT_CHARGED_ONCE").toBeLessThan(2 * 40 * MIB);
  expect(accounting.chargedBytes, "REFERENCE_POOL_EMERGENCY_OUTSIDE_BUDGET").toBe(accounting.aggregateBytes - 4 * MIB);
  expect(accounting.ownerBytes).toBe(44 * MIB + 16384);
  expect(accounting.globalBytes).toBe(accounting.aggregateBytes - accounting.ownerBytes);
  expect(accounting.reservationFactor, "REFERENCE_POOL_FACTOR_FROM_ACTUAL_PROFILES").toEqual({ numerator: 17, denominator: 8 });
  expect(accounting.pendingBytes, "REFERENCE_POOL_WRITABLE_REMAINDER_RESERVED").toBe(reservePhysical(28 * MIB, accounting.reservationFactor));
  expect(accounting.availableBytes).toBe(256 * MIB - accounting.chargedBytes - accounting.pendingBytes);
});

test("materialized bytes replace their reservation instead of being charged twice", () => {
  const factor = poolReservationFactor({ data: space("single", 0), metadata: space("dup", 0) });
  const before = account(observation([{ id: ID, rootId: "256", referenced: 0 }], 0, MIB), [intent(ID, "256", "writable")]).accounting;
  const after = account(observation([{ id: ID, rootId: "256", referenced: 16 * MIB }], 16 * MIB, MIB), [intent(ID, "256", "writable")]).accounting;
  expect(after.pendingBytes, "REFERENCE_POOL_CONSUMED_RESERVATION_RELEASED").toBe(before.pendingBytes - (reservePhysical(32 * MIB, factor) - reservePhysical(16 * MIB, factor)));
  expect(after.chargedBytes + after.pendingBytes, "REFERENCE_POOL_NO_DUPLICATE_MATERIALIZED_CHARGE").toBeLessThanOrEqual(before.chargedBytes + before.pendingBytes);
  // Kernel reservations (delalloc) are not yet in disk_used and must not release reservation.
  const delalloc = observation([{ id: ID, rootId: "256", referenced: 0 }], 0, MIB);
  delalloc.qgroups["0/256"]!.rsv_data = 16 * MIB;
  expect(account(delalloc, [intent(ID, "256", "writable")]).accounting.pendingBytes, "REFERENCE_POOL_INFLIGHT_STAYS_RESERVED").toBe(before.pendingBytes);
  const reserved = account(observation([], 0, MIB), [intent(ID, null, "reserved")]).accounting;
  expect(reserved.pendingBytes, "REFERENCE_POOL_RESERVED_BEFORE_WORK").toBe(reservePhysical(32 * MIB, factor));
});

test("deleted roots keep their measured owner charge until squota shows it gone", () => {
  const observed = observation([{ id: SECOND, rootId: "257", referenced: 4 * MIB }], 44 * MIB, 2 * MIB);
  observed.qgroups["0/256"] = qgroup(40 * MIB, 32 * MIB); observed.relations.push(["256", COMBINED]);
  const { accounting, owner, refusal } = account(observed, [intent(ID, "256", "deleted"), intent(SECOND, "257", "writable", ID)]);
  expect(refusal).toBeNull();
  expect(owner.get(ID), "REFERENCE_POOL_SHARED_REFERENCE_PREVENTS_CREDIT").toBe(40 * MIB);
  expect(accounting.chargedBytes).toBeGreaterThan(40 * MIB);
});

test("unexplained allocation evidence refuses admission while status still reports", () => {
  const base = () => observation([{ id: ID, rootId: "256", referenced: MIB }], MIB, MIB);
  const cases: Array<[string, (value: PoolObservation) => void, RegExp]> = [
    ["changing", value => { value.stable = false; }, /changed between consistent reads/],
    ["full qgroups", value => { value.mode = "qgroup"; }, /simple quotas/],
    ["override", value => { value.override = "1"; }, /quota_override/],
    ["inconsistent", value => { value.inconsistent = "1"; }, /inconsistent/],
    ["mixed", value => { value.features.push("mixed_groups"); }, /mixed_groups/],
    ["profile", value => { value.spaces.data.profiles = ["raid1"]; }, /profile/],
    ["converting", value => { value.spaces.metadata.profiles = ["dup", "single"]; }, /profile/],
    ["foreign qgroup", value => { value.qgroups["1/77"] = qgroup(0); }, /no recorded owner/],
    ["foreign relation", value => { value.relations.push(["256", String((1n << 48n) | 77n)]); }, /unrecorded qgroup relation/],
    ["outside combined", value => { value.relations = []; }, /outside the combined allowance/],
    ["unrecorded root", value => { value.subvolumes.push({ rootId: "300", parentId: "5", dirId: "257", name: SECOND }); }, /no recorded identity/],
    ["nested root", value => { value.subvolumes.push({ rootId: "301", parentId: "256", dirId: "256", name: "nested" }); }, /nested/],
    ["combined limit changed", value => { value.qgroups[REFERENCE_POOL_QGROUP]!.max_referenced = 0; }, /combined kernel limit/],
    ["root limit lost", value => { value.qgroups["0/256"]!.limit_flags = 0; }, /lost its kernel allowance/],
  ];
  for (const [name, change, message] of cases) {
    const observed = base(); change(observed);
    const result = account(observed, [intent(ID, "256", "writable")]);
    expect(result.refusal?.message, `REFERENCE_POOL_REFUSES_${name.toUpperCase().replaceAll(" ", "_")}`).toMatch(message);
    expect(result.accounting.aggregateBytes, "REFERENCE_POOL_STATUS_STILL_REPORTS").toBeGreaterThan(0);
  }
  const predates = base();
  expect(account(predates, [{ ...intent(ID, "256", "writable"), root: { rootId: "256", uuid: "a".repeat(32), otransid: "5" } }]).refusal?.message,
    "REFERENCE_POOL_REFUSES_UNCHARGED_PRE_QUOTA_ROOT").toMatch(/predates simple-quota/);
});

test("allocation beyond the combined allowance refuses admission and still reports", () => {
  const result = account(observation([{ id: ID, rootId: "256", referenced: MIB }], 300 * MIB, MIB), [intent(ID, "256", "writable")]);
  expect(result.accounting.availableBytes).toBeLessThan(0);
  expect(result.refusal, "REFERENCE_POOL_OVER_COMBINED_REFUSES").toMatchObject({ code: "capacity" });
});

test("publication requests name one generated view and a plain entry, never a path or a root identity", () => {
  expect(nativeManagerRequest.parse({ operation: "poolPublish", id: ID, view: VIEW, name: "github.com_odysseus_ithaca@main-1a2b3c4d" }).operation).toBe("poolPublish");
  for (const name of ["", ".ithaca", "..", "ithaca/main", "/srv/ithaca", "Ithaca", "ithaca\u0000", ID, "x".repeat(129)])
    expect(nativeManagerRequest.safeParse({ operation: "poolPublish", id: ID, view: VIEW, name }).success, `REFERENCE_VIEW_NAME_REFUSED ${JSON.stringify(name)}`).toBe(false);
  expect(nativeManagerRequest.safeParse({ operation: "poolPublish", id: ID, view: "/srv/views/x", name: "ithaca" }).success, "REFERENCE_VIEW_IS_GENERATED").toBe(false);
  expect(nativeManagerRequest.safeParse({ operation: "poolUnpublish", view: VIEW, name: "ithaca", id: ID }).success).toBe(false);
});

test("a published root is accounted only inside its recorded view directory", () => {
  const inView = observation([{ id: ID, rootId: "256", referenced: MIB }], MIB, MIB);
  inView.subvolumes[0]!.dirId = "900";
  expect(account(inView, [{ ...intent(ID, "256", "sealed"), view: VIEW }]).refusal, "REFERENCE_VIEW_ROOT_ACCOUNTED").toBeNull();
  expect(account(inView, [intent(ID, "256", "sealed")]).refusal?.message, "REFERENCE_VIEW_UNRECORDED_LOCATION_REFUSES").toMatch(/outside its recorded view/);
  const roots = observation([{ id: ID, rootId: "256", referenced: MIB }], MIB, MIB);
  expect(account(roots, [{ ...intent(ID, "256", "sealed"), view: VIEW }]).refusal?.message).toMatch(/outside its recorded view/);
  const stray = observation([{ id: ID, rootId: "256", referenced: MIB }], MIB, MIB);
  stray.subvolumes[0]!.dirId = "901";
  expect(account(stray, [{ ...intent(ID, "256", "sealed"), view: VIEW }]).refusal?.message, "REFERENCE_VIEW_UNKNOWN_DIRECTORY_REFUSES").toMatch(/outside the managed roots directory/);
});

const ACCESS = "55555555-5555-4555-8555-555555552430";
test("worktree checkpoints, deltas and access generations take generated identities only, never a path", () => {
  for (const operation of [
    { operation: "poolCheckpoint", id: SECOND, from: ID },
    { operation: "poolDelta", from: ID, to: SECOND },
    { operation: "poolReadCheckpoint", id: SECOND, action: "file", path: "odyssey/book-1.md", maximum: 4096 },
    { operation: "poolAccessOpen", access: ACCESS },
    { operation: "poolAccess", id: ID, access: ACCESS },
    { operation: "poolPark", id: ID },
    { operation: "poolAccessClose", access: ACCESS },
  ]) expect(nativeManagerRequest.parse(operation).operation as string, "REFERENCE_WORKTREE_OPERATION_ACCEPTED").toBe(operation.operation);
  for (const operation of [
    { operation: "poolCheckpoint", id: SECOND, from: "/srv/ithaca-reference/roots/x" },
    { operation: "poolCheckpoint", id: SECOND, from: ID, allowanceBytes: 4096 },
    { operation: "poolAccess", id: ID, access: "/tmp/brain-worktrees" },
    { operation: "poolAccess", id: ID, access: ACCESS, uid: 0 },
    { operation: "poolAccessOpen", access: ACCESS, path: "/srv/other" },
    { operation: "poolReadCheckpoint", id: SECOND, action: "file", path: "../roots", maximum: 1 },
    { operation: "poolReadCheckpoint", id: SECOND, action: "file", path: "/etc/passwd", maximum: 1 },
    { operation: "poolCreate", id: SECOND, purpose: "checkpoint", from: ID, allowanceBytes: MIB },
  ]) expect(nativeManagerRequest.safeParse(operation).success, `REFERENCE_WORKTREE_NO_CALLER_AUTHORITY ${operation.operation}`).toBe(false);
});

test("a held worktree is accounted only inside its recorded access generation", () => {
  const accountAt = (dirId: string, recorded: string | null) => {
    const observed = observation([{ id: ID, rootId: "256", referenced: MIB }], MIB, MIB);
    observed.subvolumes[0]!.dirId = dirId;
    return referencePoolAccounting({ observation: observed, intents: [{ ...intent(ID, "256", "writable", SECOND), access: recorded }], limits: limits(), rootsDirId: "257",
      emergencyAllocatedBytes: 4 * MIB, viewDirIds: new Map([["900", VIEW]]), accessDirIds: new Map([["910", ACCESS]]) }).refusal;
  };
  expect(accountAt("910", ACCESS), "REFERENCE_WORKTREE_ACCESS_ACCOUNTED").toBeNull();
  expect(accountAt("910", null), "REFERENCE_WORKTREE_UNRECORDED_ACCESS_REFUSES").toMatchObject({ message: expect.stringMatching(/outside its recorded access generation/) });
  expect(accountAt("257", ACCESS), "REFERENCE_WORKTREE_PARKED_BUT_RECORDED_HELD_REFUSES").toMatchObject({ message: expect.stringMatching(/outside its recorded access generation/) });
  expect(accountAt("900", ACCESS), "REFERENCE_WORKTREE_NEVER_IN_A_VIEW").toMatchObject({ message: expect.stringMatching(/outside its recorded view/) });
  expect(accountAt("911", ACCESS), "REFERENCE_WORKTREE_UNKNOWN_DIRECTORY_REFUSES").toMatchObject({ message: expect.stringMatching(/outside the managed roots directory/) });
});

test("the pool mount may present access generations like other managed roots", () => {
  const top = "51 25 7:2429 / /srv/ithaca-reference rw,nosuid,nodev - btrfs /dev/ithaca-reference rw,discard=async,subvolid=5,subvol=/\n";
  expect(() => referencePoolMount(top + "52 25 0:41 /access/x /run/worktrees rw - btrfs /dev/ithaca-reference rw\n", "/srv/ithaca-reference", "/dev/ithaca-reference")).not.toThrow();
  expect(() => referencePoolMount(top + "52 25 0:41 /accessory /run/worktrees rw - btrfs /dev/ithaca-reference rw\n", "/srv/ithaca-reference", "/dev/ithaca-reference")).toThrow();
});
