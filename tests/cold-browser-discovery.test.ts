import { expect, test } from "bun:test";
import assert from "node:assert/strict";
import { constants, cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, readlinkSync, realpathSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { browserInventory } from "../scripts/proof-inputs";

test("real browser discovery needs no workspace build outputs", async () => {
  const root = resolve(import.meta.dir, "..");
  const cold = mkdtempSync(join(tmpdir(), "cold-browser-discovery-"));
  const inside = (path: string) => {
    const name = relative(cold, path);
    assert.ok(!isAbsolute(name) && name !== ".." && !name.startsWith("../"), `Copied link escapes cold fixture: ${path}`);
  };
  try {
    const files = Bun.spawnSync(["git", "ls-files", "--cached", "--others", "--exclude-standard", "-z"], {
      cwd: root, stdout: "pipe", stderr: "pipe",
    });
    expect(files.exitCode, new TextDecoder().decode(files.stderr)).toBe(0);
    const copy = (name: string) => {
      mkdirSync(dirname(join(cold, name)), { recursive: true });
      cpSync(join(root, name), join(cold, name), {
        recursive: true, dereference: false, verbatimSymlinks: true, mode: constants.COPYFILE_FICLONE,
        // Vite and build caches are mutable outputs, not installed dependencies.
        filter: source => ![".cache", ".vite", ".vite-temp"].includes(source.split("/").at(-1)!),
      });
    };
    for (const name of new TextDecoder().decode(files.stdout).split("\0").filter(Boolean)) copy(name);
    for (const name of ["node_modules", ...readdirSync(join(root, "packages"))
      .map(name => `packages/${name}/node_modules`)]) if (existsSync(join(root, name))) copy(name);

    // Independent inodes, including on a hardlinked install. Relative workspace
    // links retain the copied layout; absolute links may only rebase into it.
    let regularFiles = 0;
    const admit = (directory: string) => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name), original = join(root, relative(cold, path));
        if (entry.isSymbolicLink()) {
          const target = readlinkSync(path);
          if (isAbsolute(target)) {
            assert.ok(target.startsWith(`${root}/`), `External installed link: ${target}`);
            unlinkSync(path); symlinkSync(join(cold, relative(root, target)), path);
          }
          inside(resolve(dirname(path), readlinkSync(path)));
          if (existsSync(path)) inside(realpathSync(path));
        } else if (entry.isDirectory()) admit(path);
        else {
          const copied = lstatSync(path), source = lstatSync(original);
          assert.ok(copied.isFile() && copied.nlink === 1, `Cold input is not an owned regular file: ${path}`);
          assert.ok(copied.dev !== source.dev || copied.ino !== source.ino, `Cold input shares its source inode: ${path}`);
          regularFiles++;
        }
      }
    };
    admit(cold);
    expect(regularFiles).toBeGreaterThan(0);
    for (const name of readdirSync(join(cold, "packages"))) expect(existsSync(join(cold, "packages", name, "dist"))).toBe(false);
    expect(realpathSync(join(cold, "node_modules/@schlessera/brain-ui-sdk"))).toBe(join(cold, "packages/ui-sdk"));
    const inventory = await browserInventory(cold);
    expect(inventory).toContainEqual({
      project: "ui-react-layout", file: "packages/ui-react/tests/browser/hygiene-lifecycle.layout.tsx",
    });
    expect(inventory.some(spec => spec.project === "ui-react-endurance")).toBe(true);
  } finally { rmSync(cold, { recursive: true, force: true }); }
}, 60000);
