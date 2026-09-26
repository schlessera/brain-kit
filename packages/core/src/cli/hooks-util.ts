import { chmodSync, copyFileSync, existsSync, mkdirSync, statSync } from "fs";
import { join, resolve } from "path";

/** Hook scripts shipped in the core package (src/hooks). */
export const HOOK_NAMES = ["pre-commit", "post-commit", "post-checkout", "post-merge"];

/** Packaged hooks dir, resolved from this file at packages/core/src/cli. */
export function packagedHooksDir(): string {
  return resolve(import.meta.dir, "../hooks");
}

/** What a git-dependent step says when there is no git to run. */
export const GIT_MISSING = "git is not installed or not on PATH";

/** Whether a `git` executable is on PATH. Spawning a missing one throws. */
export function gitInstalled(): boolean {
  return Bun.which("git") !== null;
}

export function isGitRepo(root: string): boolean {
  if (existsSync(join(root, ".git"))) return true;
  if (!gitInstalled()) return false;
  return Bun.spawnSync(["git", "-C", root, "rev-parse", "--git-dir"]).exitCode === 0;
}

export interface HookInstallResult {
  installed: boolean;
  hooks: string[];
  hooksPath: string | null;
  /** Why nothing was installed: not a git repository, or no git to run. */
  skipped?: string;
}

/**
 * Copy the packaged hooks into `<root>/.githooks/` and point `core.hooksPath`
 * there. Copying (rather than only setting hooksPath to the node_modules path)
 * keeps the hooks working on a fresh clone that has not run `bun install`.
 * Idempotent: re-copies and re-sets the same value. No-op outside a git repo.
 */
export function installGitHooks(
  root: string,
  hooksSourceDir = packagedHooksDir()
): HookInstallResult {
  if (!gitInstalled()) {
    return { installed: false, hooks: [], hooksPath: null, skipped: GIT_MISSING };
  }
  if (!isGitRepo(root)) {
    return { installed: false, hooks: [], hooksPath: null, skipped: "not a git repository" };
  }

  if (!existsSync(hooksSourceDir) || !statSync(hooksSourceDir).isDirectory()) {
    throw new Error(`Packaged hooks directory does not exist: ${hooksSourceDir}`);
  }
  for (const name of HOOK_NAMES) {
    const source = join(hooksSourceDir, name);
    if (!existsSync(source) || !statSync(source).isFile()) {
      throw new Error(`Packaged hook is missing: ${source}`);
    }
  }

  const hooksDir = join(root, ".githooks");
  mkdirSync(hooksDir, { recursive: true });

  const hooks: string[] = [];
  for (const name of HOOK_NAMES) {
    const from = join(hooksSourceDir, name);
    const to = join(hooksDir, name);
    copyFileSync(from, to);
    try {
      chmodSync(to, 0o755);
    } catch {
      /* Windows: chmod is a no-op */
    }
    hooks.push(name);
  }

  Bun.spawnSync(["git", "-C", root, "config", "core.hooksPath", ".githooks"]);
  return { installed: true, hooks, hooksPath: ".githooks" };
}
