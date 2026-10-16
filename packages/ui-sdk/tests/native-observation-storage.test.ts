import { expect, test } from "bun:test";
import { linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NativeFileVersions, nativeFileVersion, STALE_NATIVE_WRITE } from "../src/server/native-file-versions";

function fixture(run: (storage: { directory: string; brainPath: string; sessionId: string }, file: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "odysseus-native-observations-")), brainPath = join(root, "brain"), directory = join(root, "host");
  mkdirSync(brainPath); const file = join(brainPath, "loom.md"); writeFileSync(file, "Penelope weaves.\n");
  try { run({ directory, brainPath, sessionId: "ithaca" }, file); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
function observe(versions: NativeFileVersions, file: string) {
  versions.beginRead("read", "loom.md", nativeFileVersion(file));
  versions.finishRead("read", nativeFileVersion(file), true);
}

test("durable observations restore in a separate host process and preserve never-read writes", () => fixture((storage, file) => {
  const versions = new NativeFileVersions(); versions.retain(storage); observe(versions, file);
  writeFileSync(file, "Penelope sleeps.\n");
  const restored = NativeFileVersions.restore(storage);
  expect(restored.check("loom.md", nativeFileVersion(file)), "DURABLE_STALE_VERSION_REFUSED").toBe(STALE_NATIVE_WRITE);
  expect(restored.check("new.md", { status: "missing" })).toBeNull();
  const child = Bun.spawnSync([process.execPath, "-e", `import {NativeFileVersions,nativeFileVersion} from ${JSON.stringify(join(import.meta.dir, "../src/server/native-file-versions.ts"))}; const storage=JSON.parse(process.argv[1]); console.log(NativeFileVersions.restore(storage).check("loom.md",nativeFileVersion(process.argv[2])));`, JSON.stringify(storage), file]);
  expect(child.exitCode, child.stderr.toString()).toBe(0);
  expect(child.stdout.toString().trim(), "FRESH_PROCESS_RESTORES_STALE_HASH").toBe(STALE_NATIVE_WRITE);
  observe(restored, file);
  expect(NativeFileVersions.restore(storage).check("loom.md", nativeFileVersion(file))).toBeNull();
  const name = readdirSync(storage.directory).find(name => name.endsWith(".json"))!;
  expect(statSync(join(storage.directory, name)).mode & 0o777).toBe(0o600);
  expect(statSync(storage.directory).mode & 0o777).toBe(0o700);
  expect(readdirSync(storage.brainPath)).toEqual(["loom.md"]);
}));

test("a crash between read start and completion keeps uncertainty until genuine reread", () => fixture((storage, file) => {
  const versions = new NativeFileVersions(); versions.retain(storage);
  versions.beginRead("read", "loom.md", nativeFileVersion(file));
  const restored = NativeFileVersions.restore(storage);
  expect(restored.check("loom.md", nativeFileVersion(file)), "INTERRUPTED_READ_IS_NOT_FORGOTTEN").toBe(STALE_NATIVE_WRITE);
  observe(restored, file);
  expect(NativeFileVersions.restore(storage).check("loom.md", nativeFileVersion(file))).toBeNull();
}));

test("legacy or missing records require an actual reread, and failed reads never establish authority", () => fixture((storage, file) => {
  const versions = NativeFileVersions.restore(storage);
  expect(versions.check("loom.md", nativeFileVersion(file)), "LEGACY_RESUME_FAILS_CLOSED").toBe(STALE_NATIVE_WRITE);
  versions.beginRead("failed", "loom.md", nativeFileVersion(file)); versions.finishRead("failed", nativeFileVersion(file), false);
  expect(NativeFileVersions.restore(storage).check("loom.md", nativeFileVersion(file))).toBe(STALE_NATIVE_WRITE);
  observe(versions, file);
  expect(NativeFileVersions.restore(storage).check("loom.md", nativeFileVersion(file))).toBeNull();
}));

for (const kind of ["corrupt", "symlink", "hardlink", "identity"] as const) test(`${kind} observation records fail closed`, () => fixture((storage, file) => {
  const versions = new NativeFileVersions(); versions.retain(storage); observe(versions, file);
  const path = join(storage.directory, readdirSync(storage.directory)[0]!);
  const bytes = readFileSync(path, "utf8");
  if (kind === "corrupt") writeFileSync(path, "{}");
  else if (kind === "identity") writeFileSync(path, bytes.replace(/"identity":"[^"]+"/, '"identity":"wrong"'));
  else {
    const peer = join(storage.directory, "peer"); writeFileSync(peer, bytes); rmSync(path);
    if (kind === "symlink") symlinkSync(peer, path); else linkSync(peer, path);
  }
  expect(() => NativeFileVersions.restore(storage)).toThrow();
}));

test("storage aliases into the brain are refused before any metadata is written", () => fixture((storage) => {
  symlinkSync(storage.brainPath, storage.directory);
  expect(() => new NativeFileVersions().retain(storage)).toThrow();
  expect(readdirSync(storage.brainPath)).toEqual(["loom.md"]);
}));

test("save failure blocks subsequent writes until observations can be retained again", () => fixture((storage, file) => {
  const versions = new NativeFileVersions(); versions.retain(storage);
  const moved = storage.directory + "-peer"; mkdirSync(moved); rmSync(storage.directory, { recursive: true }); symlinkSync(moved, storage.directory);
  expect(() => observe(versions, file)).toThrow();
  expect(versions.check("new.md", { status: "missing" }), "FAILED_RETENTION_BLOCKS_WRITE_AUTHORITY").toBe(STALE_NATIVE_WRITE);
  rmSync(storage.directory); mkdirSync(storage.directory, { mode: 0o700 });
  observe(versions, file);
  expect(versions.check("loom.md", nativeFileVersion(file))).toBeNull();
  rmSync(moved, { recursive: true });
}));


test("a crash during a never-read write cannot restore never-read authority", () => fixture((storage, file) => {
  const versions = new NativeFileVersions(); versions.retain(storage);
  expect(versions.check("loom.md", nativeFileVersion(file))).toBeNull();
  versions.beginWrite("loom.md");
  writeFileSync(file, "Penelope sleeps.\n");
  expect(NativeFileVersions.restore(storage).check("loom.md", nativeFileVersion(file)), "INTERRUPTED_WRITE_IS_NOT_FORGOTTEN").toBe(STALE_NATIVE_WRITE);
  versions.finishWrite("loom.md", nativeFileVersion(file));
  expect(NativeFileVersions.restore(storage).check("loom.md", nativeFileVersion(file))).toBeNull();
}));
