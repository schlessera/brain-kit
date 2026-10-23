/** Preserve Git's index/worktree distinction for Bun's own --changed selector. */
import { createHash } from "node:crypto";
import { cpSync, lstatSync, mkdirSync, readFileSync, readlinkSync, unlinkSync } from "node:fs";
import { dirname, isAbsolute, join } from "node:path";

function git(root: string, args: string[], stdin?: Uint8Array): Buffer {
  const child = Bun.spawnSync(["git", "-C", root, ...args], { stdout: "pipe", stderr: "pipe", ...(stdin ? { stdin } : {}) });
  if (child.exitCode !== 0) throw new Error(`Unit input Git failed: ${new TextDecoder().decode(child.stderr)}`);
  return Buffer.from(child.stdout);
}

function inputs(root: string) {
  const patches = [
    git(root, ["diff", "--cached", "--binary", "--full-index", "--no-ext-diff", "--no-textconv", "HEAD"]),
    git(root, ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-textconv"]),
  ];
  const untracked = git(root, ["ls-files", "--others", "--exclude-standard", "-z"]).toString().split("\0").filter(Boolean);
  const hash = createHash("sha256");
  for (const patch of patches) hash.update(String(patch.length)).update("\0").update(patch);
  for (const file of untracked) {
    if (isAbsolute(file) || file.split("/").includes("..")) throw new Error("Escaped unit input path");
    const path = join(root, file), info = lstatSync(path);
    if (!info.isFile() && !info.isSymbolicLink()) throw new Error(`Unsupported unit input: ${file}`);
    const bytes = info.isSymbolicLink() ? Buffer.from(readlinkSync(path)) : readFileSync(path);
    hash.update(file).update("\0").update(String(info.mode)).update("\0").update(String(bytes.length)).update("\0").update(bytes);
  }
  return { patches, untracked, key: hash.digest("hex") };
}

export const unitInputKey = (root: string) => inputs(root).key;

export function captureUnitInputs(root: string, destination: string) {
  const source = inputs(root);
  mkdirSync(destination, { mode: 0o700 });
  for (const file of source.untracked) {
    mkdirSync(dirname(join(destination, file)), { recursive: true });
    cpSync(join(root, file), join(destination, file), { dereference: false, verbatimSymlinks: true, preserveTimestamps: true });
  }
  if (unitInputKey(root) !== source.key) throw new Error("Unit source changed while capturing working inputs; retry after edits stop");
  return {
    key: source.key,
    restore(workspace: string) {
      if (source.patches[0]!.length) git(workspace, ["apply", "--index", "--binary", "-"], source.patches[0]);
      if (source.patches[1]!.length) git(workspace, ["apply", "--binary", "-"], source.patches[1]);
      for (const file of source.untracked) {
        mkdirSync(dirname(join(workspace, file)), { recursive: true });
        cpSync(join(destination, file), join(workspace, file), { dereference: false, verbatimSymlinks: true, preserveTimestamps: true });
      }
      if (unitInputKey(workspace) !== source.key) throw new Error("Unit workspace does not match captured working inputs");
    },
    remove(workspace: string) {
      if (unitInputKey(workspace) !== source.key) throw new Error("Unit worker changed captured source; retaining dirty worktree");
      // Undo only this invocation's verified inputs, then let ordinary Git
      // removal refuse any remaining unexpected source or untracked output.
      for (const file of source.untracked) unlinkSync(join(workspace, file));
      if (source.patches[1]!.length) git(workspace, ["apply", "--reverse", "--binary", "-"], source.patches[1]);
      if (source.patches[0]!.length) git(workspace, ["apply", "--reverse", "--index", "--binary", "-"], source.patches[0]);
    },
  };
}
