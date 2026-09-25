/**
 * Which paths under a brain git ignores, asked of git once.
 *
 * Assets that git ignores are left out of the index: they exist on one clone
 * only, and indexing them there means a paid vision call and embedding for
 * something the other clones never see. Markdown is deliberately not filtered
 * this way (gitignored local-only notes stay searchable), so this answers for
 * assets alone.
 *
 * The rules are git's, not a re-implementation of them, and the answer comes
 * from one `git ls-files` call per work tree (the brain, and each initialised
 * submodule in it) rather than a spawn per file.
 */
import { existsSync, readFileSync } from "fs";
import { isAbsolute, join } from "path";

import { ASSET_EXTENSIONS } from "./types.js";

/** Answers whether a root-relative path is ignored. */
export type IgnoredMatcher = (path: string) => boolean;

const NOTHING_IGNORED: IgnoredMatcher = () => false;

/** Git prints paths as bytes; a leading U+FEFF is part of a file name, not a byte-order mark. */
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/** Run git in `dir` and split its NUL-separated output; null when git fails or is missing. */
function gitList(dir: string, args: string[]): string[] | null {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(["git", "-C", dir, ...args], { stdout: "pipe", stderr: "pipe" });
  } catch {
    return null; // git is not installed
  }
  if (result.exitCode !== 0) return null; // not a work tree
  return decoder.decode(result.stdout).split("\u0000").filter(Boolean);
}

/**
 * Collect what git ignores in the work tree at `dir`, prefixed with `prefix`,
 * then descend into its initialised submodules. The parent's listing stops at
 * a submodule's boundary, while the asset scan does not, so each nested work
 * tree gets the same one call of its own.
 */
function collectIgnored(dir: string, prefix: string, files: Set<string>, dirs: Set<string>, depth: number): boolean {
  const entries = gitList(dir, ["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
  if (entries === null) return false;
  for (const entry of entries) (entry.endsWith("/") ? dirs : files).add(prefix + entry);
  if (depth >= MAX_SUBMODULE_DEPTH) return true;
  // The submodules are the paths `.gitmodules` declares, read from disk rather
  // than asked of git, so each work tree still costs one call. One that is
  // initialised has its own `.git`; an uninitialised one is an empty directory.
  for (const path of submodulePaths(dir)) {
    const nested = join(dir, path);
    if (existsSync(join(nested, ".git"))) collectIgnored(nested, `${prefix}${path}/`, files, dirs, depth + 1);
  }
  return true;
}

/** The `path = …` entries of a work tree's `.gitmodules`, if it has one. */
function submodulePaths(dir: string): string[] {
  let text: string;
  try {
    text = readFileSync(join(dir, ".gitmodules"), "utf8");
  } catch {
    return [];
  }
  return [...text.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)]
    .map((m) => m[1].replace(/\/+$/, ""))
    // Only paths inside this work tree: `.gitmodules` is a tracked file anyone can edit.
    .filter((path) => path && !isAbsolute(path) && !path.split("/").includes(".."));
}

/** Submodules nest; a cycle through a symlinked checkout must still stop. */
const MAX_SUBMODULE_DEPTH = 8;

/**
 * Build a matcher for everything git ignores under `root`, submodules
 * included. Outside a git work tree, or when git is not installed, nothing
 * is ignored.
 *
 * `--directory` reports an ignored directory once, with a trailing slash,
 * instead of every file in it, so an ignored tree of media costs one line.
 */
export function gitIgnoredMatcher(root: string): IgnoredMatcher {
  const files = new Set<string>();
  const dirs = new Set<string>();
  if (!collectIgnored(root, "", files, dirs, 0)) return NOTHING_IGNORED;
  if (files.size === 0 && dirs.size === 0) return NOTHING_IGNORED;
  return (path) => {
    if (files.has(path)) return true;
    for (let slash = path.indexOf("/"); slash !== -1; slash = path.indexOf("/", slash + 1)) {
      if (dirs.has(path.slice(0, slash + 1))) return true;
    }
    return false;
  };
}

/** True for a path the indexer treats as an asset, by extension, any case. */
export function isAssetPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot === -1) return false;
  return (ASSET_EXTENSIONS as readonly string[]).includes(path.slice(dot).toLowerCase());
}
