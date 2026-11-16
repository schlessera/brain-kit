/**
 * Turn data trees on the managed volume (#2911): the manager's admission
 * charge, reserve headroom, reader refusal, observed reclamation and
 * identity fences. Real manager, intents and filesystem; only privileged
 * kernel operations are doubled.
 */
import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as inspection from "../src/server/native-identity-inspector";
import * as stages from "../src/server/native-brain-stage";
import { createNativeBrainManager } from "../src/server/native-brain-manager";
import type { NativeStage, NativeTurnTree } from "../src/server/native-brain-manager-protocol";
import { nativeTurnTreeReaders } from "../src/server/native-turn-trees";

const id = (n: number) => `29110000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) try { await cleanup(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Native turn-tree fixture cleanup failed");
});

/** Real manager, intents and filesystem; only privileged kernel operations are doubled. */
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "odysseus-native-trees-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { storePath: root, devicePath: join(root, "device"), socketPath: join(root, "manager.sock"),
    fsid: id(1), brainUuid: "a".repeat(32), capacityBytes: 1024 ** 3, recoveryReserveBytes: 4096,
    appUid: 1000, appGid: 1000, stageAllowanceBytes: 4096, stageBudgetBytes: 4096 };
  const state = join(root, ".brain-native/state"), stageRoot = join(root, ".brain-native/stages"), treeRoot = join(root, ".brain-native/trees");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 }); fs.chmodSync(state, 0o700); fs.chmodSync(dirname(state), 0o710);
  fs.mkdirSync(stageRoot, { mode: 0o710 }); fs.chmodSync(stageRoot, 0o710);
  /** Processes the reader census sees, each with its mountinfo text. */
  const processes = new Map<string, string>();
  const commands: string[][] = [], owners: Array<{ path: string; uid: number; gid: number }> = [];
  let bavail = 1000, failSync = false;
  const lstat = fs.lstatSync, stat = fs.statSync, fstat = fs.fstatSync, read = fs.readFileSync, list = fs.readdirSync, exists = fs.existsSync;
  let inspectionError: string | undefined;
  const faults: Array<{ mockRestore(): void }> = [
    spyOn(process, "geteuid").mockReturnValue(0),
    spyOn(fs, "chownSync").mockImplementation(((path: string, uid: number, gid: number) => { owners.push({ path, uid, gid }); }) as typeof fs.chownSync),
    spyOn(fs, "existsSync").mockImplementation(path => path === join(stageRoot, id(2)) && inspectionError ? false : exists(path)),
    spyOn(fs, "lstatSync").mockImplementation(((path: string, options?: never) => {
      if (path === join(stageRoot, id(2)) && inspectionError) throw Object.assign(Error(inspectionError), { code: inspectionError });
      const value = lstat(path, options); value.uid = 0;
      if (!path.startsWith(root)) value.mode &= ~0o022;
      return value;
    }) as typeof fs.lstatSync),
    spyOn(fs, "fstatSync").mockImplementation(((...args: Parameters<typeof fs.fstatSync>) => {
      const value = fstat(...args); value.uid = 0; return value;
    }) as typeof fs.fstatSync),
    spyOn(fs, "statSync").mockImplementation(((path: string, options?: never) => {
      if (path === config.devicePath) return { isBlockDevice: () => true, rdev: 256n };
      if (["/usr/bin/btrfs", "/usr/bin/python3", "/usr/bin/fallocate"].includes(path)) return { isFile: () => true, uid: 0, mode: 0o755 };
      return stat(path, options);
    }) as typeof fs.statSync),
    spyOn(fs, "readFileSync").mockImplementation(((path: string | number, options?: never) => {
      if (path === "/proc/self/mountinfo") return `41 25 0:38 / ${root} rw - btrfs ${config.devicePath} rw\n`;
      if (path === "/sys/dev/block/1:0/size") return String(config.capacityBytes / 512);
      if (path === `/sys/fs/btrfs/${config.fsid}/devices/device/dev`) return "1:0";
      const proc = /^\/proc\/([0-9]+)\/mountinfo$/.exec(String(path));
      if (proc) { const text = processes.get(proc[1]!); if (text === undefined) throw Object.assign(Error("gone"), { code: "ENOENT" }); return text; }
      return read(path, options);
    }) as typeof fs.readFileSync),
    spyOn(fs, "readdirSync").mockImplementation(((path: string, options?: never) =>
      path === `/sys/fs/btrfs/${config.fsid}/devices` ? ["device"] : path === "/proc" ? ["self", ...processes.keys()] : path === state ? list(path).sort() : list(path, options)) as typeof fs.readdirSync),
    spyOn(fs, "statfsSync").mockImplementation((() => ({ type: 0x9123683e, bavail, bsize: 4096 })) as unknown as typeof fs.statfsSync),
    spyOn(inspection, "createNativeIdentityInspector").mockReturnValue({ launches: 0, async close() {}, async run(_program, path) {
      return { code: 0, errors: "", text: JSON.stringify({ fsid: config.fsid, devices: 1, uuid: path === join(root, "brain") ? config.brainUuid : "b".repeat(32),
        parentUuid: config.brainUuid, receivedUuid: "0".repeat(32), rootId: "256", transaction: "1", readOnly: path !== join(root, "brain") }) };
    } }),
    spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
      let errors = "", code = 0;
      commands.push(argv);
      if (argv[0] === "/usr/bin/python3") fs.rmSync(argv.at(-1)!, { recursive: true, force: true });
      else if (argv[0] === "/usr/bin/fallocate") fs.writeFileSync(argv[3]!, new Uint8Array(Number(argv[2])));
      else if (argv[1] === "qgroup") { errors = "quota not enabled"; code = 1; }
      else if (argv[2] === "snapshot") fs.mkdirSync(argv[5]!);
      else if (argv[1] === "filesystem" && argv[2] === "sync" && failSync) { errors = "Odysseus's filesystem commit stalled"; code = 1; }
      else if (argv[2] !== "list" && argv[2] !== "sync") throw Error(`Unexpected native command: ${argv}`);
      return { stdout: new Response("").body!, stderr: new Response(errors).body!, exited: Promise.resolve(code), kill() {} };
    }) as typeof Bun.spawn),
  ];
  let closeStage = async () => {};
  const prepared: NativeStage[] = [];
  faults.push(spyOn(stages, "startNativeStage").mockImplementation(async options => {
    const stage: NativeStage = { ...options, namespacePid: process.pid, namespaceStart: "1", rootDevice: "1", rootInode: "2" };
    prepared.push(stage);
    return { stage, mountNamespaceInode: "1", mergedDevice: "1", mergedInode: "2", async close() { await closeStage(); },
      async read() { return { async close() {} }; }, async *inspect() {} };
  }));
  cleanups.push(() => { for (const fault of faults.reverse()) fault.mockRestore(); });
  return { config, state, stageRoot, treeRoot, prepared, processes, commands, owners, setAvailablePages(pages: number) { bavail = pages; }, setFailSync(fail: boolean) { failSync = fail; }, setInspectionError(code?: string) { inspectionError = code; },
    setCloseStage(close: () => Promise<void>) { closeStage = close; },
    async manager(override: Partial<typeof config> = {}) {
      const manager = await createNativeBrainManager({ ...config, ...override });
      let closed = false;
      const close = async () => { if (!closed) { closed = true; closeStage = async () => {}; await manager.close(); } };
      cleanups.push(close); return { ...manager, close };
    } };
}


const PAGE = 4096;
const prepare = async (manager: { run: (request: never) => Promise<Response> }, n: number, pages: number) =>
  (await (await manager.run({ operation: "prepareTurnTree", id: id(n), allowanceBytes: pages * PAGE } as never)).json()) as NativeTurnTree;
const release = async (manager: { run: (request: never) => Promise<Response> }, n: number) =>
  (await (await manager.run({ operation: "releaseTurnTree", id: id(n) } as never)).json()) as { id: string; state: string };
/** One worker's read-only bind of `path` (inside the store filesystem, device 0:38), as mountinfo lists it. */
const bind = (path: string, device = "0:38") => `120 41 ${device} ${path} /tmp/brain-worker-data ro,nosuid,nodev - btrfs /dev/odysseus rw\n`;
const intent = (f: { state: string }, n: number) => JSON.parse(fs.readFileSync(join(f.state, `${id(n)}.json`), "utf8"));

test("a turn tree is an app-owned directory outside the live brain and every checkpoint", async () => {
  const f = fixture(), manager = await f.manager();
  const tree = await prepare(manager, 2, 250);
  expect(tree.path, "TREE_UNDER_MANAGER_AREA").toBe(join(f.treeRoot, id(2)));
  expect(tree.path.startsWith(join(f.config.storePath, "brain") + "/") || tree.path.startsWith(join(f.config.storePath, ".brain-native/checkpoints") + "/"),
    "TREE_OUTSIDE_BRAIN_AND_CHECKPOINTS").toBe(false);
  expect(f.owners, "TREE_OWNED_BY_THE_APP_IDENTITY").toContainEqual({ path: tree.path, uid: 1000, gid: 1000 });
  expect(fs.statSync(tree.path).mode & 0o777, "WORKER_GROUP_CAN_ONLY_TRAVERSE").toBe(0o710);
  expect(fs.statSync(f.treeRoot).mode & 0o777).toBe(0o710);
  expect(intent(f, 2)).toMatchObject({ kind: "tree", state: "sealed", treeRequest: { allowanceBytes: 250 * PAGE } });
  expect(await prepare(manager, 2, 250), "LOST_REPLY_RETRY_RETURNS_SAME_TREE").toEqual(tree);
  await expect(prepare(manager, 2, 251), "TREE_ALLOWANCE_IS_FIXED").rejects.toMatchObject({ code: "invalid" });
  await expect(manager.run({ operation: "release", id: id(2) }), "TREE_IS_NOT_A_CHECKPOINT").rejects.toMatchObject({ code: "invalid" });
  await expect(manager.run({ operation: "checkpoint", id: id(2) }), "TREE_IS_NOT_A_CHECKPOINT").rejects.toMatchObject({ code: "invalid" });
  await manager.run({ operation: "checkpoint", id: id(3) });
  await expect(manager.run({ operation: "releaseTurnTree", id: id(3) }), "CHECKPOINT_IS_NOT_A_TREE").rejects.toMatchObject({ code: "invalid" });
  await expect(manager.run({ operation: "prepareTurnTree", id: id(3), allowanceBytes: PAGE }), "CHECKPOINT_IS_NOT_A_TREE").rejects.toMatchObject({ code: "invalid" });
  await expect(manager.run({ operation: "prepareTurnTree", id: id(4), allowanceBytes: PAGE + 1 }), "TREE_ALLOWANCE_IS_WHOLE_PAGES").rejects.toMatchObject({ code: "capacity" });
});

test("admission charges live allowances plus one emergency reserve of headroom, and refuses near capacity", async () => {
  // 1000 free pages; the configured reserve is one page.
  const f = fixture(), manager = await f.manager();
  await prepare(manager, 2, 500);
  await prepare(manager, 3, 499);
  await expect(prepare(manager, 4, 1), "REFUSES_PAST_RESERVE_HEADROOM").rejects.toMatchObject({ code: "capacity" });
  expect(fs.existsSync(join(f.treeRoot, id(4))) || fs.existsSync(join(f.state, `${id(4)}.json`)), "REFUSAL_RUNS_NOTHING").toBe(false);
  // Live trees' growth lowers free space; admission sees it without a larger limit.
  await release(manager, 3);
  f.setAvailablePages(600);
  await expect(prepare(manager, 5, 100), "OBSERVED_ALLOCATION_COUNTS").rejects.toMatchObject({ code: "capacity" });
  expect((await prepare(manager, 6, 99)).id, "ADMITS_UP_TO_RESERVE_HEADROOM").toBe(id(6));
});

test("release credits the charge only after removal and an observed filesystem commit", async () => {
  const f = fixture(), manager = await f.manager();
  const tree = await prepare(manager, 2, 990);
  fs.mkdirSync(join(tree.path, "data/notes"), { recursive: true });
  fs.writeFileSync(join(tree.path, "data/notes/ithaca.md"), "Odysseus returns.\n");
  fs.symlinkSync("/etc", join(tree.path, "data/escape"));
  await expect(prepare(manager, 3, 10)).rejects.toMatchObject({ code: "capacity" });
  f.setFailSync(true);
  const before = f.commands.length;
  await expect(release(manager, 2), "UNOBSERVED_COMMIT_REFUSES").rejects.toThrow("commit stalled");
  expect(intent(f, 2).state).toBe("deleting");
  await expect(prepare(manager, 3, 10), "UNOBSERVED_RECLAMATION_RETAINS_CHARGE").rejects.toMatchObject({ code: "capacity" });
  f.setFailSync(false);
  expect(await release(manager, 2)).toEqual({ id: id(2), state: "deleted" });
  const after = f.commands.slice(before);
  const removal = after.findIndex(argv => argv[0] === "/usr/bin/python3" && argv.at(-1) === tree.path);
  const commit = after.findLastIndex(argv => argv[1] === "filesystem" && argv[2] === "sync");
  expect(removal, "MANAGER_REMOVES_THE_TREE").toBeGreaterThanOrEqual(0);
  expect(commit, "COMMIT_OBSERVED_AFTER_REMOVAL").toBeGreaterThan(removal);
  expect(fs.existsSync(tree.path)).toBe(false);
  expect(fs.existsSync("/etc"), "A_LINK_IN_THE_TREE_IS_NOT_FOLLOWED").toBe(true);
  expect((await prepare(manager, 3, 10)).id, "RECLAIMED_CHARGE_IS_CREDITED").toBe(id(3));
});

test("a tree a worker still mounts is neither removed nor credited", async () => {
  const f = fixture(), manager = await f.manager();
  const tree = await prepare(manager, 2, 990);
  await prepare(manager, 3, 1);
  // Mounts of another tree or another filesystem are no readers of this one.
  f.processes.set("4241", bind(`/.brain-native/trees/${id(3)}/data`));
  f.processes.set("4243", bind(`/.brain-native/trees/${id(2)}/data`, "0:99"));
  f.processes.set("4242", bind(`/.brain-native/trees/${id(2)}/index\\040(deleted)`));
  await expect(release(manager, 2), "LIVE_READER_REFUSES_CLEANUP").rejects.toMatchObject({ code: "unavailable" });
  expect(fs.existsSync(tree.path), "LIVE_READER_KEEPS_THE_TREE").toBe(true);
  expect(intent(f, 2).state).toBe("sealed");
  await expect(prepare(manager, 4, 9), "LIVE_READER_KEEPS_THE_CHARGE").rejects.toMatchObject({ code: "capacity" });
  f.processes.delete("4242");
  expect(await release(manager, 2)).toEqual({ id: id(2), state: "deleted" });
  expect(fs.existsSync(join(f.treeRoot, id(3))), "PEER_TREE_UNTOUCHED").toBe(true);
});

test("restart keeps live trees charged, and released or foreign identities are never recreated or removed", async () => {
  const f = fixture();
  let manager = await f.manager();
  const tree = await prepare(manager, 2, 900);
  await manager.close();
  manager = await f.manager();
  await expect(prepare(manager, 3, 200), "RESTART_RETAINS_TREE_CHARGE").rejects.toMatchObject({ code: "capacity" });
  expect(await prepare(manager, 2, 900), "RESTART_RETAINS_LIVE_TREE").toEqual(tree);
  await release(manager, 2);
  await expect(prepare(manager, 2, 900), "RELEASED_TREE_CANNOT_BE_RECREATED").rejects.toMatchObject({ code: "released" });
  expect(await release(manager, 7)).toEqual({ id: id(7), state: "deleted" });
  await expect(prepare(manager, 7, 1), "DELAYED_CREATE_IS_FENCED").rejects.toMatchObject({ code: "released" });
  fs.mkdirSync(join(f.treeRoot, id(8)));
  fs.writeFileSync(join(f.treeRoot, id(8), "penelope.md"), "Not this turn's.\n");
  await expect(release(manager, 8), "FOREIGN_TREE_NOT_DELETED").rejects.toMatchObject({ code: "unknown" });
  expect(fs.existsSync(join(f.treeRoot, id(8), "penelope.md"))).toBe(true);
  await expect(prepare(manager, 8, 1), "FOREIGN_TREE_NOT_ADOPTED").rejects.toMatchObject({ code: "unknown" });
});

test("an unreadable tree receipt restricts tree admission only", async () => {
  const f = fixture();
  let manager = await f.manager();
  await prepare(manager, 2, 100);
  await manager.close();
  fs.writeFileSync(join(f.state, `${id(2)}.json`), "{broken");
  manager = await f.manager();
  // Its independent allowance record still bounds its charge.
  await expect(prepare(manager, 3, 900), "QUARANTINED_TREE_STAYS_CHARGED").rejects.toMatchObject({ code: "capacity" });
  expect((await prepare(manager, 4, 800)).id).toBe(id(4));
  await expect(release(manager, 2), "QUARANTINED_TREE_IS_NOT_REMOVED").rejects.toThrow("quarantined");
  await manager.close();
  fs.unlinkSync(join(f.treeRoot, `${id(2)}.allowance`));
  manager = await f.manager();
  await expect(prepare(manager, 5, 1), "UNKNOWN_TREE_CHARGE_REFUSES_AS_RECOVERY").rejects.toMatchObject({ code: "unknown", message: expect.stringContaining("diagnostics") });
  expect((await (await manager.run({ operation: "checkpoint", id: id(6) })).json()).id, "QUARANTINE_IS_PROPORTIONATE").toBe(id(6));
});

test("the reader census reads every process's mounts and refuses what it cannot read", () => {
  const proc = fs.mkdtempSync(join(tmpdir(), "odysseus-proc-"));
  cleanups.push(() => fs.rmSync(proc, { recursive: true, force: true }));
  for (const [pid, text] of [["11", bind("/.brain-native/trees/a/data")], ["12", bind("/.brain-native/trees/ab/data")], ["13", bind("/.brain-native/trees/a", "0:7")]] as const) {
    fs.mkdirSync(join(proc, pid)); fs.writeFileSync(join(proc, pid, "mountinfo"), text);
  }
  fs.mkdirSync(join(proc, "14"));
  fs.mkdirSync(join(proc, "self"));
  expect(nativeTurnTreeReaders("0:38", "/.brain-native/trees/a", proc), "CENSUS_MATCHES_ONLY_THIS_TREE").toEqual([11]);
  fs.mkdirSync(join(proc, "15")); fs.mkdirSync(join(proc, "15", "mountinfo"));
  expect(() => nativeTurnTreeReaders("0:38", "/.brain-native/trees/a", proc), "UNREADABLE_CENSUS_IS_NOT_EMPTY").toThrow();
});
