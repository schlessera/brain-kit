import { afterEach, expect, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { buildRead, checkBuildPrivateDirectory } from "../scripts/ci-build-files";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = fs.mkdtempSync(join(tmpdir(), "odysseus-build-fd-")); roots.push(root);
  fs.mkdirSync(join(root, "source")); fs.mkdirSync(join(root, "outside"));
  fs.writeFileSync(join(root, "source/file"), "Ithaca"); fs.writeFileSync(join(root, "outside/file"), "Pylos");
  return root;
}
for (const kind of ["alias", "fifo", "ancestor"] as const) test(`anchored build capture refuses an actual ${kind} swap`, () => {
  const root = fixture(), file = join(root, "source/file");
  const original = fs.openSync; let swapped = false;
  const open = spyOn(fs, "openSync").mockImplementation(((path: fs.PathLike, ...args: any[]) => {
    if (!swapped && String(path).startsWith("/proc/self/fd/") && String(path).endsWith("/file")) {
      swapped = true;
      if (kind === "ancestor") { fs.renameSync(join(root, "source"), join(root, "prior")); fs.symlinkSync("outside", join(root, "source")); }
      else {
        fs.unlinkSync(file);
        if (kind === "alias") fs.symlinkSync("../outside/file", file);
        else { const result = Bun.spawnSync(["/usr/bin/mkfifo", file]); expect(result.exitCode).toBe(0); }
      }
    }
    return (original as any)(path, ...args);
  }) as typeof fs.openSync);
  try { expect(() => buildRead(file), `CI_BUILD_${kind.toUpperCase()}_SWAP_REFUSED`).toThrow(); expect(swapped).toBe(true); }
  finally { open.mockRestore(); }
});
test("anchored capture bounds regular-file bytes and retains mode", () => {
  const root = fixture(), file = join(root, "source/file"); fs.chmodSync(file, 0o640);
  expect(() => buildRead(file, undefined, 5), "CI_BUILD_FILE_BUDGET_REFUSAL").toThrow("Unsupported");
  const captured = buildRead(file); expect(captured.bytes.toString()).toBe("Ithaca"); expect(Number(captured.stat.mode & 0o777n)).toBe(0o640);
});

test("fixed build HOME and cache require private owned nonalias directories", () => {
  const root = fixture(), home = join(root, "home"); fs.mkdirSync(home, { mode: 0o700 });
  checkBuildPrivateDirectory(home);
  fs.chmodSync(home, 0o755);
  expect(() => checkBuildPrivateDirectory(home), "CI_BUILD_HOME_MODE_REFUSAL").toThrow("Invalid private");
  fs.rmSync(home, { recursive: true }); fs.symlinkSync("source", home);
  expect(() => checkBuildPrivateDirectory(home), "CI_BUILD_HOME_ALIAS_REFUSAL").toThrow("Invalid private");
});
