import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as inspection from "../src/server/native-identity-inspector";
import * as stages from "../src/server/native-brain-stage";
import { createNativeBrainManager } from "../src/server/native-brain-manager";
import type { NativeManagerReady, NativeStage } from "../src/server/native-brain-manager-protocol";

const id = (n: number) => `38160000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  const failures: unknown[] = [];
  for (const cleanup of cleanups.splice(0).reverse()) try { await cleanup(); } catch (error) { failures.push(error); }
  if (failures.length) throw new AggregateError(failures, "Native capacity fixture cleanup failed");
});

/** Real manager, intents and filesystem; only privileged kernel operations are doubled. */
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "odysseus-native-capacity-"));
  cleanups.push(() => fs.rmSync(root, { recursive: true, force: true }));
  const config = { storePath: root, devicePath: join(root, "device"), socketPath: join(root, "manager.sock"),
    fsid: id(1), brainUuid: "a".repeat(32), capacityBytes: 1024 ** 3, recoveryReserveBytes: 4096,
    appUid: 1000, appGid: 1000, stageAllowanceBytes: 4096, stageBudgetBytes: 4096 };
  const state = join(root, ".brain-native/state"), stageRoot = join(root, ".brain-native/stages");
  fs.mkdirSync(state, { recursive: true, mode: 0o700 }); fs.chmodSync(dirname(state), 0o710);
  fs.mkdirSync(stageRoot, { mode: 0o710 });
  const lstat = fs.lstatSync, stat = fs.statSync, fstat = fs.fstatSync, read = fs.readFileSync, list = fs.readdirSync, exists = fs.existsSync;
  let inspectionError: string | undefined;
  const faults: Array<{ mockRestore(): void }> = [
    spyOn(process, "geteuid").mockReturnValue(0),
    spyOn(fs, "chownSync").mockImplementation(() => {}),
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
      return read(path, options);
    }) as typeof fs.readFileSync),
    spyOn(fs, "readdirSync").mockImplementation(((path: string, options?: never) =>
      path === `/sys/fs/btrfs/${config.fsid}/devices` ? ["device"] : list(path, options)) as typeof fs.readdirSync),
    spyOn(fs, "statfsSync").mockReturnValue({ type: 0x9123683e, bavail: 1000, bsize: 4096 } as fs.StatsFs),
    spyOn(inspection, "createNativeIdentityInspector").mockReturnValue({ launches: 0, async close() {}, async run(_program, path) {
      return { code: 0, errors: "", text: JSON.stringify({ fsid: config.fsid, devices: 1, uuid: path === join(root, "brain") ? config.brainUuid : "b".repeat(32),
        parentUuid: config.brainUuid, receivedUuid: "0".repeat(32), rootId: "256", transaction: "1", readOnly: path !== join(root, "brain") }) };
    } }),
    spyOn(Bun, "spawn").mockImplementation(((argv: string[]) => {
      let errors = "", code = 0;
      if (argv[0] === "/usr/bin/fallocate") fs.writeFileSync(argv[3]!, new Uint8Array(Number(argv[2])));
      else if (argv[1] === "qgroup") { errors = "quota not enabled"; code = 1; }
      else if (argv[2] === "snapshot") fs.mkdirSync(argv[5]!);
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
  return { config, state, stageRoot, prepared, setInspectionError(code?: string) { inspectionError = code; },
    setCloseStage(close: () => Promise<void>) { closeStage = close; },
    async manager(override: Partial<typeof config> = {}) {
      const manager = await createNativeBrainManager({ ...config, ...override });
      let closed = false;
      const close = async () => { if (!closed) { closed = true; closeStage = async () => {}; await manager.close(); } };
      cleanups.push(close); return { ...manager, close };
    } };
}

test("malformed receipt without a stage admits a healthy stage at a one-allowance budget", async () => {
  const f = fixture(); fs.writeFileSync(join(f.state, `${id(2)}.json`), "{broken");
  for (let boot = 0; boot < 2; boot++) {
    const manager = await f.manager();
    await manager.run({ operation: "checkpoint", id: id(3 + boot * 10) });
    const stage = await manager.run({ operation: "prepareStage", id: id(4 + boot * 10), checkpointId: id(3 + boot * 10), allowanceBytes: 4096 });
    expect((await stage.json()).id, "NATIVE_ABSENT_STAGE_SINGLE_SLOT_PREPARES").toBe(id(4 + boot * 10));
    await manager.run({ operation: "releaseStage", id: id(4 + boot * 10) });
    expect(((await (await manager.run({ operation: "ready" })).json()) as NativeManagerReady).recovery?.stagingChargedBytes).toBe(0);
    await expect(manager.run({ operation: "checkpoint", id: id(2) })).rejects.toThrow("quarantined");
    await manager.close();
  }
  expect(f.prepared).toHaveLength(2);
});

test("a non-UUID receipt is quarantined without charging impossible staging storage", async () => {
  const f = fixture(); fs.writeFileSync(join(f.state, "invalid.json"), "{broken");
  const manager = await f.manager();
  await manager.run({ operation: "checkpoint", id: id(3) });
  const stage = await manager.run({ operation: "prepareStage", id: id(4), checkpointId: id(3), allowanceBytes: 4096 });
  expect((await stage.json()).id, "NATIVE_INVALID_NAME_CANNOT_OWN_STAGE").toBe(id(4));
  expect(fs.readFileSync(join(f.state, "invalid.json"), "utf8")).toBe("{broken");
});

test.each([undefined, "EACCES"])("surviving quarantined stage retains its original bound across smaller configuration: %s", async inspectionError => {
  const f = fixture(); let manager = await f.manager({ stageAllowanceBytes: 8192, stageBudgetBytes: 12288 });
  await manager.run({ operation: "checkpoint", id: id(3) });
  await manager.run({ operation: "prepareStage", id: id(2), checkpointId: id(3), allowanceBytes: 8192 });
  await manager.close();
  fs.writeFileSync(join(f.state, `${id(2)}.json`), "{broken");
  f.setInspectionError(inspectionError);
  manager = await f.manager({ stageBudgetBytes: 12288 });
  expect(((await (await manager.run({ operation: "ready" })).json()) as NativeManagerReady).recovery?.stagingChargedBytes,
    "NATIVE_QUARANTINE_RETAINS_HISTORICAL_ALLOWANCE").toBe(8192);
  await manager.run({ operation: "prepareStage", id: id(4), checkpointId: id(3), allowanceBytes: 4096 });
  await expect(manager.run({ operation: "prepareStage", id: id(5), checkpointId: id(3), allowanceBytes: 4096 }),
    "NATIVE_QUARANTINE_CHARGE_REMAINS_RESERVED").rejects.toMatchObject({ code: "capacity" });
  await expect(manager.run({ operation: "releaseStage", id: id(2) })).rejects.toThrow("quarantined");
});

for (const fault of ["missing bound", "EACCES"] as const) test(`unproven stage capacity reports recovery, not a retryable busy slot: ${fault}`, async () => {
  const f = fixture(); fs.writeFileSync(join(f.state, `${id(2)}.json`), "{broken");
  fs.mkdirSync(join(f.stageRoot, id(2)));
  if (fault === "EACCES") f.setInspectionError(fault);
  const manager = await f.manager(); await manager.run({ operation: "checkpoint", id: id(3) });
  expect(((await (await manager.run({ operation: "ready" })).json()) as NativeManagerReady).recovery?.stagingChargedBytes).toBeNull();
  await expect(manager.run({ operation: "prepareStage", id: id(4), checkpointId: id(3), allowanceBytes: 4096 }),
    "NATIVE_UNBOUNDED_QUARANTINE_IS_RECOVERY_NOT_BUSY").rejects.toMatchObject({ code: "unknown", message: expect.stringContaining("recovery") });
});

test("stage close failure retains its charge and independent bound until confirmed removal", async () => {
  const f = fixture(), manager = await f.manager();
  await manager.run({ operation: "checkpoint", id: id(3) });
  await manager.run({ operation: "prepareStage", id: id(2), checkpointId: id(3), allowanceBytes: 4096 });
  f.setCloseStage(async () => { throw Error("Odysseus close is unresolved"); });
  await expect(manager.run({ operation: "releaseStage", id: id(2) })).rejects.toThrow("close is unresolved");
  expect(fs.existsSync(join(f.stageRoot, `${id(2)}.allowance`)), "NATIVE_BOUND_SURVIVES_UNCONFIRMED_CLOSE").toBe(true);
  await expect(manager.run({ operation: "prepareStage", id: id(4), checkpointId: id(3), allowanceBytes: 4096 })).rejects.toMatchObject({ code: "capacity" });
  f.setCloseStage(async () => {});
  f.setInspectionError("EACCES");
  await expect(manager.run({ operation: "releaseStage", id: id(2) })).rejects.toMatchObject({ code: "EACCES" });
  expect(fs.readFileSync(join(f.stageRoot, `${id(2)}.allowance`), "utf8"), "NATIVE_BOUND_SURVIVES_UNCONFIRMED_REMOVAL").toBe("4096");
  await expect(manager.run({ operation: "prepareStage", id: id(4), checkpointId: id(3), allowanceBytes: 4096 })).rejects.toMatchObject({ code: "capacity" });
  f.setInspectionError();
  await manager.run({ operation: "releaseStage", id: id(2) });
  expect(fs.existsSync(join(f.stageRoot, `${id(2)}.allowance`))).toBe(false);
  await manager.run({ operation: "prepareStage", id: id(4), checkpointId: id(3), allowanceBytes: 4096 });
});
