/** Git ignore decisions for the entries the discovery walk actually reaches. */
import { existsSync, readdirSync, type Dirent } from "node:fs";
import { dirname, join, relative } from "node:path";
import { ASSET_EXTENSIONS } from "./types.js";

export type IgnoredMatcher = (path: string) => boolean;
const decoder = new TextDecoder("utf-8", { ignoreBOM: true });

/**
 * Query immediate children in one batch, without Git enumerating descendants.
 * Taxonomy pruning happens before even asking Git about an excluded directory.
 * check-ignore preserves tracked files and evaluates each initialized submodule
 * in its own worktree. Markdown discovery does not use this matcher.
 */
export function gitIgnoredMatcher(root: string, excludedDirectory: (path: string) => boolean = () => false): IgnoredMatcher {
  const cache = new Map<string, Set<string>>();
  function ignoredIn(directory: string): Set<string> {
    const cached = cache.get(directory); if (cached) return cached;
    const ignored = new Set<string>(); cache.set(directory, ignored);
    // A child is queried only after discovery admitted its parent. Finding a
    // submodule boundary reads metadata along this already admitted path.
    let worktree = directory;
    while (worktree && !existsSync(join(root, worktree, ".git"))) worktree = dirname(worktree) === "." ? "" : dirname(worktree);
    let entries: Dirent[];
    try { entries = readdirSync(join(root, directory), { withFileTypes: true }); }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return ignored; throw error; }
    const paths = entries
      .filter(entry => !entry.name.startsWith(".") && (!entry.isDirectory() || !excludedDirectory(join(directory, entry.name))))
      .map(entry => relative(worktree, join(directory, entry.name)) + (entry.isDirectory() ? "/" : ""));
    if (!paths.length) return ignored;
    let result: ReturnType<typeof Bun.spawnSync>;
    try { result = Bun.spawnSync(["git", "-C", join(root, worktree), "check-ignore", "--stdin", "-z"], {
      stdin: Buffer.from(paths.join("\u0000") + "\u0000"), stdout: "pipe", stderr: "pipe",
    }); } catch { return ignored; }
    if (result.exitCode !== 0 && result.exitCode !== 1) return ignored;
    for (const path of decoder.decode(result.stdout).split("\u0000").filter(Boolean)) ignored.add(join(worktree, path).replace(/\/$/, ""));
    return ignored;
  }
  return path => {
    const normalized = path.replace(/\/$/, "");
    // Checking a path below an ignored directory must not open that directory.
    const parts = normalized.split("/");
    for (let n = 1; n <= parts.length; n++) {
      const selected = parts.slice(0, n).join("/"), parent = parts.slice(0, n - 1).join("/");
      if (excludedDirectory(selected) || ignoredIn(parent).has(selected)) return true;
    }
    return false;
  };
}

/** True for a path the indexer treats as an asset, by extension, any case. */
export function isAssetPath(path: string): boolean {
  const dot = path.lastIndexOf(".");
  if (dot <= path.lastIndexOf("/")) return false;
  return (ASSET_EXTENSIONS as readonly string[]).includes(path.slice(dot).toLowerCase());
}
