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
import { matchesAnyPattern } from "../tool-leftovers.js";
import { SENSITIVE_PATTERNS } from "./assess.js";
import { git, gitPath, isAncestor, refExists, unmergedPaths } from "./git.js";

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

const ORIGIN_MAIN = "refs/remotes/origin/main";

/**
 * The commits a merge or squash brings in: every line of MERGE_HEAD, or every
 * `commit <sha>` line of SQUASH_MSG. Git writes SQUASH_MSG as "Squashed commit
 * of the following:", then one `git log`-style block per commit, newest
 * first, whose header line is `commit <full sha>` at column 0 and whose
 * message is indented four spaces, so no message line can pose as one.
 */
function incoming(root: string, kind: "merge" | "squash"): string[] {
  const file = gitPath(root, kind === "merge" ? "MERGE_HEAD" : "SQUASH_MSG");
  if (!existsSync(file)) return [];
  const line = kind === "merge" ? /^([0-9a-f]{40,64})$/ : /^commit ([0-9a-f]{40,64})$/;
  const shas: string[] = [];
  for (const text of readFileSync(file, "utf-8").split("\n")) {
    const m = line.exec(text.trimEnd());
    if (m) shas.push(m[1]!);
  }
  return shas;
}

function nulSeparated(root: string, args: string[]): string[] {
  return git(root, args, true).stdout.split("\0").filter(Boolean);
}

/**
 * Why a sync must not commit this merge or squash, or null when it may. A
 * sync commits only what a pull started: a merge or squash of origin/main,
 * known by every commit it brings in being in origin/main as fetched. One
 * someone started of their own branch is theirs to finish. And a commit takes
 * the whole index, so it is refused while the index stages a secret-shaped
 * path at other than origin/main's version, or any path the merge does not
 * bring in (work staged beside it, which no merge of origin/main put there).
 */
export function foreignReason(root: string, kind: "merge" | "squash"): string | null {
  const shas = incoming(root, kind);
  const record = kind === "merge" ? "MERGE_HEAD" : "SQUASH_MSG";
  if (shas.length === 0) return `the pending ${kind}'s ${record} names no commit`;
  if (!refExists(root, ORIGIN_MAIN)) return `there is no origin/main to tell this ${kind} is a sync's`;
  const foreign = shas.filter((sha) => !isAncestor(root, sha, ORIGIN_MAIN));
  if (foreign.length > 0) {
    const names = foreign.map((sha) => sha.slice(0, 12)).join(", ");
    return `a ${kind} of ${names}, which is not in origin/main, is in progress; sync did not start it, so finish or abort it with git`;
  }

  const staged = nulSeparated(root, ["diff", "--cached", "--name-only", "-z", "--no-renames", "HEAD"]);
  const secrets = staged.filter(
    (path) =>
      matchesAnyPattern(path, SENSITIVE_PATTERNS) &&
      git(root, ["rev-parse", "-q", "--verify", `:0:${path}`]).stdout !==
        git(root, ["rev-parse", "-q", "--verify", `${ORIGIN_MAIN}:${path}`]).stdout
  );
  if (secrets.length > 0) return `the index stages ${secrets.join(", ")}, which origin/main does not hold; unstage it before the ${kind} is committed`;

  const brought = new Set<string>();
  for (const sha of shas) {
    const base = git(root, ["merge-base", "HEAD", sha]).stdout;
    if (!base) return `the pending ${kind} shares no history with HEAD`;
    for (const path of nulSeparated(root, ["diff", "--name-only", "-z", "--no-renames", base, sha])) brought.add(path);
  }
  const stray = staged.filter((path) => !brought.has(path));
  if (stray.length > 0) return `the index stages ${stray.join(", ")} beside the ${kind}, which does not bring it in; unstage it before the ${kind} is committed`;
  return null;
}

export type ConcludeOutcome = "committed" | "unstaged" | "nothing" | "blocked" | "unresolved" | "failed";

export interface Conclusion {
  outcome: ConcludeOutcome;
  kind: PendingKind;
  detail?: string;
}

/**
 * Finish `state` by its kind once nothing is unmerged. A merge or a squash is
 * committed with the message git prepared, and only when a sync started it
 * (`foreignReason`); one it did not is blocked. A stash leftover is never
 * committed: the paths it had unmerged are unstaged, so they become ordinary
 * working-tree changes, and its stash entry is left for whoever reconciles
 * stashes. A path whose staged version the working tree no longer has is
 * never unstaged, since that version would be lost: the leftover then fails
 * and nothing changes. A blocked operation is never finished here.
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
    const drifted = known.filter(
      (path) => git(root, ["--literal-pathspecs", "diff", "--quiet", "--", path]).code !== 0
    );
    if (drifted.length > 0) {
      return {
        outcome: "failed",
        kind,
        detail: `the working tree no longer has the version staged for ${drifted.join(", ")}; unstaging would lose it`,
      };
    }
    const restored =
      known.length === 0 ? null : git(root, ["--literal-pathspecs", "restore", "--staged", "--", ...known]);
    if (restored && restored.code !== 0) {
      return { outcome: "failed", kind, detail: restored.stderr || restored.stdout };
    }
    rmSync(gitPath(root, STASH_MARKER), { force: true });
    return { outcome: "unstaged", kind };
  }

  const foreign = foreignReason(root, kind);
  if (foreign) return { outcome: "blocked", kind, detail: foreign };
  const committed = git(root, ["commit", "--no-edit"]);
  return committed.code === 0
    ? { outcome: "committed", kind }
    : { outcome: "failed", kind, detail: committed.stderr || committed.stdout };
}
