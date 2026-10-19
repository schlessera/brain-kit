import { expect, test } from "bun:test";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("host metadata mode never executes Git or repository configuration", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-storage-host-")), brain = join(root, "brain"), bin = join(root, "bin"), marker = join(root, "git-executed");
  mkdirSync(brain); mkdirSync(bin); mkdirSync(join(brain, ".git")); mkdirSync(join(brain, ".git", "objects"));
  writeFileSync(join(brain, "brain.config.ts"), 'throw Error("REPOSITORY_CONFIG_EXECUTED");');
  writeFileSync(join(brain, ".git", "config"), '[include]\npath = /unapproved-host-config\n');
  writeFileSync(join(bin, "git"), `#!${process.execPath}\nawait Bun.write(${JSON.stringify(marker)},"Git executed");process.exit(1);\n`); chmodSync(join(bin, "git"), 0o700);
  const source = `import {readStorageInventory} from ${JSON.stringify(import.meta.resolve("../src/storage.ts"))};console.log(JSON.stringify(await readStorageInventory({brainPath:${JSON.stringify(brain)}})));`;
  try {
    const child = Bun.spawn([process.execPath, "--config=/dev/null", "--no-env-file", "-e", source], { env: { ...process.env, PATH: `${bin}:/usr/bin:/bin` }, stdout: "pipe", stderr: "pipe" });
    const [out, err, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(code, err).toBe(0);
    expect(existsSync(marker), "STORAGE_HOST_NEVER_RUNS_GIT").toBe(false);
    expect(JSON.parse(out).status).toBe("complete");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("public host reader resolves approved worktree markers and refuses redirected administrative files", async () => {
  const { readStorageInventory } = await import("../src/storage");
  const { symlinkSync, unlinkSync } = await import("node:fs");
  const root = mkdtempSync(join(tmpdir(), "odysseus-storage-host-")), repo = join(root, "repo"), worktree = join(root, "voyage"), alternate = join(root, "alternate");
  mkdirSync(repo); mkdirSync(alternate);
  const git = (path: string, ...args: string[]) => { const p = Bun.spawnSync(["git", "-C", path, ...args], { stdout: "pipe", stderr: "pipe" }); expect(p.exitCode, p.stderr.toString()).toBe(0); };
  try {
    git(repo, "init"); git(alternate, "init", "--bare");
    writeFileSync(join(repo, "Ithaca.md"), "Odysseus returns to Ithaca.\n");
    git(repo, "add", "."); git(repo, "-c", "user.name=Odysseus", "-c", "user.email=odysseus@example.invalid", "commit", "-m", "Ithaca");
    git(repo, "worktree", "add", "-b", "voyage", worktree);
    writeFileSync(join(repo, ".git", "objects", "info", "alternates"), join(alternate, "objects") + "\n");
    expect((await readStorageInventory({ brainPath: worktree })).errors, "STORAGE_HOST_APPROVED_ROOTS_ONLY").toContainEqual({ path: "git", reason: "external-git-root-not-approved" });
    const result = await readStorageInventory({ brainPath: worktree, gitRoots: [repo, alternate] });
    expect(result.status, JSON.stringify(result.errors)).toBe("complete");
    expect(result.roots.some(value => value.path === join(alternate, "objects"))).toBe(true);
    const common = join(repo, ".git", "worktrees", "voyage", "commondir"), outside = join(root, "outside-marker");
    unlinkSync(common); writeFileSync(outside, "../..\n"); symlinkSync(outside, common);
    expect((await readStorageInventory({ brainPath: worktree, gitRoots: [repo, alternate] })).errors, "STORAGE_HOST_MARKER_REDIRECT_REFUSED").toContainEqual({ path: "git", reason: "git-metadata-unsupported" });
    unlinkSync(common); writeFileSync(common, "../../redirect\n"); symlinkSync(join(repo, ".git"), join(repo, ".git", "redirect"));
    expect((await readStorageInventory({ brainPath: worktree, gitRoots: [repo, alternate] })).status, "STORAGE_HOST_DIRECTORY_REDIRECT_REFUSED").toBe("partial");
  } finally { rmSync(root, { recursive: true, force: true }); }
});
