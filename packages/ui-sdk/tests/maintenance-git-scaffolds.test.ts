import { expect, test } from "bun:test";
import { chmodSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaintenanceGitManifest, MaintenanceGitScaffoldReceipt } from "../src/server/maintenance-git-input.js";

function fixture(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), "odysseus-git-scaffolds-"));
  try { mkdirSync(join(root, ".git")); run(root); }
  finally { rmSync(root, { recursive: true, force: true }); }
}
function manifest(): MaintenanceGitManifest {
  return { relative: `.brain-maintenance-git-${crypto.randomUUID()}`, maximum: 1024 ** 2,
    files: ["config.json", "empty-config", "bin/git"].map(path => ({ path, data: Buffer.from("Odysseus fixture").toString("base64"), executable: path === "bin/git" })),
    scaffolds: [{ name: "modules" }] };
}
function run(root: string, input: MaintenanceGitManifest) {
  return Bun.spawnSync([process.execPath, "--config=/dev/null", "--no-env-file", join(import.meta.dir, "../src/server/maintenance-git-input.ts"), String(input.maximum)],
    { env: { ...process.env, BRAIN_ROOT: root }, stdin: Buffer.from(JSON.stringify(input)), stdout: "pipe", stderr: "pipe" });
}
function stamp(path: string) {
  const info = lstatSync(path, { bigint: true });
  return { inode: String(info.ino), stamp: `${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}` };
}
test("fixed Git scaffold installer creates only registered empty owned directories and verifies subsequent identity", () => fixture(root => {
  chmodSync(join(root, ".git"), 0o2775);
  const input = manifest(); const first = run(root, input);
  expect(lstatSync(join(root, ".git/modules")).mode & 0o7777, "NEW_OWNED_SCAFFOLD_PRIVATE_MODE_BELOW_SETGID_PARENT").toBe(0o700);
  expect(first.exitCode, first.stderr.toString()).toBe(0);
  const receipt = JSON.parse(first.stdout.toString());
  const row = receipt.scaffolds[0] as MaintenanceGitScaffoldReceipt;
  expect(row.name).toBe("modules"); expect(row.uid).toBe(process.getuid!()); expect(row.mode).toBe(0o700);
  expect(row).toMatchObject(stamp(join(root, ".git/modules")));
  expect(readdirSync(join(root, ".git/modules"))).toEqual([]);
  expect(readdirSync(join(root, ".git"))).toEqual(["modules"]);
  const repeated = run(root, { ...input, previous: { inode: receipt.inode, digest: receipt.digest }, scaffolds: [{ name: "modules", previous: row }] });
  expect(repeated.exitCode, repeated.stderr.toString()).toBe(0);
  expect(JSON.parse(repeated.stdout.toString()).scaffolds).toEqual(receipt.scaffolds);
}));
for (const kind of ["existing", "symlink", "file", "wrong-mode", "inherited-setgid", "replaced", "nonempty"] as const)
  test(`fixed Git scaffold installer refuses ${kind} input`, () => fixture(root => {
    const input = manifest(), path = join(root, ".git/modules");
    if (kind === "file") writeFileSync(path, "Odysseus");
    else if (kind === "symlink") { mkdirSync(join(root, "foreign")); symlinkSync("../foreign", path); }
    else mkdirSync(path, { mode: 0o700 });
    if (kind === "wrong-mode") chmodSync(path, 0o750);
    if (kind === "inherited-setgid") chmodSync(path, 0o2700);
    if (kind === "nonempty") writeFileSync(join(path, "unexpected"), "Odysseus");
    if (kind === "wrong-mode" || kind === "inherited-setgid" || kind === "nonempty") input.scaffolds = [{ name: "modules", previous: stamp(path) }];
    if (kind === "replaced") { const before = stamp(path); rmSync(path, { recursive: true }); mkdirSync(path, { mode: 0o700 }); input.scaffolds = [{ name: "modules", previous: before }]; }
    const result = run(root, input);
    expect(result.exitCode, `GIT_SCAFFOLD_${kind.toUpperCase()}_REFUSED`).not.toBe(0);
    expect(result.stderr.toString()).toBe("Concrete maintenance Git input preparation refused\n");
  }));
test("fixed Git scaffold installer refuses a linked metadata parent", () => fixture(root => {
  rmSync(join(root, ".git"), { recursive: true }); mkdirSync(join(root, "foreign")); symlinkSync("foreign", join(root, ".git"));
  expect(run(root, manifest()).exitCode, "GIT_SCAFFOLD_LINKED_PARENT_REFUSED").not.toBe(0);
  expect(readdirSync(join(root, "foreign"))).toEqual([]);
}));
