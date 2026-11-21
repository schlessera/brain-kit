import { isWithin } from "@schlessera/brain-common/internal/safe-path";
/** Git ignore decisions for the entries the discovery walk actually reaches. */
import { existsSync, readFileSync, readdirSync, type Dirent } from "node:fs";
import { isAbsolute, join, relative } from "node:path";
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
  const cache = new Map<string, Set<string>>(), modules = new Map<string, string[]>();
  function declaredModules(worktree: string): string[] {
    let paths=modules.get(worktree); if(paths) return paths;
    let text="";
    try { text=readFileSync(join(root,worktree,".gitmodules"),"utf8"); } catch { /* No declaration. */ }
    paths=[...text.matchAll(/^\s*path\s*=\s*(.+?)\s*$/gm)].map(match=>match[1]!.replace(/\/+$/, ""))
      .filter(path=>path && !isAbsolute(path) && !path.split("/").includes(".."))
      .map(path=>join(worktree,path)).filter(path=>!excludedDirectory(path) && existsSync(join(root,path,".git")));
    modules.set(worktree,paths); return paths;
  }
  function worktreeFor(directory: string): string {
    let worktree="";
    for(let depth=0;depth<8;depth++) {
      const nested=declaredModules(worktree).find(path=>isWithin(path,directory));
      if(!nested) break;worktree=nested;
    }
    return worktree;
  }
  function ignoredIn(directory: string): Set<string> {
    const cached = cache.get(directory); if (cached) return cached;
    const ignored = new Set<string>(); cache.set(directory, ignored);
    // Only declared initialized submodules establish another Git context.
    const worktree=worktreeFor(directory);
    // ls-files stopped at undeclared repositories. Preserve that boundary:
    // their contents remain discoverable, but inner ignore rules do not apply.
    let prefix=worktree;
    for(const part of relative(worktree,directory).split("/").filter(Boolean)) {
      prefix=join(prefix,part);
      if(existsSync(join(root,prefix,".git")))return ignored;
    }
    let entries: Dirent[];
    try { entries = readdirSync(join(root, directory), { withFileTypes: true }); }
    catch (error) { if (["ENOENT", "ENOTDIR"].includes((error as NodeJS.ErrnoException).code ?? "")) return ignored; throw error; }
    const paths = entries
      .filter(entry => !entry.name.startsWith(".") && (!entry.isDirectory() || !excludedDirectory(join(directory, entry.name))))
      .map(entry => "./" + relative(worktree, join(directory, entry.name)) + (entry.isDirectory() ? "/" : ""));
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
      if (((n < parts.length || path.endsWith("/")) && excludedDirectory(selected)) || ignoredIn(parent).has(selected)) return true;
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
