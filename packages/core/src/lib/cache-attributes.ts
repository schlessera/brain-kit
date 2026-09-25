/**
 * The git attribute that lets any merge, not only `brain sync pull`, combine
 * the two sidecar caches.
 *
 * Each file holds one self-contained `{k,v}` record per line, so git's
 * built-in `merge=union` driver is safe for them: it keeps the lines of both
 * sides instead of writing conflict markers. It leaves them in no particular
 * order, which no reader depends on: a key that appears twice resolves to its
 * first line in sorted order (`indexer/caches.ts`), and the file is sorted
 * again the next time an index run adds or prunes a line. The
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

function unionMerged(argv: string[], cwd: string): string[] {
  const out = Bun.spawnSync(argv, { cwd, stderr: "pipe" });
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
 * The sidecar caches the brain's own `.gitattributes` does not union-merge:
 * the rules every clone gets, because they are committed. Asked of git in an
 * empty repository with no global or system config, so neither
 * `info/attributes` nor a `core.attributesFile` can stand in for a missing
 * rule. Those are this clone's alone.
 */
export function cachesWithoutPortableUnionMerge(root: string): string[] {
  const rootReal = canonicalRoot(root);
  // `core.attributesFile` pointed at nothing covers the global setting and its
  // XDG default; the empty repository has no `info/attributes`.
  return unionMerged(
    [
      "git", "-c", "core.attributesFile=/dev/null", `--git-dir=${emptyRepository()}`, `--work-tree=${rootReal}`,
      "check-attr", "merge", "--", ...SIDECAR_CACHES,
    ],
    rootReal
  );
}

/**
 * The sidecar caches this clone's git would not union-merge, every attribute
 * source counted: `.gitattributes`, `info/attributes`, `core.attributesFile`.
 * Outside a work tree it is the portable answer.
 */
export function cachesWithoutUnionMerge(root: string): string[] {
  const rootReal = canonicalRoot(root);
  if (!insideWorkTree(rootReal)) return cachesWithoutPortableUnionMerge(root);
  return unionMerged(["git", "check-attr", "merge", "--", ...SIDECAR_CACHES], rootReal);
}

/**
 * Append the `merge=union` lines for the caches that lack them to the brain's
 * `.gitattributes`. Appended last, so they override an earlier rule for the
 * same file. Returns whether anything changed.
 */
export function unionMergeCaches(root: string): boolean {
  // Read at the last moment, from the committed rules only: a local override
  // is not something another line in .gitattributes can fix, and appending
  // for it would add a duplicate on every run.
  const missing = cachesWithoutPortableUnionMerge(root);
  if (missing.length === 0) return false;
  // At the canonical root, never through a link, as the scratch fix does.
  const path = join(canonicalRoot(root), ".gitattributes");
  if (lstatSync(path, { throwIfNoEntry: false })?.isSymbolicLink()) {
    throw new WriteRefusedError(".gitattributes is a symlink; add the merge=union lines to the file it names by hand");
  }
  const current = existsSync(path) ? readFileSync(path, "utf8") : "";
  // The file's own line ending, so a CRLF file stays CRLF.
  const eol = current.includes("\r\n") ? "\r\n" : "\n";
  const lines = [
    "",
    "# brain-kit's derived caches: one {k,v} record per line, so git's built-in",
    "# union driver merges them without conflicts, in any order.",
    ...missing.map((file) => `${file} merge=union`),
  ];
  const block = lines.join(eol) + eol;
  writeFileSafely(path, (current && !current.endsWith("\n") ? `${current}${eol}` : current) + block);
  return true;
}
