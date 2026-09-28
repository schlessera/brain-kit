/**
 * Merge state a repository can be left holding between two syncs, and how a
 * sync finishes it once nothing in it is unmerged.
 *
 * Git records most of these shapes as files in the git directory. A
 * conflicted `git stash pop` (or `stash apply`, or `checkout -m`) records none:
 * its unmerged index entries are the only trace, so once they are resolved
 * with `git add` nothing tells it from work someone staged. `rememberStash`
 * writes that trace itself (STASH_MARKER) while the entries are still
 * unmerged, and `pendingState` reads it back after they are resolved.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { git, gitPath, refExists, unmergedPaths } from "./git.js";

/**
 * The stash leftover's paths, under the git directory beside git's own
 * MERGE_HEAD. It holds the HEAD it was written at: once HEAD moves, the
 * paths it names may have been committed, and it describes nothing.
 */
const STASH_MARKER = "BRAIN_SYNC_STASH";

export type PendingKind = "none" | "merge" | "squash" | "stash" | "blocked";

export interface PendingState {
  kind: PendingKind;
  /** `unmergedPaths(root)` when the state was read. */
  unmerged: string[];
  /** Only when `kind` is "blocked": the operation that owns the index. */
  blocker?: "rebase" | "cherry-pick" | "revert" | "am";
  /**
   * Only when `kind` is "stash": every path the leftover had unmerged,
   * resolved since or not. `conclude` unstages these.
   */
  stashPaths?: string[];
}

/**
 * The operation in progress that a sync must never finish on its owner's
 * behalf, or undefined. `git am` and `rebase --apply` share `rebase-apply/`;
 * only `am` writes `applying` in it. A cherry-pick or revert of several
 * commits keeps `sequencer/todo` between its stops, after its `*_HEAD` is
 * gone, and git status still reports it as in progress until `--continue`.
 */
function blockerOf(root: string): PendingState["blocker"] {
  if (existsSync(gitPath(root, "rebase-apply"))) {
    return existsSync(gitPath(root, "rebase-apply/applying")) ? "am" : "rebase";
  }
  if (existsSync(gitPath(root, "rebase-merge"))) return "rebase";
  if (refExists(root, "CHERRY_PICK_HEAD")) return "cherry-pick";
  if (refExists(root, "REVERT_HEAD")) return "revert";
  const todo = gitPath(root, "sequencer/todo");
  if (existsSync(todo)) return /^revert\s/.test(readFileSync(todo, "utf-8")) ? "revert" : "cherry-pick";
  return undefined;
}

/**
 * First match wins:
 * - blocked: a rebase, cherry-pick, revert or am is in progress.
 * - merge: `MERGE_HEAD` exists, unmerged entries or not.
 * - squash: `SQUASH_MSG` exists and there is something to commit, unmerged or
 *   staged. `git merge --squash` never writes `MERGE_HEAD`, and a
 *   `SQUASH_MSG` with nothing staged has nothing left to finish.
 * - stash: unmerged entries and none of the above, or a STASH_MARKER
 *   written at the current HEAD (the same leftover after its resolution).
 */
export function pendingState(root: string): PendingState {
  const unmerged = unmergedPaths(root);
  const blocker = blockerOf(root);
  if (blocker) return { kind: "blocked", unmerged, blocker };
  if (refExists(root, "MERGE_HEAD")) return { kind: "merge", unmerged };
  if (existsSync(gitPath(root, "SQUASH_MSG"))) {
    const staged = git(root, ["diff", "--cached", "--quiet"]).code === 1;
    if (unmerged.length > 0 || staged) return { kind: "squash", unmerged };
  }
  const remembered = rememberedStash(root);
  if (unmerged.length === 0 && remembered.length === 0) return { kind: "none", unmerged };
  return { kind: "stash", unmerged, stashPaths: [...new Set([...remembered, ...unmerged])] };
}

function headSha(root: string): string {
  return git(root, ["rev-parse", "-q", "--verify", "HEAD"]).stdout;
}

/** The paths a STASH_MARKER written at the current HEAD names, else none. */
function rememberedStash(root: string): string[] {
  const marker = gitPath(root, STASH_MARKER);
  if (!existsSync(marker)) return [];
  try {
    const saved = JSON.parse(readFileSync(marker, "utf-8")) as { head?: unknown; paths?: unknown };
    if (saved.head !== headSha(root) || !Array.isArray(saved.paths)) return [];
    return saved.paths.filter((path): path is string => typeof path === "string");
  } catch {
    return [];
  }
}

/**
 * Record a stash leftover's paths while they are still unmerged, so that
 * `pendingState` still reports it once someone resolves them with `git add`.
 * Anything but a stash leftover is left unrecorded: git keeps its own trace.
 */
export function rememberStash(root: string, state: PendingState): void {
  if (state.kind !== "stash" || state.unmerged.length === 0) return;
  const paths = state.stashPaths ?? state.unmerged;
  writeFileSync(gitPath(root, STASH_MARKER), JSON.stringify({ head: headSha(root), paths }) + "\n", "utf-8");
}

export type ConcludeOutcome = "committed" | "unstaged" | "nothing" | "blocked" | "unresolved" | "failed";

export interface Conclusion {
  outcome: ConcludeOutcome;
  kind: PendingKind;
  detail?: string;
}

/**
 * Finish `state` by its kind once nothing is unmerged. A merge or a squash is
 * committed with the message git prepared. A stash leftover is never
 * committed: the paths it had unmerged are unstaged, so they become ordinary
 * working-tree changes, and its stash entry is left for whoever reconciles
 * stashes. A blocked operation is never finished here.
 *
 * `state` defaults to the repository's state now. A stash leftover left
 * unresolved is remembered (`rememberStash`), so a later call still finds it.
 */
export function conclude(root: string, state: PendingState = pendingState(root)): Conclusion {
  const { kind } = state;
  if (kind === "blocked") return { outcome: "blocked", kind, detail: `a ${state.blocker} is in progress` };
  const unmerged = unmergedPaths(root);
  if (unmerged.length > 0) {
    rememberStash(root, state);
    return { outcome: "unresolved", kind, detail: `unmerged: ${unmerged.join(", ")}` };
  }
  if (kind === "none") return { outcome: "nothing", kind };

  if (kind === "stash") {
    // Literal pathspecs: a path is a file name, never a glob. A path neither
    // HEAD nor the index knows is already unstaged, and `restore` would
    // reject it as a pathspec that matches nothing.
    const known = (state.stashPaths ?? state.unmerged).filter(
      (path) =>
        refExists(root, `HEAD:${path}`) ||
        git(root, ["--literal-pathspecs", "ls-files", "--error-unmatch", "--", path]).code === 0
    );
    const restored =
      known.length === 0 ? null : git(root, ["--literal-pathspecs", "restore", "--staged", "--", ...known]);
    if (restored && restored.code !== 0) {
      return { outcome: "failed", kind, detail: restored.stderr || restored.stdout };
    }
    rmSync(gitPath(root, STASH_MARKER), { force: true });
    return { outcome: "unstaged", kind };
  }

  const committed = git(root, ["commit", "--no-edit"]);
  return committed.code === 0
    ? { outcome: "committed", kind }
    : { outcome: "failed", kind, detail: committed.stderr || committed.stdout };
}
