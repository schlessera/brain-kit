import { expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { open } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NativeFileVersions, nativeFileVersion, STALE_NATIVE_WRITE } from "../src/server/native-file-versions";

async function fixture(run: (storage: { directory: string; brainPath: string; sessionId: string }, file: string) => Promise<void>) {
  const root = mkdtempSync(join(tmpdir(), "odysseus-native-observations-")), brainPath = join(root, "brain"), directory = join(root, "host");
  mkdirSync(brainPath); const file = join(brainPath, "loom.md"); writeFileSync(file, "Penelope weaves.\n");
  try { await run({ directory, brainPath, sessionId: "ithaca" }, file); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
async function observe(versions: NativeFileVersions, file: string) {
  await versions.beginRead("read", "loom.md", nativeFileVersion(file));
  await versions.finishRead("read", nativeFileVersion(file), true);
}

test("durable observations restore in a separate host process and preserve never-read writes", () => fixture(async (storage, file) => {
  const versions = new NativeFileVersions(); await versions.retain(storage); await observe(versions, file);
  writeFileSync(file, "Penelope sleeps.\n");
  const restored = await NativeFileVersions.restore(storage);
  expect(restored.check("loom.md", nativeFileVersion(file)), "DURABLE_STALE_VERSION_REFUSED").toBe(STALE_NATIVE_WRITE);
  expect(restored.check("new.md", { status: "missing" })).toBeNull();
  const child = Bun.spawnSync([process.execPath, "-e", `import {NativeFileVersions,nativeFileVersion} from ${JSON.stringify(join(import.meta.dir, "../src/server/native-file-versions.ts"))}; const storage=JSON.parse(process.argv[1]); console.log((await NativeFileVersions.restore(storage)).check("loom.md",nativeFileVersion(process.argv[2])));`, JSON.stringify(storage), file]);
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(child.stdout.toString().trim(), "FRESH_PROCESS_RESTORES_STALE_HASH").toBe(STALE_NATIVE_WRITE);
  await observe(restored, file);
  expect((await NativeFileVersions.restore(storage)).check("loom.md", nativeFileVersion(file))).toBeNull();
  const name = readdirSync(storage.directory).find(name => name.endsWith(".json"))!;
  expect(statSync(join(storage.directory, name)).mode & 0o777).toBe(0o600);
  expect(statSync(storage.directory).mode & 0o777).toBe(0o700);
  expect(readdirSync(storage.brainPath)).toEqual(["loom.md"]);
}));

test("a crash between read start and completion keeps uncertainty until genuine reread", () => fixture(async (storage, file) => {
  const versions = new NativeFileVersions(); await versions.retain(storage);
  await versions.beginRead("read", "loom.md", nativeFileVersion(file));
  const restored = await NativeFileVersions.restore(storage);
  expect(restored.check("loom.md", nativeFileVersion(file)), "INTERRUPTED_READ_IS_NOT_FORGOTTEN").toBe(STALE_NATIVE_WRITE);
  await observe(restored, file);
  expect((await NativeFileVersions.restore(storage)).check("loom.md", nativeFileVersion(file))).toBeNull();
}));

test("legacy or missing records require an actual reread, and failed reads never establish authority", () => fixture(async (storage, file) => {
  const versions = await NativeFileVersions.restore(storage);
  expect(versions.check("loom.md", nativeFileVersion(file)), "LEGACY_RESUME_FAILS_CLOSED").toBe(STALE_NATIVE_WRITE);
  await versions.beginRead("failed", "loom.md", nativeFileVersion(file)); await versions.finishRead("failed", nativeFileVersion(file), false);
  expect((await NativeFileVersions.restore(storage)).check("loom.md", nativeFileVersion(file))).toBe(STALE_NATIVE_WRITE);
  await observe(versions, file);
  expect((await NativeFileVersions.restore(storage)).check("loom.md", nativeFileVersion(file))).toBeNull();
}));

for (const kind of ["corrupt", "symlink", "hardlink", "identity"] as const) test(`${kind} observation records fail closed`, () => fixture(async (storage, file) => {
  const versions = new NativeFileVersions(); await versions.retain(storage); await observe(versions, file);
  const path = join(storage.directory, readdirSync(storage.directory)[0]!);
  const bytes = readFileSync(path, "utf8");
  if (kind === "corrupt") writeFileSync(path, "{}");
  else if (kind === "identity") writeFileSync(path, bytes.replace(/"identity":"[^"]+"/, '"identity":"wrong"'));
  else {
    const peer = join(storage.directory, "peer"); writeFileSync(peer, bytes); rmSync(path);
    if (kind === "symlink") symlinkSync(peer, path); else linkSync(peer, path);
  }
  await expect(NativeFileVersions.restore(storage)).rejects.toThrow();
}));

test("storage aliases into the brain are refused before any metadata is written", () => fixture(async (storage) => {
  symlinkSync(storage.brainPath, storage.directory);
  await expect(new NativeFileVersions().retain(storage)).rejects.toThrow();
  expect(readdirSync(storage.brainPath)).toEqual(["loom.md"]);
}));

test("save failure blocks subsequent writes until observations can be retained again", () => fixture(async (storage, file) => {
  const versions = new NativeFileVersions(); await versions.retain(storage);
  const moved = storage.directory + "-peer"; mkdirSync(moved); rmSync(storage.directory, { recursive: true }); symlinkSync(moved, storage.directory);
  await expect(observe(versions, file)).rejects.toThrow();
  expect(versions.check("new.md", { status: "missing" }), "FAILED_RETENTION_BLOCKS_WRITE_AUTHORITY").toBe(STALE_NATIVE_WRITE);
  rmSync(storage.directory); mkdirSync(storage.directory, { mode: 0o700 });
  await observe(versions, file);
  expect(versions.check("loom.md", nativeFileVersion(file))).toBeNull();
  rmSync(moved, { recursive: true });
}));


test("a crash during a never-read write cannot restore never-read authority", () => fixture(async (storage, file) => {
  const versions = new NativeFileVersions(); await versions.retain(storage);
  expect(versions.check("loom.md", nativeFileVersion(file))).toBeNull();
  await versions.beginWrite("loom.md");
  writeFileSync(file, "Penelope sleeps.\n");
  expect((await NativeFileVersions.restore(storage)).check("loom.md", nativeFileVersion(file)), "INTERRUPTED_WRITE_IS_NOT_FORGOTTEN").toBe(STALE_NATIVE_WRITE);
  await versions.finishWrite("loom.md", nativeFileVersion(file));
  expect((await NativeFileVersions.restore(storage)).check("loom.md", nativeFileVersion(file))).toBeNull();
}));

test("saves that overlap land in call order, so the last change is the durable one", () => fixture(async (storage, file) => {
  const versions = new NativeFileVersions(); await versions.retain(storage);
  const before = nativeFileVersion(file);
  // The first save's fsync is the slow one, so an unordered second save would
  // finish first and the older uncertainty would overwrite it.
  const probe = await open(tmpdir(), "r"), handle = Object.getPrototypeOf(probe) as { sync(): Promise<void> };
  await probe.close();
  const sync = handle.sync;
  let first = true;
  const delayed = spyOn(handle, "sync").mockImplementation(async function (this: unknown) {
    if (first) { first = false; await Bun.sleep(100); }
    return sync.call(this);
  });
  // Not awaited in between: the write's uncertainty and then its completion.
  try { await Promise.all([versions.beginWrite("loom.md"), versions.finishWrite("loom.md", before)]); }
  finally { delayed.mockRestore(); }
  expect((await NativeFileVersions.restore(storage)).check("loom.md", before), "OVERLAPPING_SAVES_KEEP_CALL_ORDER").toBeNull();
}));

// #2416: on a loaded host one fsync took 327 ms, and these ran synchronously on
// the hosted server's event loop, stalling `/health`. Each file and directory
// fsync is delayed here; a 1 ms timer must keep firing while the save waits,
// the synchronous fsync must never run, and every fsync must still happen.
async function delayedFsyncs<T>(work: () => Promise<T>): Promise<{ ticks: number; syncs: number; syncCalls: number }> {
  const probe = await open(tmpdir(), "r"), handle = Object.getPrototypeOf(probe) as { sync(): Promise<void> };
  await probe.close();
  const sync = handle.sync;
  let syncs = 0, ticks = 0;
  const delayed = spyOn(handle, "sync").mockImplementation(async function (this: unknown) {
    syncs++; await Bun.sleep(20); return sync.call(this);
  });
  const blocking = spyOn(fs, "fsyncSync");
  const timer = setInterval(() => { ticks++; }, 1);
  try { await work(); return { ticks, syncs, syncCalls: blocking.mock.calls.length }; }
  finally { clearInterval(timer); delayed.mockRestore(); blocking.mockRestore(); }
}

test("creating storage and saving an observation wait on fsync off the event loop", () => fixture(async (storage, file) => {
  const versions = new NativeFileVersions();
  // The storage directory does not exist yet: its creation syncs its parent.
  const created = await delayedFsyncs(() => versions.retain(storage));
  expect(created.syncCalls, "NATIVE_OBSERVATION_SAVE_NEVER_SYNC_FSYNC").toBe(0);
  expect(created.ticks, "NATIVE_OBSERVATION_SAVE_LEAVES_EVENT_LOOP_FREE").toBeGreaterThan(0);
  // The new directory's parent, the record and the record's directory.
  expect(created.syncs, "NATIVE_OBSERVATION_SAVE_STAYS_DURABLE").toBe(3);
  const saved = await delayedFsyncs(() => versions.beginWrite("loom.md"));
  expect(saved.syncCalls, "NATIVE_OBSERVATION_SAVE_NEVER_SYNC_FSYNC").toBe(0);
  expect(saved.ticks, "NATIVE_OBSERVATION_SAVE_LEAVES_EVENT_LOOP_FREE").toBeGreaterThan(0);
  expect(saved.syncs, "NATIVE_OBSERVATION_SAVE_STAYS_DURABLE").toBe(2);
  rmSync(storage.directory, { recursive: true });
  const restored = await delayedFsyncs(() => NativeFileVersions.restore(storage));
  expect(restored.syncCalls, "NATIVE_OBSERVATION_RESTORE_NEVER_SYNC_FSYNC").toBe(0);
  expect(restored.ticks, "NATIVE_OBSERVATION_RESTORE_LEAVES_EVENT_LOOP_FREE").toBeGreaterThan(0);
  expect(restored.syncs).toBe(1);
  expect(readFileSync(file, "utf8")).toBe("Penelope weaves.\n");
}));
