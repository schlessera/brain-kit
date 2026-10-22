/** Real reference-pool qualification on owned Btrfs loop volumes (#2428). Runs only inside reference-pool-fixture.py. */
import { expect } from "bun:test";
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readFileSync, rmSync, statSync, truncateSync, unlinkSync, writeFileSync, writeSync, chmodSync, renameSync } from "node:fs";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createNativeBrainManager, serveNativeBrainManager, type NativeBrainManagerConfig } from "../../packages/ui-sdk/src/server/native-brain-manager.js";
import { createNativeBrainManagerClient } from "../../packages/ui-sdk/src/server/native-brain-manager-client.js";
import { reservePhysical } from "../../packages/ui-sdk/src/server/native-reference-pool.js";
import type { NativePoolRecord, NativePoolStatus } from "../../packages/ui-sdk/src/server/native-brain-manager-protocol.js";

const MIB = 1024 ** 2, POOL = "/reference-pool", ARTIFACTS = process.env.BRAIN_REFERENCE_POOL_ARTIFACTS ?? "/proof";
const LEDGER = "/native-backing/ledger/headroom.json";
const receipts: unknown[] = [];
function note(kind: string, facts: Record<string, unknown>) {
  receipts.push({ kind, ...facts });
  writeFileSync(join(ARTIFACTS, "reference-pool-receipts.json"), JSON.stringify(receipts, null, 2));
  console.log(JSON.stringify({ kind, ...facts }));
}
function command(argv: string[], permitFailure = false): string {
  const result = Bun.spawnSync(argv, { stdout: "pipe", stderr: "pipe" });
  if (!permitFailure) expect(result.exitCode, `${argv.join(" ")}: ${result.stderr.toString()}`).toBe(0);
  return result.stdout.toString();
}
const fsid = (path: string) => command(["btrfs", "filesystem", "show", "--raw", path]).split("uuid: ")[1]!.split(/\s/)[0]!;
const subvolUuid = (path: string) => command(["/usr/bin/python3", "-I", "-S", "-c",
  "import os,sys,fcntl\nfd=os.open(sys.argv[1],os.O_RDONLY|os.O_DIRECTORY)\nb=bytearray(504)\nfcntl.ioctl(fd,0x81f8943c,b,True)\nprint(bytes(b[296:312]).hex())", path]).trim();
mkdirSync("/native-runtime", { mode: 0o755 });
const config: NativeBrainManagerConfig = {
  storePath: "/brain-fixture", devicePath: "/dev/brain-store-loop", fsid: fsid("/brain-fixture"), brainUuid: subvolUuid("/brain-fixture/brain"),
  socketPath: "/native-runtime/pool.sock", appGid: 1000, capacityBytes: 1024 ** 3, recoveryReserveBytes: 8 * MIB, operationTimeoutMs: 20_000,
  referencePool: { storePath: POOL, devicePath: "/dev/brain-pool-loop", fsid: fsid(POOL), combinedLimitBytes: 256 * MIB, operationLimitBytes: 32 * MIB,
    emergencyBytes: 4 * MIB, physicalFloorBytes: 64 * MIB, headroomLedgerPath: LEDGER, maxIdentities: 256 },
};
type Manager = Awaited<ReturnType<typeof createNativeBrainManager>>;
let manager: Manager = await createNativeBrainManager(config);
async function call<T>(request: Record<string, unknown>): Promise<T> {
  const response = await manager.run(request as never);
  return await response.json() as T;
}
async function refusal(request: Record<string, unknown>): Promise<{ code: string; message: string }> {
  try { await manager.run(request as never); } catch (error) { return { code: (error as { code: string }).code, message: String((error as Error).message) }; }
  // An unexpected success reaches the caller's named assertion instead of a generic throw.
  return { code: "none", message: `No refusal for ${JSON.stringify(request)}` };
}
const status = () => call<NativePoolStatus>({ operation: "poolStatus" });
const create = (purpose: string, allowanceBytes: number, from: string | null = null, id = randomUUID()) => call<NativePoolRecord>({ operation: "poolCreate", id, purpose, from, allowanceBytes });
const seal = (id: string) => call<NativePoolRecord>({ operation: "poolSeal", id });
const release = (id: string) => call<NativePoolRecord>({ operation: "poolRelease", id });
const fill = (path: string, bytes: number) => { const fd = openSync(path, "w"); try { for (let done = 0; done < bytes; done += MIB) writeSync(fd, randomBytes(Math.min(MIB, bytes - done))); } finally { closeSync(fd); } };
const sync = () => command(["btrfs", "filesystem", "sync", POOL]);
async function charged(): Promise<NonNullable<NativePoolStatus["accounting"]>> {
  sync(); const current = await status();
  expect(current.refusal, "REFERENCE_POOL_QUALIFIED_DURING_CASE").toBeNull();
  return current.accounting!;
}
/** The reservation factor must bound real physical growth per owner-charged byte. */
function bounded(name: string, before: NonNullable<NativePoolStatus["accounting"]>, after: NonNullable<NativePoolStatus["accounting"]>, extra = 0) {
  const physical = after.chargedBytes - before.chargedBytes, owner = after.ownerBytes - before.ownerBytes;
  note("bound", { name, physical, owner, ratio: owner > 0 ? physical / owner : null, reserved: reservePhysical(owner, after.reservationFactor) });
  expect(physical, `REFERENCE_POOL_FACTOR_BOUNDS_${name}`).toBeLessThanOrEqual(reservePhysical(owner, after.reservationFactor) + extra);
}

// 1. Qualification and baseline.
const first = await status();
note("qualified", { status: first });
expect(first.qualified, "REFERENCE_POOL_QUALIFIED").toBe(true);
expect(first.physical, "REFERENCE_POOL_SPARSE_BACKING_IDENTIFIED").toMatchObject({ kind: "sparse-loop", deviceBytes: 2 * 1024 ** 3 });
expect(first.physical!.unbackedBytes).toBe(first.physical!.deviceBytes - first.physical!.backingAllocatedBytes!);
expect(first.accounting!.spaces.metadata.profile).toBe("dup");
expect(first.accounting!.emergencyAllocatedBytes, "REFERENCE_POOL_EMERGENCY_DISTINCT").toBe(4 * MIB);
const baseline = await charged();

// 2. Empty root lifecycle with observed reclamation.
{
  const empty = await create("staging", 8 * MIB);
  expect(empty.state, "REFERENCE_POOL_EMPTY_WRITABLE").toBe("writable");
  expect(statSync(empty.path!).ino, "REFERENCE_POOL_ROOT_IS_SUBVOLUME").toBe(256);
  const sealed = await seal(empty.id);
  expect(sealed.ownerBytes!, "REFERENCE_POOL_EMPTY_OWNER_CHARGE").toBeLessThanOrEqual(64 * 1024);
  expect((await release(empty.id)).state, "REFERENCE_POOL_EMPTY_RECLAIMED").toBe("reclaimed");
  expect(Math.abs((await charged()).chargedBytes - baseline.chargedBytes), "REFERENCE_POOL_EMPTY_RETURNS_TO_BASELINE").toBeLessThanOrEqual(MIB);
}

// 3. Noncompressible data, per-operation enforcement and retained data.
const source = await create("source", 32 * MIB);
{
  const before = await charged();
  fill(join(source.path!, "ithaca-chart.bin"), 20 * MIB);
  let refused = "";
  try { fill(join(source.path!, "overflow.bin"), 20 * MIB); } catch (error) { refused = (error as NodeJS.ErrnoException).code ?? String(error); }
  expect(refused, "REFERENCE_POOL_OPERATION_LIMIT_ENFORCED_AT_WRITE").toBe("EDQUOT");
  expect(statSync(join(source.path!, "ithaca-chart.bin")).size, "REFERENCE_POOL_REFUSAL_KEEPS_EXISTING_DATA").toBe(20 * MIB);
  rmSync(join(source.path!, "overflow.bin")); sync();
  // Git objects, checkout and staging allocate inside the same owned root.
  command(["git", "-c", "init.defaultBranch=main", "init", "-q", join(source.path!, "odyssey")]);
  for (let index = 0; index < 64; index++) writeFileSync(join(source.path!, "odyssey", `book-${index}.md`), `# Book ${index}\n\nOdysseus sails past ${index} islands.\n`.repeat(40));
  command(["git", "-C", join(source.path!, "odyssey"), "add", "."]);
  command(["git", "-C", join(source.path!, "odyssey"), "-c", "user.name=Penelope", "-c", "user.email=penelope@ithaca.example", "commit", "-q", "-m", "Chart the voyage"]);
  command(["git", "-C", join(source.path!, "odyssey"), "checkout", "-q", "-b", "return"]);
  const after = await charged();
  bounded("NONCOMPRESSIBLE_AND_GIT", before, after);
  expect(after.chargedBytes - before.chargedBytes, "REFERENCE_POOL_DATA_CHARGED").toBeGreaterThanOrEqual(20 * MIB);
  const sealed = await seal(source.id);
  note("sealed-source", { sealed });
  expect(sealed.ownerBytes!, "REFERENCE_POOL_SEALED_MEASURED").toBeGreaterThanOrEqual(20 * MIB);
  expect(sealed.ownerBytes!).toBeLessThanOrEqual(32 * MIB);
}

// 4. Snapshot worktree shares source extents once; COW edits charge only the worktree.
const worktree = await create("worktree", 16 * MIB, source.id);
{
  const before = await charged();
  expect(before.chargedBytes - baseline.chargedBytes, "REFERENCE_POOL_SNAPSHOT_SHARED_ONCE").toBeLessThan(32 * MIB);
  const shared = join(worktree.path!, "ithaca-chart.bin"), fd = openSync(shared, "r+");
  try { writeSync(fd, randomBytes(4 * MIB), 0, 4 * MIB, 8 * MIB); } finally { closeSync(fd); }
  truncateSync(join(worktree.path!, "odyssey", "book-1.md"), 0);
  const after = await charged();
  bounded("COW_EDIT", before, after);
  const roots = await call<{ records: NativePoolRecord[] }>({ operation: "listPoolRecovery", after: null });
  note("cow", { before: before.chargedBytes, after: after.chargedBytes, roots: roots.records });
  expect(after.chargedBytes - before.chargedBytes, "REFERENCE_POOL_COW_CHARGES_CHANGED_EXTENTS").toBeGreaterThanOrEqual(4 * MIB);
  expect(after.chargedBytes - before.chargedBytes, "REFERENCE_POOL_COW_NOT_FULL_COPY").toBeLessThan(12 * MIB);
}

// 5. Compressed, holes, inline, preallocation, hardlinks, reflinks and partial clones.
const shapes = await create("staging", 32 * MIB);
{
  const before = await charged();
  mkdirSync(join(shapes.path!, "compressed"));
  command(["btrfs", "property", "set", join(shapes.path!, "compressed"), "compression", "zstd"]);
  // Stream ordinary writes: one large writeFileSync stayed a single raw extent on the qualifying kernel.
  const song = openSync(join(shapes.path!, "compressed", "song.txt"), "w"), verse = Buffer.from("Sing to me of the man, Muse, the man of twists and turns.\n".repeat(1500));
  try { for (let index = 0; index < 100; index++) writeSync(song, verse); } finally { closeSync(song); }
  sync();
  const compressed = await charged();
  bounded("COMPRESSED", before, compressed);
  const extents = command(["/usr/bin/python3", "-I", "-S", "-c", "import os,sys,fcntl,struct\nfd=os.open(sys.argv[1],os.O_RDONLY)\nb=bytearray(32+56*64)\nstruct.pack_into('<QQIIII',b,0,0,2**64-1,1,0,64,0)\nfcntl.ioctl(fd,0xC020660B,b,True)\nn=struct.unpack_from('<I',b,20)[0]\nprint([struct.unpack_from('<QQQ',b,32+56*i)+(struct.unpack_from('<I',b,32+56*i+40)[0],) for i in range(n)])",
    join(shapes.path!, "compressed", "song.txt")]).trim();
  note("compressed-extents", { extents, property: command(["btrfs", "property", "get", join(shapes.path!, "compressed", "song.txt")], true).trim(),
    mount: readFileSync("/proc/self/mountinfo", "utf8").split("\n").filter(line => line.includes(" /reference-pool ")) });
  note("compressed", { logical: statSync(join(shapes.path!, "compressed", "song.txt")).size, physical: compressed.chargedBytes - before.chargedBytes });
  expect(compressed.chargedBytes - before.chargedBytes, "REFERENCE_POOL_COMPRESSED_CHARGED_AT_DISK_SIZE").toBeLessThan(statSync(join(shapes.path!, "compressed", "song.txt")).size / 4);
  const sparse = openSync(join(shapes.path!, "holes.bin"), "w");
  try { writeSync(sparse, randomBytes(4096), 0, 4096, 4 * 1024 ** 3); } finally { closeSync(sparse); }
  const holes = await charged();
  expect(holes.chargedBytes - compressed.chargedBytes, "REFERENCE_POOL_HOLES_NOT_CHARGED_BY_LENGTH").toBeLessThan(MIB);
  mkdirSync(join(shapes.path!, "inline"));
  for (let index = 0; index < 1000; index++) writeFileSync(join(shapes.path!, "inline", `oar-${index}`), `Oar ${index} of Odysseus' ship.\n`);
  const inline = await charged();
  bounded("INLINE", holes, inline);
  expect(inline.spaces.data.diskUsed - holes.spaces.data.diskUsed, "REFERENCE_POOL_INLINE_IN_METADATA").toBeLessThan(MIB);
  expect(inline.spaces.metadata.diskUsed, "REFERENCE_POOL_INLINE_METADATA_CHARGED").toBeGreaterThan(holes.spaces.metadata.diskUsed);
  command(["fallocate", "--length", String(8 * MIB), join(shapes.path!, "prealloc.bin")]);
  const prealloc = await charged();
  expect(prealloc.chargedBytes - inline.chargedBytes, "REFERENCE_POOL_PREALLOCATION_CHARGED").toBeGreaterThanOrEqual(8 * MIB);
  fill(join(shapes.path!, "anchor.bin"), 4 * MIB);
  const anchored = await charged();
  for (let index = 0; index < 50; index++) linkSync(join(shapes.path!, "anchor.bin"), join(shapes.path!, `anchor-link-${index}`));
  command(["cp", "--reflink=always", join(shapes.path!, "anchor.bin"), join(shapes.path!, "anchor-reflink.bin")]);
  command(["cp", "--reflink=always", join(worktree.path!, "ithaca-chart.bin"), join(shapes.path!, "chart-reflink.bin")]);
  const shared = await charged();
  expect(shared.chargedBytes - anchored.chargedBytes, "REFERENCE_POOL_HARDLINK_REFLINK_SHARED_ONCE").toBeLessThan(MIB);
  // A 4 KiB clone of a 12 MiB extent keeps the whole extent allocated after the original goes.
  fill(join(shapes.path!, "whole.bin"), 12 * MIB); sync();
  command(["/usr/bin/python3", "-I", "-S", "-c", "import os,sys,fcntl,struct\ns=os.open(sys.argv[1],os.O_RDONLY)\nd=os.open(sys.argv[2],os.O_WRONLY|os.O_CREAT,0o600)\nfcntl.ioctl(d,0x4020940d,struct.pack('<qQQQ',s,6*1024*1024,4096,0))",
    join(shapes.path!, "whole.bin"), join(shapes.path!, "piece.bin")]);
  unlinkSync(join(shapes.path!, "whole.bin"));
  const partial = await charged();
  note("partial-clone", { before: shared.chargedBytes, after: partial.chargedBytes });
  expect(partial.chargedBytes - shared.chargedBytes, "REFERENCE_POOL_PARTIAL_CLONE_RETAINS_WHOLE_EXTENT").toBeGreaterThanOrEqual(11 * MIB);
  bounded("SHAPES", before, partial);
}

// 6. Metadata-heavy root: many empty files and directories.
{
  const heavy = await create("worktree", 32 * MIB);
  const before = await charged();
  for (let directory = 0; directory < 40; directory++) {
    mkdirSync(join(heavy.path!, `isle-${directory}`));
    for (let file = 0; file < 100; file++) closeSync(openSync(join(heavy.path!, `isle-${directory}`, `sailor-${file}`), "w"));
  }
  const after = await charged();
  bounded("METADATA_HEAVY", before, after);
  expect(after.spaces.metadata.diskUsed - before.spaces.metadata.diskUsed, "REFERENCE_POOL_METADATA_REPLICATION_COUNTED").toBeGreaterThan(MIB);
  expect(after.chargedBytes - before.chargedBytes, "REFERENCE_POOL_METADATA_IN_AGGREGATE").toBeGreaterThanOrEqual(after.spaces.metadata.diskUsed - before.spaces.metadata.diskUsed);
  await seal(heavy.id); expect((await release(heavy.id)).state).toBe("reclaimed");
}

// 7. Concurrent admissions cannot spend one allowance twice; another ledger consumer shares backing headroom.
{
  const current = await charged();
  const each = 32 * MIB, need = reservePhysical(each, current.reservationFactor), fit = Math.floor(current.availableBytes / need);
  note("admission", { available: current.availableBytes, need, fit });
  const attempts = await Promise.allSettled(Array.from({ length: fit + 1 }, () => create("worktree", each)));
  const admitted = attempts.filter(item => item.status === "fulfilled").map(item => (item as PromiseFulfilledResult<NativePoolRecord>).value);
  const refused = attempts.filter(item => item.status === "rejected").map(item => (item as PromiseRejectedResult).reason);
  expect(admitted.length, "REFERENCE_POOL_CONCURRENT_ADMISSIONS_SERIALIZED").toBe(fit);
  expect(refused.map(error => error.code), "REFERENCE_POOL_OVER_ADMISSION_REFUSED").toEqual(["capacity"]);
  const after = await charged();
  expect(after.availableBytes, "REFERENCE_POOL_ADMITTED_WITHIN_COMBINED").toBeGreaterThanOrEqual(0);
  for (const record of admitted) expect((await release(record.id)).state).toBe("reclaimed");
  // Another consumer of the same physical backing records unbacked bytes in the shared ledger.
  const ledger = JSON.parse(readFileSync(LEDGER, "utf8"));
  ledger.entries["reference-pool:odysseus-raft"] = { unbackedBytes: 1024 ** 4, floorBytes: 0 };
  writeFileSync(LEDGER + ".edit", JSON.stringify(ledger)); chmodSync(LEDGER + ".edit", 0o600); renameSync(LEDGER + ".edit", LEDGER);
  const starved = await status();
  expect(starved.refusal?.code, "REFERENCE_POOL_SHARED_BACKING_HEADROOM_REFUSES").toBe("capacity");
  expect((await refusal({ operation: "poolCreate", id: randomUUID(), purpose: "source", from: null, allowanceBytes: 4 * MIB })).code).toBe("capacity");
  delete ledger.entries["reference-pool:odysseus-raft"];
  ledger.entries[`reference-pool:${config.referencePool!.fsid}`] = { unbackedBytes: 0, floorBytes: 0 };
  writeFileSync(LEDGER + ".edit", JSON.stringify(ledger)); chmodSync(LEDGER + ".edit", 0o600); renameSync(LEDGER + ".edit", LEDGER);
  const restored = await status();
  expect(restored.qualified, "REFERENCE_POOL_HEADROOM_RECOVERS").toBe(true);
  note("ledger", { starved: starved.physical, restored: restored.physical });
  expect(restored.physical!.headroomBytes, "REFERENCE_POOL_NO_DUPLICATE_PHYSICAL_CHARGE").toBe(restored.physical!.backingAvailableBytes! - 64 * MIB - restored.physical!.unbackedBytes - restored.physical!.otherConsumersBytes!);
}

// 8. Source deletion while a descendant retains its extents keeps the charge until reclamation is observed.
{
  const before = await charged();
  const deleted = await release(source.id);
  note("source-deleted", { deleted });
  expect(deleted.state, "REFERENCE_POOL_SHARED_SOURCE_NOT_RECLAIMED").toBe("deleted");
  expect(deleted.ownerBytes!, "REFERENCE_POOL_RETAINED_ALLOCATION_STAYS_CHARGED").toBeGreaterThanOrEqual(16 * MIB);
  expect((await charged()).chargedBytes, "REFERENCE_POOL_NO_EARLY_CREDIT").toBeGreaterThanOrEqual(before.chargedBytes - MIB);
  expect((await refusal({ operation: "poolCreate", id: randomUUID(), purpose: "worktree", from: source.id, allowanceBytes: 4 * MIB })).code,
    "REFERENCE_POOL_DELETED_SOURCE_NOT_SNAPSHOTTED").toBe("unknown");
  // The staging root still reflinks the worktree's chart: its extents keep both owners charged.
  const retained = await release(worktree.id);
  expect(retained.state, "REFERENCE_POOL_REFLINK_RETAINS_DELETED_WORKTREE").toBe("deleted");
  expect(retained.ownerBytes!, "REFERENCE_POOL_REFLINKED_COW_EXTENT_CHARGED").toBeGreaterThanOrEqual(4 * MIB);
  expect((await release(shapes.id)).state).toBe("reclaimed");
  const after = await charged();
  const records = (await call<{ records: NativePoolRecord[] }>({ operation: "listPoolRecovery", after: null })).records;
  expect(records.find(record => record.id === source.id)?.state, "REFERENCE_POOL_SOURCE_RECLAIMED_AFTER_DESCENDANT").toBe("reclaimed");
  expect(records.find(record => record.id === worktree.id)?.state, "REFERENCE_POOL_WORKTREE_RECLAIMED_AFTER_REFLINK").toBe("reclaimed");
  expect(after.chargedBytes, "REFERENCE_POOL_RECLAIMED_CREDIT").toBeLessThan(before.chargedBytes - 16 * MIB);
}

// 9. Deletion with an open hold stays charged through its deadline.
{
  manager = await restart({ operationTimeoutMs: 4_000 });
  const held = await create("worktree", 8 * MIB);
  fill(join(held.path!, "rope.bin"), 4 * MIB);
  const holder = Bun.spawn(["/usr/bin/python3", "-I", "-S", "-c", "import os,sys,time\nfd=os.open(sys.argv[1],os.O_RDONLY)\nprint('held',flush=True)\ntime.sleep(60)", join(held.path!, "rope.bin")], { stdout: "pipe" });
  await new Response(holder.stdout).body!.getReader().read();
  const timeout = await refusal({ operation: "poolRelease", id: held.id });
  expect(timeout.code, "REFERENCE_POOL_HOLD_UNKNOWN_OUTCOME").toBe("unknown");
  const record = (await call<{ records: NativePoolRecord[] }>({ operation: "listPoolRecovery", after: null })).records.find(item => item.id === held.id)!;
  expect(record.state, "REFERENCE_POOL_HOLD_STAYS_CHARGED").toBe("deleting");
  holder.kill("SIGKILL"); await holder.exited;
  manager = await restart({});
  expect((await release(held.id)).state, "REFERENCE_POOL_HOLD_RELEASED_AFTER_CLOSE").toBe("reclaimed");
}

// 10. Crash before and after every durable transition reconstructs on restart.
{
  const state = join(POOL, ".reference-native/state");
  const intent = (id: string) => JSON.parse(readFileSync(join(state, `${id}.json`), "utf8"));
  const rewrite = (id: string, value: unknown) => { writeFileSync(join(state, `${id}.json`), JSON.stringify(value)); };
  // After reserve, before create.
  const lost = randomUUID();
  const live = await create("source", 4 * MIB);
  rewrite(lost, { ...intent(live.id), id: lost, state: "reserved", root: null, path: null });
  // After create, before the writable intent: the root exists, the intent still says reserved.
  const adopted = await create("source", 4 * MIB);
  rewrite(adopted.id, { ...intent(adopted.id), state: "reserved", root: null, path: null });
  // After the deleting intent, before the delete command.
  const pending = await create("source", 4 * MIB);
  rewrite(pending.id, { ...intent(pending.id), state: "deleting", path: null });
  // After the delete command, before the deleted intent.
  const gone = await create("source", 4 * MIB);
  rewrite(gone.id, { ...intent(gone.id), state: "deleting", path: null });
  command(["btrfs", "subvolume", "delete", "--commit-after", join(POOL, "roots", gone.id)]);
  command(["btrfs", "subvolume", "sync", POOL]);
  manager = await restart({});
  const recovered = await status();
  note("crash", { recovered });
  const records = new Map((await call<{ records: NativePoolRecord[] }>({ operation: "listPoolRecovery", after: null })).records.map(item => [item.id, item]));
  expect(records.get(lost)?.state, "REFERENCE_POOL_CRASH_RESERVED_STAYS_CHARGED").toBe("reserved");
  expect(records.get(adopted.id)?.state, "REFERENCE_POOL_CRASH_CREATE_ADOPTED").toBe("writable");
  expect(records.get(pending.id)?.state, "REFERENCE_POOL_CRASH_DELETING_STAYS_CHARGED").toBe("deleting");
  expect(["deleted", "reclaimed"], "REFERENCE_POOL_CRASH_DELETE_RECONCILED").toContain(records.get(gone.id)?.state ?? "missing");
  for (const id of [lost, adopted.id, pending.id, gone.id, live.id]) expect(["deleted", "reclaimed"]).toContain((await release(id)).state);
  expect((await refusal({ operation: "poolCreate", id: lost, purpose: "source", from: null, allowanceBytes: 4 * MIB })).code, "REFERENCE_POOL_RELEASED_ID_FENCED").toBe("released");
}

// 11. Stale identity: a different root at the recorded path is never used or deleted.
{
  const fenced = await create("source", 4 * MIB);
  command(["btrfs", "subvolume", "delete", "--commit-after", fenced.path!]);
  command(["btrfs", "subvolume", "create", fenced.path!]);
  const stale = await refusal({ operation: "poolRelease", id: fenced.id });
  expect(stale.code, "REFERENCE_POOL_STALE_IDENTITY_REFUSED").toBe("unknown");
  expect(existsSync(fenced.path!), "REFERENCE_POOL_STALE_ROOT_NOT_DELETED").toBe(true);
  expect((await status()).refusal?.code, "REFERENCE_POOL_UNRECORDED_ROOT_REFUSES_ADMISSION").toBe("unknown");
  command(["btrfs", "subvolume", "delete", "--commit-after", fenced.path!]);
  command(["btrfs", "subvolume", "sync", POOL]);
  expect((await status()).refusal?.message, "REFERENCE_POOL_MISSING_ROOT_REFUSES_ADMISSION").toMatch(/is missing/);
  expect(["deleted", "reclaimed"], "REFERENCE_POOL_VANISHED_ROOT_RECONCILED").toContain((await release(fenced.id)).state);
}

// 12. Unknown evidence: foreign qgroup and nested subvolume.
{
  // quota_override needs CAP_SYS_RESOURCE, which this fixture withholds; the unit suite covers its refusal.
  expect(readFileSync(`/sys/fs/btrfs/${config.referencePool!.fsid}/quota_override`, "utf8").trim(), "REFERENCE_POOL_OVERRIDE_OFF").toBe("0");
  command(["btrfs", "qgroup", "create", "1/77", POOL]);
  expect((await status()).refusal?.message, "REFERENCE_POOL_FOREIGN_QGROUP_UNKNOWN").toMatch(/no recorded owner/);
  command(["btrfs", "qgroup", "destroy", "1/77", POOL]);
  const nest = await create("worktree", 4 * MIB);
  command(["btrfs", "subvolume", "create", join(nest.path!, "escape")]);
  expect((await status()).refusal?.message, "REFERENCE_POOL_NESTED_ROOT_UNKNOWN").toMatch(/nested/);
  command(["btrfs", "subvolume", "delete", "--commit-after", join(nest.path!, "escape")]);
  command(["btrfs", "subvolume", "sync", POOL]);
  expect(["deleted", "reclaimed"]).toContain((await release(nest.id)).state);
  const healthy = await status();
  expect(healthy.refusal?.message ?? null, "REFERENCE_POOL_RECOVERS_AFTER_EVIDENCE_CLEARS").toBeNull();
}

// 13. Pool ENOSPC: recovery still records outcomes through emergency allocation; admission refuses.
{
  const victim = await create("staging", 8 * MIB);
  fill(join(victim.path!, "cargo.bin"), 4 * MIB);
  let filled = "";
  try { fill(join(POOL, "filler.bin"), 4 * 1024 ** 3); } catch (error) { filled = (error as NodeJS.ErrnoException).code ?? String(error); }
  note("enospc", { filled });
  expect(filled, "REFERENCE_POOL_FILLER_REACHES_ENOSPC").toBe("ENOSPC");
  const full = await status();
  expect(full.refusal, "REFERENCE_POOL_FULL_STATUS_STILL_REPORTS").not.toBeNull();
  expect(full.accounting?.availableBytes ?? -1, "REFERENCE_POOL_FULL_NO_SPENDABLE").toBeLessThan(0);
  expect((await refusal({ operation: "poolCreate", id: randomUUID(), purpose: "source", from: null, allowanceBytes: 4 * MIB })).code).toBe("capacity");
  expect(["deleted", "reclaimed"], "REFERENCE_POOL_RECOVERY_UNDER_ENOSPC").toContain((await release(victim.id)).state);
  unlinkSync(join(POOL, "filler.bin")); sync();
  manager = await restart({});
  expect((await status()).qualified, "REFERENCE_POOL_REARMED_AFTER_RESTART").toBe(true);
}

// 14. Restart reconstruction and the deterministic host projection.
{
  const kept = await create("source", 4 * MIB);
  const before = await call<{ records: NativePoolRecord[] }>({ operation: "listPoolRecovery", after: null });
  await manager.close();
  const served = await serveNativeBrainManager(config);
  try {
    const client = createNativeBrainManagerClient({ socketPath: config.socketPath, timeoutMs: 20_000 });
    expect((await client.listPoolRecovery()).records, "REFERENCE_POOL_RESTART_RECONSTRUCTS").toEqual(before.records);
    writeFileSync("/native-runtime/config.json", JSON.stringify(config)); chmodSync("/native-runtime/config.json", 0o600);
    // The manager serves from this process: a synchronous child would block its event loop.
    const cli = async (...args: string[]) => {
      const child = Bun.spawn(["/usr/local/bin/bun", "/repo/packages/ui-sdk/src/bin/brain-native-store.ts", "pool", ...args, "/native-runtime/config.json"], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
      return { code, value: JSON.parse(stdout), stderr };
    };
    const projected = await cli("status");
    note("cli", projected);
    expect(projected.code, "REFERENCE_POOL_CLI_STATUS").toBe(0);
    expect(projected.value, "REFERENCE_POOL_CLI_SHAPE").toMatchObject({ schema_version: 1, ok: true, action: "status", status: { qualified: true, fsid: config.referencePool!.fsid } });
    const released = await cli("release", kept.id);
    expect(released.code).toBe(0);
    expect(released.value, "REFERENCE_POOL_CLI_RELEASE").toMatchObject({ schema_version: 1, ok: true, action: "release", record: { id: kept.id, state: "reclaimed" } });
  } finally { await served.close(); }
  manager = await createNativeBrainManager(config);
}
const final = await charged();
note("final", { baseline: baseline.chargedBytes, final: final.chargedBytes, counts: (await status()).counts });
expect(Math.abs(final.chargedBytes - baseline.chargedBytes), "REFERENCE_POOL_ALL_RECLAIMED").toBeLessThanOrEqual(4 * MIB);
await manager.close();
note("passed", {});

async function restart(overrides: Partial<NativeBrainManagerConfig>): Promise<Manager> {
  await manager.close();
  return createNativeBrainManager({ ...config, ...overrides });
}
