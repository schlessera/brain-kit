/** Real reference-pool qualification on owned Btrfs loop volumes (#2428). Runs only inside reference-pool-fixture.py. */
import { expect } from "bun:test";
import { closeSync, existsSync, linkSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, truncateSync, unlinkSync, writeFileSync, writeSync, chmodSync, renameSync } from "node:fs";
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

// 15. Worker-visible publication (#2429): a sandbox binds one whole view, so a
// name swap reaches its next path read while staging and other views stay out.
{
  const VIEW = randomUUID(), OTHER = randomUUID();
  const write = (root: string, text: string) => writeFileSync(join(root, "README.md"), text);
  const first = await create("source", 4 * MIB);
  write(first.path!, "revision one\n");
  await seal(first.id);
  const published = await call<NativePoolRecord>({ operation: "poolPublish", id: first.id, view: VIEW, name: "ithaca" });
  expect(published, "REFERENCE_VIEW_PUBLISHED_RECORD").toMatchObject({ id: first.id, view: VIEW, state: "sealed", path: join(POOL, "views", VIEW, first.id) });
  expect(statSync(published.path!).mode & 0o7777, "REFERENCE_VIEW_SEALED_ROOT_READABLE").toBe(0o755);
  const hidden = await create("source", 4 * MIB);
  write(hidden.path!, "another domain\n");
  await seal(hidden.id);
  await call<NativePoolRecord>({ operation: "poolPublish", id: hidden.id, view: OTHER, name: "ithaca" });
  // One long-lived reader, like a worker between tool calls: it holds an open
  // file and a working directory from the first revision, then reads by path.
  const script = "cd /mnt/reference/ithaca && exec 3<README.md\nwhile read cmd; do case \"$cmd\" in\n"
    + "path) cat /mnt/reference/ithaca/README.md 2>/dev/null || echo MISSING;;\nfd) cat /proc/self/fd/3;;\ncwd) cat README.md 2>/dev/null || echo MISSING;;\n"
    + "list) ls -A /mnt/reference | sort | tr '\\n' ' '; echo;;\npool) ls " + POOL + " 2>&1 | head -1;;\nesac\necho @@\ndone\n";
  const reader = Bun.spawn(["bwrap", "--ro-bind", "/", "/", "--tmpfs", POOL, "--tmpfs", "/mnt", "--ro-bind", join(POOL, "views", VIEW), "/mnt/reference", "--proc", "/proc", "--dev", "/dev",
    "--unshare-pid", "--die-with-parent", "--", "/bin/sh", "-c", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const lines = reader.stdout.getReader(); let buffered = "";
  const ask = async (cmd: string) => {
    reader.stdin.write(cmd + "\n"); reader.stdin.flush();
    while (!buffered.includes("@@\n")) { const chunk = await lines.read(); if (chunk.done) throw Error(`reference reader exited: ${await new Response(reader.stderr).text()}`); buffered += new TextDecoder().decode(chunk.value); }
    const at = buffered.indexOf("@@\n"), answer = buffered.slice(0, at).trim(); buffered = buffered.slice(at + 3); return answer;
  };
  expect(await ask("path"), "REFERENCE_VIEW_READER_SEES_PUBLISHED").toBe("revision one");
  expect(await ask("list"), "REFERENCE_VIEW_ONLY_ITS_OWN_DOMAIN").toBe(`${first.id} ithaca`);
  expect(await ask("pool"), "REFERENCE_VIEW_POOL_MASKED").toBe("");
  // Refresh: a writable snapshot is staging, invisible until it is complete and published.
  const second = await create("source", 4 * MIB, first.id);
  write(second.path!, "revision two, partial");
  expect(await ask("path"), "REFERENCE_VIEW_STAGING_NOT_PUBLISHED").toBe("revision one");
  expect((await refusal({ operation: "poolPublish", id: second.id, view: VIEW, name: "ithaca" })).code, "REFERENCE_VIEW_PARTIAL_PUBLISH_REFUSED").toBe("invalid");
  expect(await ask("path"), "REFERENCE_VIEW_PARTIAL_NEVER_VISIBLE").toBe("revision one");
  write(second.path!, "revision two\n");
  await seal(second.id);
  const swapped = await call<NativePoolRecord>({ operation: "poolPublish", id: second.id, view: VIEW, name: "ithaca" });
  note("publication", { first: published, second: swapped });
  expect(await ask("path"), "REFERENCE_VIEW_EXISTING_READER_SEES_REFRESH").toBe("revision two");
  expect(await ask("fd"), "REFERENCE_VIEW_OPEN_FILE_KEEPS_ITS_REVISION").toBe("revision one");
  expect(await ask("cwd"), "REFERENCE_VIEW_MULTI_STEP_READ_MAY_SPAN_REVISIONS").toBe("revision one");
  expect((await refusal({ operation: "poolPublish", id: second.id, view: OTHER, name: "ithaca" })).code, "REFERENCE_VIEW_ONE_VIEW_PER_ROOT").toBe("invalid");
  // Unpublish removes the name for the next read; the root stays charged until released.
  expect(await call<{ removed: boolean }>({ operation: "poolUnpublish", view: VIEW, name: "ithaca" }), "REFERENCE_VIEW_UNPUBLISHED").toMatchObject({ removed: true });
  expect(await ask("path"), "REFERENCE_VIEW_UNPUBLISHED_NAME_GONE").toBe("MISSING");
  // Withdrawal moves the root out of the view: no reader can reach it by identity either.
  expect(await ask("list"), "REFERENCE_VIEW_IDENTITY_LISTED_BEFORE_WITHDRAW").toContain(first.id);
  expect((await call<NativePoolRecord>({ operation: "poolWithdraw", id: first.id })).view, "REFERENCE_VIEW_WITHDRAWN_RECORD").toBeNull();
  expect(await ask("list"), "REFERENCE_VIEW_WITHDRAWN_IDENTITY_GONE").not.toContain(first.id);
  expect(await ask("fd"), "REFERENCE_VIEW_WITHDRAW_KEEPS_OPEN_FILE").toBe("revision one");
  // A publication retried after an interrupted reseal reseals the root before exposing it.
  command(["btrfs", "property", "set", "-ts", join(POOL, "views", VIEW, second.id), "ro", "false"]);
  await call<NativePoolRecord>({ operation: "poolPublish", id: second.id, view: VIEW, name: "ithaca" });
  expect(command(["btrfs", "property", "get", "-ts", join(POOL, "views", VIEW, second.id), "ro"]).trim(), "REFERENCE_VIEW_REPUBLISH_RESEALS").toBe("ro=true");
  expect(await ask("path"), "REFERENCE_VIEW_REPUBLISHED").toBe("revision two");
  reader.stdin.end(); reader.kill("SIGKILL"); await reader.exited;
  // A publish interrupted after its rename, before its record: restart adopts the moved root.
  const moved = await create("source", 4 * MIB);
  await seal(moved.id);
  command(["btrfs", "property", "set", "-ts", join(POOL, "roots", moved.id), "ro", "false"]);
  renameSync(join(POOL, "roots", moved.id), join(POOL, "views", VIEW, moved.id));
  manager = await restart({});
  expect(command(["btrfs", "property", "get", "-ts", join(POOL, "views", VIEW, moved.id), "ro"]).trim(), "REFERENCE_VIEW_CRASH_UNSEALED_RESEALED").toBe("ro=true");
  expect((await status()).refusal, "REFERENCE_VIEW_CRASH_RENAME_RECONCILED").toBeNull();
  const adopted = (await call<{ records: NativePoolRecord[] }>({ operation: "listPoolRecovery", after: null })).records.find(item => item.id === moved.id);
  expect(adopted?.view, "REFERENCE_VIEW_CRASH_RENAME_ADOPTED").toBe(VIEW);
  await call<NativePoolRecord>({ operation: "poolPublish", id: second.id, view: VIEW, name: "ithaca" });
  for (const id of [first.id, second.id, hidden.id, moved.id]) expect(["deleted", "reclaimed"], "REFERENCE_VIEW_RELEASED").toContain((await release(id)).state);
  expect(existsSync(join(POOL, "views", VIEW, "ithaca")) || (() => { try { return Boolean(readlinkSync(join(POOL, "views", VIEW, "ithaca"))); } catch { return false; } })(),
    "REFERENCE_VIEW_RELEASE_REMOVES_ITS_NAMES").toBe(false);
}

// 16. Acquisition (#2429): the real reference service and its real transport
// workers fetch and check out a 1,200-file Odysseus repository into a
// quota-limited pool root, publish it, and a sandbox bound to its view reads it.
{
  const { createUiDb } = await import("../../packages/ui-server/src/db/client.js");
  const { createPrincipal } = await import("../../packages/ui-server/src/db/principals.js");
  const { createReferenceGrant } = await import("../../packages/ui-server/src/db/reference-grants.js");
  const { createReferenceSources } = await import("../../packages/ui-server/src/brain/reference-source.js");
  const { createReferenceTransport } = await import("../../packages/ui-server/src/brain/reference-transport.js");
  const srv = "/native-runtime/srv", work = "/native-runtime/ithaca-work";
  mkdirSync(srv, { recursive: true }); mkdirSync(work, { recursive: true });
  const gitIn = (cwd: string, ...args: string[]) => command(["git", "-C", cwd, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@ithaca.example", ...args]);
  gitIn(work, "init", "-q", "-b", "main");
  for (let book = 0; book < 24; book++) {
    mkdirSync(join(work, "odyssey", `book-${book}`), { recursive: true });
    for (let line = 0; line < 50; line++) writeFileSync(join(work, "odyssey", `book-${book}`, `line-${line}.md`), `Ithaca chart: book ${book}, line ${line}.\n`);
  }
  gitIn(work, "add", "."); gitIn(work, "commit", "-q", "-m", "Odysseus charts the way home");
  command(["git", "clone", "-q", "--bare", work, join(srv, "ithaca.git")]);
  const db = createUiDb(":memory:");
  const penelope = createPrincipal(db, { authMethod: "password", label: "Penelope", ttlSeconds: 86_400 });
  createReferenceGrant(db, { brain: "ithaca", principalId: penelope.id, repositoryPrefix: `file://${srv}`, credential: null, createdBy: penelope.id, now: Date.now() });
  const pool: import("../../packages/ui-server/src/brain/reference-source.js").ReferencePool = {
    poolStatus: () => status(),
    poolCreate: (id: string, purpose: NativePoolRecord["purpose"], from: string | null, allowanceBytes: number) => call<NativePoolRecord>({ operation: "poolCreate", id, purpose, from, allowanceBytes }),
    poolSeal: (id: string) => seal(id),
    poolRelease: (id: string) => release(id),
    poolPublish: (id: string, view: string, name: string) => call<NativePoolRecord>({ operation: "poolPublish", id, view, name }),
    poolView: (view: string) => call<{ view: string; path: string }>({ operation: "poolView", view }),
    poolUnpublish: (view: string, name: string) => call<{ view: string; name: string; removed: boolean }>({ operation: "poolUnpublish", view, name }),
    poolWithdraw: (id: string) => call<NativePoolRecord>({ operation: "poolWithdraw", id }),
    listPoolRecovery: (after: string | null = null) => call<{ records: NativePoolRecord[]; next: string | null }>({ operation: "listPoolRecovery", after }),
  };
  const sources = createReferenceSources({ db, pool, transport: createReferenceTransport({ brainPath: "/brain-fixture/brain" }), brain: "ithaca", credentials: {} });
  const lease = await sources.request({ principalId: penelope.id, repository: `file://${srv}/ithaca.git`, revision: "main" });
  const record = (await call<{ records: NativePoolRecord[] }>({ operation: "listPoolRecovery", after: null })).records.find(item => item.view === lease.view && item.state === "sealed")!;
  note("acquisition", { lease: { ...lease, release: undefined }, record });
  expect(lease, "REFERENCE_ACQUISITION_PRIVATE_FILE_SOURCE").toMatchObject({ domain: "private", stale: false, commit: gitIn(join(srv, "ithaca.git"), "rev-parse", "main").trim() });
  expect(record.ownerBytes!, "REFERENCE_ACQUISITION_CHARGED_TO_ITS_ROOT").toBeGreaterThan(256 * 1024);
  expect(record.ownerBytes!, "REFERENCE_ACQUISITION_WITHIN_ALLOWANCE").toBeLessThanOrEqual(32 * MIB);
  const count = command(["bwrap", "--ro-bind", "/", "/", "--tmpfs", POOL, "--tmpfs", "/mnt", "--ro-bind", lease.viewPath, "/mnt/reference", "--proc", "/proc", "--dev", "/dev",
    "--unshare-pid", "--die-with-parent", "--", "/bin/sh", "-c", `find /mnt/reference/${lease.name}/odyssey -type f | wc -l; cat /mnt/reference/${lease.name}/odyssey/book-23/line-49.md`]);
  expect(count, "REFERENCE_ACQUISITION_WORKER_INSPECTS_THROUGH_VIEW").toBe("1200\nIthaca chart: book 23, line 49.\n");
  lease.release();
  await sources.revoke({ grantIds: [], principalIds: [penelope.id] }).catch(() => {});
  db.query("UPDATE reference_grants SET revoked_at = 1").run();
  await sources.revoke({ grantIds: [], principalIds: [penelope.id] });
  await sources.close();
  expect((await call<{ records: NativePoolRecord[] }>({ operation: "listPoolRecovery", after: null })).records.filter(item => item.view === lease.view && item.state === "sealed"),
    "REFERENCE_ACQUISITION_WITHDRAWN_ROOT_RELEASED").toEqual([]);
  db.close();
}

// 17. Managed worktrees (#2430): a writable snapshot of sealed source is
// isolated from it, its read-only checkpoints feed metadata deltas, and an
// access generation bound into an already running non-root sandbox gains
// exactly the granted worktree without any mount in that namespace.
{
  const { parseNativeBrainDelta } = await import("../../packages/ui-sdk/src/server/native-brain-delta.js");
  type Checkpoint = NativePoolRecord & { transaction: string; readOnly: true };
  const base = await create("source", 4 * MIB);
  mkdirSync(join(base.path!, "odyssey"), { mode: 0o775 });
  for (const book of ["book-1.md", "book-2.md"]) { writeFileSync(join(base.path!, "odyssey", book), `Ithaca ${book}\n`); chmodSync(join(base.path!, "odyssey", book), 0o664); }
  chmodSync(join(base.path!, "odyssey"), 0o775); command(["chown", "-R", "0:1000", join(base.path!, "odyssey")]);
  await seal(base.id);
  const tree = await create("worktree", 16 * MIB, base.id), other = await create("worktree", 16 * MIB, base.id);
  // Copy-on-write isolation: worktree edits never reach the shared source.
  writeFileSync(join(tree.path!, "odyssey", "book-1.md"), "Penelope's loom, rewoven\n");
  expect(readFileSync(join(POOL, "roots", base.id, "odyssey", "book-1.md"), "utf8"), "REFERENCE_WORKTREE_SOURCE_UNCHANGED").toBe("Ithaca book-1.md\n");
  let sourceWrite = "";
  try { writeFileSync(join(POOL, "roots", base.id, "odyssey", "book-2.md"), "overwritten"); } catch (error) { sourceWrite = (error as NodeJS.ErrnoException).code ?? String(error); }
  expect(sourceWrite, "REFERENCE_WORKTREE_SOURCE_READ_ONLY").toBe("EROFS");
  // Checkpoints are read-only snapshots of one worktree, and deltas stay inside it.
  const first = await call<Checkpoint>({ operation: "poolCheckpoint", id: randomUUID(), from: tree.id });
  expect(first, "REFERENCE_CHECKPOINT_SEALED").toMatchObject({ purpose: "checkpoint", from: tree.id, state: "sealed", readOnly: true });
  expect(command(["btrfs", "property", "get", "-ts", first.path!, "ro"]).trim(), "REFERENCE_CHECKPOINT_READ_ONLY").toBe("ro=true");
  writeFileSync(join(tree.path!, "odyssey", "book-3.md"), "The suitors' feast\n");
  rmSync(join(tree.path!, "odyssey", "book-2.md"));
  const second = await call<Checkpoint>({ operation: "poolCheckpoint", id: randomUUID(), from: tree.id });
  const response = await manager.run({ operation: "poolDelta", from: first.id, to: second.id } as never);
  const framed = (await import("../../packages/ui-sdk/src/server/native-brain-manager-client.js")).decodeNativeDelta(response.body!, 64 * MIB);
  const changed = new Set<string>();
  for await (const candidate of parseNativeBrainDelta(framed.stream, { before: { uuid: first.root!.uuid, transaction: BigInt(first.transaction) },
    after: { uuid: second.root!.uuid, transaction: BigInt(second.transaction) } })) for (const path of candidate.paths) changed.add(path);
  await framed.completed;
  note("worktree-delta", { changed: [...changed] });
  expect([...changed].sort(), "REFERENCE_WORKTREE_DELTA_NAMES_EDITS").toEqual(expect.arrayContaining(["odyssey/book-2.md", "odyssey/book-3.md"]));
  expect(changed.has("odyssey/book-1.md"), "REFERENCE_WORKTREE_DELTA_ONLY_SINCE_ITS_CHECKPOINT").toBe(false);
  const foreign = await call<Checkpoint>({ operation: "poolCheckpoint", id: randomUUID(), from: other.id });
  expect((await refusal({ operation: "poolDelta", from: first.id, to: foreign.id })).code, "REFERENCE_WORKTREE_DELTA_ONE_LINEAGE").toBe("invalid");
  expect((await refusal({ operation: "poolCheckpoint", id: randomUUID(), from: base.id })).code, "REFERENCE_CHECKPOINT_ONLY_OF_A_WORKTREE").toBe("unknown");
  expect((await refusal({ operation: "poolCreate", id: randomUUID(), purpose: "worktree", from: first.id, allowanceBytes: 4 * MIB })).code,
    "REFERENCE_WORKTREE_NEVER_FROM_A_CHECKPOINT").toBe("unknown");
  // An access generation is one root-owned directory a running non-root sandbox binds whole.
  const ACCESS = randomUUID(), SECOND_ACCESS = randomUUID();
  const opened = await call<{ access: string; path: string; roots: string[] }>({ operation: "poolAccessOpen", access: ACCESS });
  expect(opened, "REFERENCE_ACCESS_OPENED_EMPTY").toEqual({ access: ACCESS, path: join(POOL, "access", ACCESS), roots: [] });
  // Production masks hide every generation from every worker; each worker binds only its own.
  expect((await call<{ privatePaths: string[] }>({ operation: "ready" })).privatePaths, "REFERENCE_ACCESS_GENERATIONS_MASKED_FOR_WORKERS").toContain(join(POOL, "access"));
  await call({ operation: "poolAccessOpen", access: SECOND_ACCESS });
  const script = "while read cmd; do case \"$cmd\" in\n"
    + "list) ls -A /tmp/brain-worktrees | sort | tr '\\n' ' '; echo;;\n"
    + "read) cat /tmp/brain-worktrees/" + tree.id + "/odyssey/book-1.md 2>/dev/null || echo MISSING;;\n"
    + "edit) printf 'Telemachus returns\\n' > /tmp/brain-worktrees/" + tree.id + "/odyssey/book-1.md && printf 'Argos waits\\n' > /tmp/brain-worktrees/" + tree.id + "/odyssey/book-4.md && echo EDITED || echo REFUSED;;\n"
    + "sibling) mkdir /tmp/brain-worktrees/intruder 2>/dev/null && echo CREATED || echo REFUSED;;\n"
    + "pool) ls " + POOL + " 2>&1 | head -1;;\nwho) id -u;;\nesac\necho @@\ndone\n";
  const worker = Bun.spawn(["bwrap", "--ro-bind", "/", "/", "--tmpfs", POOL, "--tmpfs", "/tmp", "--bind", opened.path, "/tmp/brain-worktrees", "--proc", "/proc", "--dev", "/dev",
    "--unshare-pid", "--die-with-parent", "--", "/usr/bin/setpriv", "--reuid=1001", "--regid=1000", "--clear-groups", "/bin/sh", "-c", script], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  const lines = worker.stdout.getReader(); let buffered = "";
  const ask = async (cmd: string) => {
    worker.stdin.write(cmd + "\n"); worker.stdin.flush();
    while (!buffered.includes("@@\n")) { const chunk = await lines.read(); if (chunk.done) throw Error(`worktree worker exited: ${await new Response(worker.stderr).text()}`); buffered += new TextDecoder().decode(chunk.value); }
    const at = buffered.indexOf("@@\n"), answer = buffered.slice(0, at).trim(); buffered = buffered.slice(at + 3); return answer;
  };
  expect(await ask("who"), "REFERENCE_ACCESS_WORKER_NOT_ROOT").toBe("1001");
  expect(await ask("list"), "REFERENCE_ACCESS_STARTS_EMPTY").toBe("");
  expect(await ask("pool"), "REFERENCE_ACCESS_POOL_MASKED").toBe("");
  const granted = await call<NativePoolRecord>({ operation: "poolAccess", id: tree.id, access: ACCESS });
  expect(granted, "REFERENCE_ACCESS_RECORDED").toMatchObject({ id: tree.id, access: ACCESS, state: "writable", path: join(opened.path, tree.id) });
  await call({ operation: "poolAccess", id: other.id, access: SECOND_ACCESS });
  expect(await ask("list"), "REFERENCE_ACCESS_GRANT_VISIBLE_TO_RUNNING_WORKER").toBe(tree.id);
  expect(await ask("read"), "REFERENCE_ACCESS_WORKER_READS_ITS_WORKTREE").toBe("Penelope's loom, rewoven");
  expect(await ask("edit"), "REFERENCE_ACCESS_WORKER_EDITS_WORKTREE").toBe("EDITED");
  expect(readFileSync(join(opened.path, tree.id, "odyssey", "book-4.md"), "utf8"), "REFERENCE_ACCESS_EDIT_LANDS_IN_WORKTREE").toBe("Argos waits\n");
  expect(readFileSync(join(POOL, "roots", base.id, "odyssey", "book-1.md"), "utf8"), "REFERENCE_ACCESS_EDIT_NEVER_REACHES_SOURCE").toBe("Ithaca book-1.md\n");
  expect(await ask("sibling"), "REFERENCE_ACCESS_GENERATION_NOT_WRITABLE").toBe("REFUSED");
  expect((await refusal({ operation: "poolAccess", id: tree.id, access: SECOND_ACCESS })).code, "REFERENCE_ACCESS_NO_CROSS_GENERATION").toBe("invalid");
  expect((await refusal({ operation: "poolAccess", id: base.id, access: ACCESS })).code, "REFERENCE_ACCESS_ONLY_WORKTREES").toBe("unknown");
  expect((await status()).refusal, "REFERENCE_ACCESS_ACCOUNTED").toBeNull();
  // #2729: the pool's own release refuses a granted worktree, atomically with grants, so no
  // second process can delete what a generation holds; nothing is deleted and the charge stays.
  const heldBefore = await charged();
  const heldRefusal = await refusal({ operation: "poolRelease", id: tree.id });
  const heldRecord = (await call<{ records: NativePoolRecord[] }>({ operation: "listPoolRecovery", after: null })).records.find(item => item.id === tree.id);
  note("access-held-release", { refusal: heldRefusal, record: heldRecord });
  expect({ code: heldRefusal.code, state: heldRecord?.state, access: heldRecord?.access, read: await ask("read"), charged: (await charged()).chargedBytes },
    "REFERENCE_ACCESS_HELD_NOT_RELEASED").toEqual({ code: "invalid", state: "writable", access: ACCESS, read: "Telemachus returns", charged: heldBefore.chargedBytes });
  // Parking returns the worktree to the masked roots: the next lookup misses it.
  expect((await call<NativePoolRecord>({ operation: "poolPark", id: tree.id })).access, "REFERENCE_ACCESS_PARKED_RECORD").toBeNull();
  expect(await ask("read"), "REFERENCE_ACCESS_PARKED_GONE").toBe("MISSING");
  // A grant interrupted after its rename, before its record: restart adopts the actual generation.
  renameSync(join(POOL, "roots", tree.id), join(opened.path, tree.id));
  manager = await restart({});
  const adopted = (await call<{ records: NativePoolRecord[] }>({ operation: "listPoolRecovery", after: null })).records.find(item => item.id === tree.id);
  expect((await status()).refusal, "REFERENCE_ACCESS_CRASH_RECONCILED").toBeNull();
  expect((await call<{ records: NativePoolRecord[] }>({ operation: "listPoolRecovery", after: null })).records.find(item => item.id === tree.id)?.access,
    "REFERENCE_ACCESS_CRASH_ADOPTED").toBe(ACCESS);
  note("access-adopted", { adopted });
  expect(await ask("read"), "REFERENCE_ACCESS_ADOPTED_STILL_VISIBLE").toBe("Telemachus returns");
  const closed = await call<{ roots: string[] }>({ operation: "poolAccessClose", access: ACCESS });
  expect(closed.roots, "REFERENCE_ACCESS_CLOSE_PARKS").toEqual([tree.id]);
  expect(existsSync(opened.path), "REFERENCE_ACCESS_CLOSE_REMOVES_GENERATION").toBe(false);
  expect(await ask("list"), "REFERENCE_ACCESS_CLOSED_EMPTY").toBe("");
  await call({ operation: "poolAccessClose", access: SECOND_ACCESS });
  worker.stdin.end(); worker.kill("SIGKILL"); await worker.exited;
  // Released checkpoints are forgotten once reclaimed, so identities stay bounded.
  for (const checkpoint of [first, second, foreign]) expect(["deleted", "reclaimed"], "REFERENCE_CHECKPOINT_RELEASED").toContain((await release(checkpoint.id)).state);
  sync(); await status();
  const remaining = (await call<{ records: NativePoolRecord[] }>({ operation: "listPoolRecovery", after: null })).records.map(item => item.id);
  expect(remaining.filter(id => [first.id, second.id, foreign.id].includes(id)), "REFERENCE_CHECKPOINT_IDENTITY_FORGOTTEN").toEqual([]);
  expect((await release(first.id)).state, "REFERENCE_CHECKPOINT_RELEASE_RETRY_RECLAIMED").toBe("reclaimed");
  expect((await refusal({ operation: "poolCheckpoint", id: first.id, from: tree.id })).code, "REFERENCE_CHECKPOINT_NEVER_RECREATED").toBe("released");
  // The forgotten identity survives a manager restart, so a retry after a lost reply still reads as reclaimed.
  manager = await restart({});
  const retried = await release(second.id);
  expect(retried, "REFERENCE_CHECKPOINT_RELEASE_RETRY_AFTER_RESTART").toMatchObject({ id: second.id, purpose: "checkpoint", state: "reclaimed" });
  expect((await call<{ records: NativePoolRecord[] }>({ operation: "listPoolRecovery", after: null })).records.some(item => item.id === second.id),
    "REFERENCE_CHECKPOINT_RETRY_LEAVES_NO_TOMBSTONE").toBe(false);
  for (const id of [tree.id, other.id, base.id]) expect(["deleted", "reclaimed"], "REFERENCE_WORKTREE_RELEASED").toContain((await release(id)).state);
}

// 18. Managed worktree lifecycle and journal (#2430): the real services
// allocate a worktree from acquired source, cover it in the turn journal and
// grant it to a running non-root sandbox. Its edits are journaled from the
// worktree's own checkpoints and counted by scope; reads are not work.
{
  const { createUiDb } = await import("../../packages/ui-server/src/db/client.js");
  const { createPrincipal } = await import("../../packages/ui-server/src/db/principals.js");
  const { createReferenceGrant } = await import("../../packages/ui-server/src/db/reference-grants.js");
  const { createReferenceSources } = await import("../../packages/ui-server/src/brain/reference-source.js");
  const { createReferenceTransport } = await import("../../packages/ui-server/src/brain/reference-transport.js");
  const { createReferenceWorktrees, referenceWorktreeDependents } = await import("../../packages/ui-server/src/brain/reference-worktrees.js");
  const { createTurnJournal } = await import("../../packages/ui-server/src/brain/turn-journal.js");
  const { referenceWorktreeJournalPath } = await import("../../packages/ui-server/src/brain/reference-worktree-journal.js");
  const { prepareWorkerSandbox, workerCommand } = await import("../../packages/ui-sdk/src/server/worker-launcher.js");
  const srv = "/native-runtime/srv", state = "/native-runtime/case-18";
  mkdirSync(state, { recursive: true });
  await manager.close();
  const served = await serveNativeBrainManager(config);
  const client = createNativeBrainManagerClient({ socketPath: config.socketPath, timeoutMs: 20_000 });
  const db = createUiDb(join(state, "ui.db"));
  try {
    const penelope = createPrincipal(db, { authMethod: "password", label: "Penelope", ttlSeconds: 86_400 });
    createReferenceGrant(db, { brain: "ithaca", principalId: penelope.id, repositoryPrefix: `file://${srv}`, credential: null, createdBy: penelope.id, now: Date.now() });
    const sources = createReferenceSources({ db, pool: client, transport: createReferenceTransport({ brainPath: "/brain-fixture/brain" }), brain: "ithaca", credentials: {},
      dependents: rootId => referenceWorktreeDependents(db, rootId) });
    const journal = createTurnJournal(db, { nativeManager: client, brainPath: "/brain-fixture/brain", dbPath: join(state, "ui.db"), objectsRoot: join(state, "objects"), referencePool: client });
    const facts = new Map<string, { changedPaths: number; partial: boolean }>();
    journal.onObservation((turnId, value) => facts.set(turnId, value));
    const worktrees = createReferenceWorktrees({ db, pool: client, sources, coverage: (input, signal) => journal.attachWorktree(input.turnId, input.worktreeId, signal) });
    const repository = `file://${srv}/ithaca.git`, commit = command(["git", "--git-dir", join(srv, "ithaca.git"), "rev-parse", "main"]).trim();
    const sandbox = (generation: string, script: string) => command(["bwrap", "--ro-bind", "/", "/", "--tmpfs", POOL, "--tmpfs", "/tmp", "--bind", generation, "/tmp/brain-worktrees",
      "--proc", "/proc", "--dev", "/dev", "--unshare-pid", "--die-with-parent", "--", "/usr/bin/setpriv", "--reuid=1001", "--regid=1000", "--groups=0", "/bin/sh", "-c", script]);
    const turn = async (turnId: string) => {
      await journal.begin(turnId, { sessionId: "ithaca", actor: "interactive", model: null, profile: "governed", policyHash: null }, error => { throw error; });
      return worktrees.openGeneration({ principalId: penelope.id, turnId, profile: "governed" });
    };
    const edited = await worktrees.allocate({ principalId: penelope.id, repository, revision: "main" });
    expect(edited, "REFERENCE_WORKTREE_NATIVE_FIXED_COMMIT").toMatchObject({ domain: "private", commit, state: "active" });
    const first = await turn("turn-18-edit");
    await worktrees.access({ worktreeId: edited.id, principalId: penelope.id, generation: first.id });
    expect(journal.worktrees("turn-18-edit"), "REFERENCE_WORKTREE_NATIVE_COVERED_BEFORE_GRANT").toEqual([edited.id]);
    // The checkout is group-writable, so a worker identity in the app group edits files it did not create.
    const output = sandbox(first.path, `cd /tmp/brain-worktrees/${edited.id} && cat odyssey/book-1/line-1.md && { printf 'Ithaca chart, corrected.\\n' > odyssey/book-0/line-0.md && printf 'Argos waits.\\n' > odyssey/argos.md && echo EDITED || echo REFUSED; } 2>/dev/null`);
    expect(output, "REFERENCE_WORKTREE_WORKER_EDITS_CHECKOUT").toBe("Ithaca chart: book 1, line 1.\nEDITED\n");
    await journal.observe();
    const rows = (turnId: string) => (db.query("SELECT path,scope,after_json FROM turn_journal_changes WHERE turn_id=? ORDER BY path").all(turnId) as { path: string; scope: string; after_json: string | null }[]);
    note("worktree-journal", { rows: rows("turn-18-edit"), facts: facts.get("turn-18-edit") });
    expect(rows("turn-18-edit").map(row => row.path), "REFERENCE_WORKTREE_NATIVE_EDITS_JOURNALED")
      .toEqual([referenceWorktreeJournalPath(edited.id, "odyssey/argos.md"), referenceWorktreeJournalPath(edited.id, "odyssey/book-0/line-0.md")]);
    expect(rows("turn-18-edit").every(row => row.scope === "reference_worktree" && JSON.parse(row.after_json!).hash), "REFERENCE_WORKTREE_NATIVE_VERSIONS_RETAINED").toBe(true);
    expect(facts.get("turn-18-edit"), "REFERENCE_WORKTREE_NATIVE_SCOPE_COUNTS").toMatchObject({ changedPaths: 2, partial: false });
    // The production launcher binds the generation with the production masks.
    const masks = (await client.ready()).privatePaths;
    const launched = workerCommand({ brainPath: "/brain-fixture/brain", env: { PATH: "/usr/bin:/bin" },
      sandbox: { ...prepareWorkerSandbox("/brain-fixture/brain", { profile: "strict", areas: [], maskPaths: masks }), worktrees: { source: first.path } },
      command: ["/bin/sh", "-c", `ls -A /tmp/brain-worktrees; cat /tmp/brain-worktrees/${edited.id}/odyssey/argos.md; for d in roots views access; do ls -A ${POOL}/$d 2>/dev/null | wc -l; done`] });
    const production = Bun.spawnSync(launched, { stdout: "pipe", stderr: "pipe", env: {} });
    note("worktree-production-launch", { code: production.exitCode, stderr: production.stderr.toString().slice(-2000) });
    expect(production.stdout.toString(), "REFERENCE_WORKTREE_PRODUCTION_LAUNCH_SEES_ONLY_ITS_GRANT").toBe(`${edited.id}\nArgos waits.\n0\n0\n0\n`);
    await journal.finish("turn-18-edit");
    await worktrees.closeGeneration(first.id);
    const records = async () => {
      const all: NativePoolRecord[] = [];
      for (let after: string | null = null; ;) { const page = await client.listPoolRecovery(after); all.push(...page.records); if (!page.next) return all; after = page.next; }
    };
    expect((await records()).find(record => record.id === edited.id)?.access, "REFERENCE_WORKTREE_NATIVE_PARKED_AFTER_TURN").toBeNull();
    expect((await records()).filter(record => record.purpose === "checkpoint" && record.state === "sealed" && record.from === edited.id).length,
      "REFERENCE_WORKTREE_NATIVE_JOURNAL_CHECKPOINTS_RELEASED").toBe(1);
    const released = await worktrees.release({ worktreeId: edited.id, principalId: penelope.id });
    note("worktree-released", { cleanup: released.cleanup });
    expect(released.cleanup, "REFERENCE_WORKTREE_NATIVE_UNPRESERVED").toMatchObject({ owner: "none", work: "unpreserved", changedPaths: 3, eligible: false,
      sample: ["odyssey", "odyssey/argos.md", "odyssey/book-0/line-0.md"] });
    // Reading is not work: access-time updates never make a worktree ineligible.
    const read = await worktrees.allocate({ principalId: penelope.id, repository, revision: "main" });
    const second = await turn("turn-18-read");
    await worktrees.access({ worktreeId: read.id, principalId: penelope.id, generation: second.id });
    expect(sandbox(second.path, `cat /tmp/brain-worktrees/${read.id}/odyssey/*/line-*.md | wc -l`).trim(), "REFERENCE_WORKTREE_NATIVE_READS").toBe("1200");
    await journal.finish("turn-18-read");
    expect(rows("turn-18-read"), "REFERENCE_WORKTREE_NATIVE_READS_NOT_JOURNALED").toEqual([]);
    await worktrees.closeGeneration(second.id);
    expect((await worktrees.release({ worktreeId: read.id, principalId: penelope.id })).cleanup, "REFERENCE_WORKTREE_NATIVE_READS_ARE_NOT_WORK")
      .toMatchObject({ owner: "none", work: "none", changedPaths: 0, eligible: true });
    // #2431: release removed the clean worktree, credited only on the pool's observed reclamation.
    const receipt = (id: string) => db.query("SELECT state, trigger FROM reference_worktree_cleanups WHERE worktree_id = ?").get(id) as { state: string; trigger: string } | null;
    for (let attempt = 0; attempt < 10 && receipt(read.id)?.state !== "reclaimed"; attempt++) { sync(); await client.poolStatus(); await worktrees.reconcile(); }
    note("worktree-clean-removed", { receipt: receipt(read.id), record: (await records()).find(record => record.id === read.id) });
    expect({ receipt: receipt(read.id), state: (await records()).find(record => record.id === read.id)?.state }, "REFERENCE_WORKTREE_NATIVE_CLEAN_REMOVED")
      .toEqual({ receipt: { state: "reclaimed", trigger: "automatic" }, state: "reclaimed" });
    expect((await records()).filter(record => record.purpose === "checkpoint" && record.from === read.id && record.state === "sealed"), "REFERENCE_WORKTREE_NATIVE_CLEAN_CHECKPOINTS_RELEASED").toEqual([]);
    // Swapping two directories through a temporary name leaves every name in place, and is still work.
    const swapped = await worktrees.allocate({ principalId: penelope.id, repository, revision: "main" });
    const third = await turn("turn-18-swap");
    await worktrees.access({ worktreeId: swapped.id, principalId: penelope.id, generation: third.id });
    expect(sandbox(third.path, `cd /tmp/brain-worktrees/${swapped.id}/odyssey && mv book-2 swap && mv book-3 book-2 && mv swap book-3 && echo SWAPPED`).trim(), "REFERENCE_WORKTREE_NATIVE_SWAPPED").toBe("SWAPPED");
    await journal.finish("turn-18-swap");
    await worktrees.closeGeneration(third.id);
    const swapFacts = (await worktrees.release({ worktreeId: swapped.id, principalId: penelope.id })).cleanup;
    note("worktree-swap", { cleanup: swapFacts });
    expect(swapFacts, "REFERENCE_WORKTREE_NATIVE_SWAP_IS_WORK").toMatchObject({ owner: "none", work: "unpreserved", eligible: false });
    // #2431: retained work waits for human review, which removes exactly the reviewed worktree.
    const { createReferenceWorktreeHygiene } = await import("../../packages/ui-server/src/brain/reference-worktree-hygiene.js");
    const { createHygieneReview } = await import("../../packages/ui-server/src/inbox/hygiene-review.js");
    const { createInboxStore } = await import("../../packages/ui-server/src/inbox/store.js");
    const core = await import("@schlessera/brain/internal");
    const hygiene = createReferenceWorktreeHygiene({ db, worktrees, core: async () => core, brainPath: "/brain-fixture/brain" });
    const brain = { hygiene: async (args: string[]) => {
      if (args[0] === "next") return { finding: null, counts: { eligibleRemaining: 0, fixed: 0, dismissed: 0, snoozed: 0, nextSnoozeDueAt: null, informationalNotShown: 0 } };
      if (args[0] === "list") return { entries: [] };
      throw Error(`A managed worktree operation reached the CLI: ${args.join(" ")}`);
    } };
    const review = createHygieneReview(db, { brain: brain as never, worktrees: hygiene });
    const card = (await review.command(penelope.id, "start")).action!;
    const target = (card.hygiene!.finding as { path: string }).path.slice("reference-worktree://".length), kept = target === edited.id ? swapped.id : edited.id;
    note("worktree-review-card", { card });
    for (const secret of [srv, "ithaca.git", commit, "argos", "book-", penelope.id])
      expect(JSON.stringify(card).includes(secret), `REFERENCE_WORKTREE_NATIVE_PRIVATE_CARD_OPAQUE ${secret}`).toBe(false);
    expect([edited.id, swapped.id], "REFERENCE_WORKTREE_NATIVE_RETAINED_REVIEWED").toContain(target);
    const targetPath = (await records()).find(record => record.id === target)!.path!;
    await review.resolver.resolveAsync(penelope.id, { type: "inbox_resolve", itemId: card.id, optionId: "delete-worktree" });
    for (let attempt = 0; attempt < 10 && receipt(target)?.state !== "reclaimed"; attempt++) { sync(); await client.poolStatus(); await worktrees.reconcile(); }
    note("worktree-reviewed-removal", { receipt: receipt(target), record: (await records()).find(record => record.id === target) });
    expect({ item: createInboxStore(db).getItem(card.id)?.status, receipt: receipt(target), state: (await records()).find(record => record.id === target)?.state, present: existsSync(targetPath) },
      "REFERENCE_WORKTREE_NATIVE_REVIEWED_REMOVAL").toEqual({ item: "resolved", receipt: { state: "reclaimed", trigger: "review" }, state: "reclaimed", present: false });
    const keptRecord = (await records()).find(record => record.id === kept)!;
    expect({ state: keptRecord.state, receipt: receipt(kept), files: existsSync(join(keptRecord.path!, "odyssey")) }, "REFERENCE_WORKTREE_NATIVE_UNREVIEWED_KEPT")
      .toEqual({ state: "writable", receipt: null, files: true });
    const sourceRoot = (await records()).find(record => record.id === keptRecord.from)!;
    expect({ source: sourceRoot.state, commit: command(["git", "--git-dir", join(srv, "ithaca.git"), "rev-parse", "main"]).trim() }, "REFERENCE_WORKTREE_NATIVE_SOURCE_UNTOUCHED")
      .toEqual({ source: "sealed", commit });
    // #2432: the agent tools over the real services. A view opens empty before
    // anything is published there, and a production-launched worker reads
    // shared source and edits its worktree only at the paths the tools return.
    const { createReferenceTools } = await import("../../packages/ui-server/src/brain/reference-tools.js");
    const tools = createReferenceTools({ sources, worktrees });
    const telemachus = createPrincipal(db, { authMethod: "password", label: "Telemachus", ttlSeconds: 86_400 });
    const empty = (await sources.bindable(telemachus.id)).private, emptyInfo = statSync(empty);
    expect({ entries: readdirSync(empty), uid: emptyInfo.uid, mode: emptyInfo.mode & 0o7777 }, "REFERENCE_VIEW_OPENED_BEFORE_PUBLICATION").toEqual({ entries: [], uid: 0, mode: 0o755 });
    const toolTurn = await turn("turn-18-tools");
    const views = (await tools.begin("turn-18-tools", { principalId: penelope.id, posture: "interactive", generation: toolTurn }))!;
    const shared = await tools.call("turn-18-tools", penelope.id, { tool: "reference_source", input: { repository, revision: "main" } });
    const asked = await tools.call("turn-18-tools", penelope.id, { tool: "reference_worktree", input: { action: "request", repository, revision: "main" } });
    note("reference-tools", { read: shared, asked });
    if (!shared.ok || !("source" in shared) || !asked.ok || !("worktree" in asked)) throw new Error(`REFERENCE_TOOLS_NATIVE_RESULTS ${JSON.stringify({ read: shared, asked })}`);
    expect({ source: shared.source.path?.startsWith("/tmp/brain-reference/private/"), worktree: asked.worktree.path, commit: asked.worktree.startingCommit },
      "REFERENCE_TOOLS_NATIVE_PATHS").toEqual({ source: true, worktree: `/tmp/brain-worktrees/${asked.worktree.id}`, commit });
    const toolLaunch = workerCommand({ brainPath: "/brain-fixture/brain", env: { PATH: "/usr/bin:/bin" },
      sandbox: { ...prepareWorkerSandbox("/brain-fixture/brain", { profile: "strict", areas: [], maskPaths: masks }), worktrees: { source: toolTurn.path }, references: views },
      command: ["/bin/sh", "-c", `find ${shared.source.path}/odyssey -type f | wc -l; { printf x > ${shared.source.path}/odyssey/raft.md && echo SOURCE_WRITTEN || echo SOURCE_READ_ONLY; } 2>/dev/null; `
        // The view itself: only a read-only bind refuses this to a root worker.
        + `{ mkdir /tmp/brain-reference/private/raft && echo VIEW_WRITTEN || echo VIEW_READ_ONLY; } 2>/dev/null; `
        + `printf 'Penelope weaves.\\n' > ${asked.worktree.path}/odyssey/loom.md && echo WORKTREE_WRITTEN; for d in roots views access; do ls -A ${POOL}/$d 2>/dev/null | wc -l; done`] });
    const toolRun = Bun.spawnSync(toolLaunch, { stdout: "pipe", stderr: "pipe", env: {} });
    note("reference-tools-production-launch", { code: toolRun.exitCode, stdout: toolRun.stdout.toString(), stderr: toolRun.stderr.toString().slice(-2000) });
    expect({ code: toolRun.exitCode, stdout: toolRun.stdout.toString() }, "REFERENCE_TOOLS_NATIVE_WORKER_READS_SOURCE_AND_EDITS_WORKTREE")
      .toEqual({ code: 0, stdout: "1200\nSOURCE_READ_ONLY\nVIEW_READ_ONLY\nWORKTREE_WRITTEN\n0\n0\n0\n" });
    await journal.observe();
    expect(rows("turn-18-tools").map(row => row.path), "REFERENCE_TOOLS_NATIVE_ONLY_WORKTREE_EDIT_JOURNALED").toEqual([referenceWorktreeJournalPath(asked.worktree.id, "odyssey/loom.md")]);
    expect(facts.get("turn-18-tools"), "REFERENCE_TOOLS_NATIVE_READS_DO_NOT_COUNT").toMatchObject({ changedPaths: 1, partial: false });
    const renewed = await tools.call("turn-18-tools", penelope.id, { tool: "reference_worktree", input: { action: "renew", worktreeId: asked.worktree.id } });
    expect(renewed, "REFERENCE_TOOLS_NATIVE_RENEW").toMatchObject({ ok: true, action: "renew" });
    tools.end("turn-18-tools");
    await worktrees.retireGeneration(toolTurn.id);
    await journal.finish("turn-18-tools");
    await worktrees.closeGeneration(toolTurn.id);
    expect((await worktrees.release({ worktreeId: asked.worktree.id, principalId: penelope.id })).cleanup, "REFERENCE_TOOLS_NATIVE_EDIT_RETAINED")
      .toMatchObject({ work: "unpreserved", eligible: false });
    // #2432 option 1: a bind validates a held lapsed source again through the real
    // transport, and withholds it once the check fails. A two-second lifetime lapses
    // between binds yet outlasts a check; a separate catalog keeps its own views.
    {
      const { createUiDb } = await import("../../packages/ui-server/src/db/client.js");
      const lapsedDb = createUiDb(join(state, "lapsed.db"));
      try {
        const ithacan = createPrincipal(lapsedDb, { authMethod: "password", label: "Eurycleia", ttlSeconds: 86_400 });
        createReferenceGrant(lapsedDb, { brain: "ithaca", principalId: ithacan.id, repositoryPrefix: `file://${srv}`, credential: null, createdBy: ithacan.id, now: Date.now() });
        const lapsing = createReferenceSources({ db: lapsedDb, pool: client, transport: createReferenceTransport({ brainPath: "/brain-fixture/brain" }), brain: "ithaca",
          credentials: {}, limits: { validationMs: 2_000 } });
        const held = await lapsing.request({ principalId: ithacan.id, repository, revision: "main" });
        await Bun.sleep(2_100);
        const view = (await lapsing.bindable(ithacan.id)).private;
        const before = (lapsedDb.query("SELECT validated_at FROM reference_sources").get() as { validated_at: number }).validated_at;
        expect({ bound: readdirSync(view).includes(held.name), revalidated: before > held.validatedAt }, "REFERENCE_TOOLS_NATIVE_HELD_SOURCE_REVALIDATED_AT_BIND")
          .toEqual({ bound: true, revalidated: true });
        renameSync(join(srv, "ithaca.git"), join(srv, "ithaca.git.away"));
        try {
          await Bun.sleep(2_100);
          await lapsing.bindable(ithacan.id);
          expect(readdirSync(view), "REFERENCE_TOOLS_NATIVE_FAILED_REVALIDATION_WITHHELD").toEqual([]);
        } finally { renameSync(join(srv, "ithaca.git.away"), join(srv, "ithaca.git")); }
        held.release();
        // Its roots go as in the other cases: revoking the grant withdraws what is left, and storage follows.
        lapsedDb.query("UPDATE reference_grants SET revoked_at = 1").run();
        await lapsing.revoke({ grantIds: [], principalIds: [ithacan.id] });
        for (let attempt = 0; attempt < 200 && (lapsedDb.query("SELECT count(*) AS n FROM reference_roots").get() as { n: number }).n; attempt++) await Bun.sleep(10);
        await lapsing.close();
      } finally { lapsedDb.close(); }
    }
    // The proof releases the roots review left.
    for (const record of await records()) if (record.purpose === "checkpoint" && (record.state === "sealed")) await client.poolRelease(record.id);
    for (const id of [edited.id, read.id, swapped.id, asked.worktree.id]) expect(["deleted", "reclaimed"], "REFERENCE_WORKTREE_NATIVE_RELEASED").toContain((await client.poolRelease(id)).state);
    db.query("DELETE FROM reference_worktrees").run();
    await worktrees.close(); await journal.close();
    db.query("UPDATE reference_grants SET revoked_at = 1").run();
    await sources.revoke({ grantIds: [], principalIds: [penelope.id] });
    await sources.close();
  } finally { db.close(); await served.close(); }
  manager = await createNativeBrainManager(config);
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
