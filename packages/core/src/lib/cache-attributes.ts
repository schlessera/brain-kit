/**
 * The git attribute that lets any merge, not only `brain sync pull`, combine
 * the two sidecar caches.
 *
 * Each file holds one self-contained `{k,v}` record per line, so git's
 * built-in `merge=union` driver is safe for them: it keeps the lines of both
 * sides instead of writing conflict markers. It leaves them in no particular
 * order; the next index run re-sorts them, and a key that appears twice
 * resolves to its first line in sorted order (`indexer/caches.ts`). The
 * built-in driver needs no per-clone git config, unlike a custom
 * `merge.<name>.driver`.
 */
import { existsSync, lstatSync, readFileSync, realpathSync } from "fs";
import { join, resolve } from "path";

import { WriteRefusedError, writeFileSafely } from "./safe-path.js";
import { emptyRepository } from "./scratch.js";

export const SIDECAR_CACHES = [".context-cache.jsonl", ".asset-cache.jsonl"] as const;

function canonicalRoot(root: string): string {
  try {
    return realpathSync(root);
  } catch {
    return resolve(root);
  }
}

function insideWorkTree(root: string): boolean {
  const out = Bun.spawnSync(["git", "-C", root, "rev-parse", "--is-inside-work-tree"], { stderr: "pipe" });
  return out.exitCode === 0 && new TextDecoder().decode(out.stdout).trim() === "true";
}

/**
 * The sidecar caches git would not union-merge, asked of git itself so every
 * attribute source counts (`.gitattributes` at any depth, `info/attributes`).
 * Outside a repository the question goes through an empty one, because the
 * brain may be `git init`ed later.
 */
export function cachesWithoutUnionMerge(root: string): string[] {
  const rootReal = canonicalRoot(root);
  const argv = insideWorkTree(rootReal)
    ? ["git", "check-attr", "merge", "--", ...SIDECAR_CACHES]
    : ["git", `--git-dir=${emptyRepository()}`, `--work-tree=${rootReal}`, "check-attr", "merge", "--", ...SIDECAR_CACHES];
  const out = Bun.spawnSync(argv, { cwd: rootReal, stderr: "pipe" });
  if (out.exitCode !== 0) {
    throw new Error(`git check-attr failed: ${new TextDecoder().decode(out.stderr).trim()}`);
  }
  const unioned = new Set(
    new TextDecoder()
      .decode(out.stdout)
      .split("\n")
      .map((line) => line.match(/^(.*): merge: union$/)?.[1])
      .filter((file): file is string => file !== undefined)
  );
  return SIDECAR_CACHES.filter((file) => !unioned.has(file));
}

/**
 * Append the `merge=union` lines for the caches that lack them to the brain's
 * `.gitattributes`. Appended last, so they override an earlier rule for the
 * same file. Returns whether anything changed.
 */
export function unionMergeCaches(root: string): boolean {
  const missing = cachesWithoutUnionMerge(root);
  if (missing.length === 0) return false;
  // At the canonical root, never through a link, as the scratch fix does.
  const path = join(canonicalRoot(root), ".gitattributes");
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new WriteRefusedError(".gitattributes is a symlink; add the merge=union lines to the file it names by hand");
  }
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  const block =
    "\n# brain-kit's derived caches: one {k,v} record per line, so git's built-in\n" +
    "# union driver merges them without conflicts. `brain index` re-sorts them.\n" +
    missing.map((file) => `${file} merge=union\n`).join("");
  writeFileSafely(path, (current && !current.endsWith("\n") ? `${current}\n` : current) + block);
  return true;
}
