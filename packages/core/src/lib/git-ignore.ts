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
 * from one `git ls-files` call per scan rather than a spawn per file.
 */
import { ASSET_EXTENSIONS } from "./types.js";

/** Answers whether a root-relative path is ignored. */
export type IgnoredMatcher = (path: string) => boolean;

const NOTHING_IGNORED: IgnoredMatcher = () => false;

/**
 * Build a matcher for everything git ignores under `root`. Outside a git work
 * tree, or when git is not installed, nothing is ignored.
 *
 * `--directory` reports an ignored directory once, with a trailing slash,
 * instead of every file in it, so an ignored tree of media costs one line.
 */
export function gitIgnoredMatcher(root: string): IgnoredMatcher {
  let result: ReturnType<typeof Bun.spawnSync>;
  try {
    result = Bun.spawnSync(
      ["git", "-C", root, "ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"],
      { stdout: "pipe", stderr: "pipe" }
    );
  } catch {
    return NOTHING_IGNORED; // git is not installed
  }
  if (result.exitCode !== 0) return NOTHING_IGNORED; // not a work tree
  const entries = new TextDecoder().decode(result.stdout).split("\u0000").filter(Boolean);
  if (entries.length === 0) return NOTHING_IGNORED;

  const files = new Set<string>();
  const dirs = new Set<string>();
  for (const entry of entries) (entry.endsWith("/") ? dirs : files).add(entry);
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
