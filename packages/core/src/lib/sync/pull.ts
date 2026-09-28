/**
 * `brain sync pull`: fetch origin/main and bring it into HEAD, finishing merge
 * state a previous sync left pending first (#328). The derived caches are
 * merged by key, never left for anyone to resolve by hand.
 */

import { existsSync, readFileSync, rmSync, writeFileSync } from "fs";
import { resolve } from "path";

import { classifyPostSyncDirt, DERIVED_CACHES, workingTreeDirt } from "./assess.js";
import { git, isAncestor, unmergedPaths } from "./git.js";
import { conclude, foreignReason, pendingState, rememberStash, type PendingKind } from "./merge-state.js";

/** What `brain sync pull` reports. */
export interface PullEnvelope {
  status: "fetch-failed" | "synced" | "fast-forwarded" | "merged" | "conflicted" | "merge-failed" | string;
  /** Commits on each side before anything below moved HEAD. */
  localAhead: number;
  remoteAhead: number;
  conflicts: string[];
  mergedCaches: string[];
  /** The pending state this pull finished before it merged, if any. */
  concluded: PendingKind | null;
  reason?: string;
}

/** A cache as this clone had it: the file (null when gone) and its index entry (`ls-files -s`). */
interface CacheAside {
  file: string | null;
  index: string;
}

/**
 * Set local changes to the derived caches aside so a merge can touch them.
 * Hooks off: restoring a file fires post-checkout, whose reindex can rewrite
 * it right back.
 */
function setDerivedCachesAside(root: string): Map<string, CacheAside> {
  const aside = new Map<string, CacheAside>();
  for (const file of classifyPostSyncDirt(workingTreeDirt(root)).caches) {
    const path = resolve(root, file);
    aside.set(file, {
      file: existsSync(path) ? readFileSync(path, "utf-8") : null,
      index: git(root, ["ls-files", "-s", "--", file]).stdout,
    });
    if (git(root, ["cat-file", "-e", `HEAD:${file}`]).code === 0) {
      git(root, ["-c", "core.hooksPath=/dev/null", "restore", "--source=HEAD", "--staged", "--worktree", "--", file]);
    } else {
      git(root, ["rm", "--cached", "-q", "--ignore-unmatch", "--", file]);
      rmSync(path, { force: true });
    }
  }
  return aside;
}

/** Put the caches back exactly as they were, index and file, for when no merge happened. */
function putDerivedCachesBack(root: string, aside: Map<string, CacheAside>): void {
  for (const [file, saved] of aside) {
    const entry = /^(\d+) ([0-9a-f]+) 0\t/.exec(saved.index);
    if (entry) git(root, ["update-index", "--add", "--cacheinfo", `${entry[1]},${entry[2]},${file}`]);
    else git(root, ["rm", "--cached", "-q", "--ignore-unmatch", "--", file]);
    const path = resolve(root, file);
    if (saved.file === null) rmSync(path, { force: true });
    else writeFileSync(path, saved.file, "utf-8");
  }
}

/**
 * Union each cache's entries into one sorted file: what this clone set aside,
 * and the merge's result. A key both carry keeps its first line in sorted
 * order, the rule every sidecar reader applies, so two clones that generated
 * different text for one key settle on the same line instead of each keeping
 * its own and committing it back on every sync. For a conflicted cache
 * the result is read from the two sides' index stages, not the working file,
 * whose conflict rendering can carry the ancestor's stale lines (diff3). An
 * entry only this clone has may belong to a chunk the merge re-chunks, and the
 * reindex can recover it only from the file.
 */
function unionDerivedCaches(
  root: string,
  files: Iterable<string>,
  aside: Map<string, CacheAside>,
  conflicted: ReadonlySet<string>
): void {
  for (const file of files) {
    const path = resolve(root, file);
    const sources = [aside.get(file)?.file ?? ""];
    if (conflicted.has(file)) {
      for (const stage of [2, 3]) sources.push(git(root, ["show", `:${stage}:${file}`], true).stdout);
    } else if (existsSync(path)) {
      sources.push(readFileSync(path, "utf-8"));
    }
    const byKey = new Map<string, string>();
    const all = sources.join("\n").split("\n").filter((line) => line.trim());
    all.sort();
    for (const line of all) {
      // Only a line a reader would accept may compete for its key. A line
      // with no string value can sort first and would win, then every
      // reader rejects it and the key is lost.
      try {
        const { k, v } = JSON.parse(line) as { k?: unknown; v?: unknown };
        if (typeof k === "string" && k && typeof v === "string" && !byKey.has(k)) byKey.set(k, line);
      } catch {
        // skip malformed line
      }
    }
    const lines = [...byKey.values()]; // already in sorted order
    writeFileSync(path, lines.length ? lines.join("\n") + "\n" : "", "utf-8");
  }
}

/** What one pass of `pull` left, in the shape `pull` reports. */
interface PullPass {
  status: string;
  conflicts: string[];
  mergedCaches: string[];
  reason?: string;
}

/** The statuses that claim origin/main is in HEAD. */
const INTEGRATED = new Set(["synced", "fast-forwarded", "merged"]);

function countCommits(root: string, range: string): number {
  return parseInt(git(root, ["rev-list", "--count", range]).stdout || "0", 10);
}

/**
 * Bring origin/main into HEAD once: synced when it is there already, else a
 * fast-forward or a merge. The counts are taken afresh on each pass, because
 * concluding a pending merge before it moves HEAD.
 */
function mergeOriginMain(root: string): PullPass {
  const localAhead = countCommits(root, "origin/main..HEAD");
  const remoteAhead = countCommits(root, "HEAD..origin/main");

  // A cache this clone's reindex rewrote blocks a merge that touches it,
  // and post-sync pushes caches, so the other clone's commit usually does.
  // Set it aside for the merge and union it back after.
  // A merge already in progress owns the caches' index stages; setting
  // them aside would erase a cache conflict before it is resolved. A
  // squash merge leaves its stages without a MERGE_HEAD.
  const alreadyMerging =
    git(root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).code === 0 ||
    git(root, ["ls-files", "--unmerged"]).stdout !== "";
  const aside =
    remoteAhead > 0 && !alreadyMerging ? setDerivedCachesAside(root) : new Map<string, CacheAside>();

  let status: string;
  let conflicts: string[] = [];
  let reason: string | undefined;
  if (remoteAhead === 0) {
    status = "synced";
  } else if (localAhead === 0) {
    status = git(root, ["merge", "--ff-only", "origin/main"]).code === 0 ? "fast-forwarded" : "merge-failed";
  } else if (git(root, ["merge", "origin/main", "--no-edit"]).code === 0) {
    status = "merged";
  } else {
    // Classify on what the failed merge left in the index, not on
    // MERGE_HEAD: a squash merge (branch.main.mergeOptions) stops on
    // conflicts without one, and a merge left unfinished before this pull
    // keeps one with nothing to resolve. Unmerged paths are Phase 4's
    // work; none means git refused, which is only to report.
    conflicts = unmergedPaths(root);
    status = conflicts.length > 0 ? "conflicted" : "merge-failed";
  }

  // No merge started (git refused before touching the tree): put the
  // caches back as they were. Otherwise union them, which also resolves
  // a cache conflict, so Phase 4 never sees one.
  const merging =
    conflicts.length > 0 || git(root, ["rev-parse", "-q", "--verify", "MERGE_HEAD"]).code === 0;
  const cacheConflicts = conflicts.filter((file) => DERIVED_CACHES.has(file));
  const mergedCaches = [...new Set([...aside.keys(), ...cacheConflicts])];
  if (status === "fast-forwarded" || status === "merged" || merging) {
    unionDerivedCaches(root, mergedCaches, aside, new Set(cacheConflicts));
    if (cacheConflicts.length > 0) {
      git(root, ["add", "--", ...cacheConflicts]);
      conflicts = conflicts.filter((file) => !DERIVED_CACHES.has(file));
      if (conflicts.length === 0) {
        const done = conclude(root);
        status = done.outcome === "committed" ? "merged" : "merge-failed";
        reason = done.detail;
      }
    }
  } else {
    putDerivedCachesBack(root, aside);
  }
  return reason === undefined ? { status, conflicts, mergedCaches } : { status, conflicts, mergedCaches, reason };
}

/**
 * `pull` after its fetch. Merge state already pending when it runs is dealt
 * with first (#328): a rebase, cherry-pick, revert or am is never touched,
 * nor is a merge or squash a sync did not start (`foreignReason`, judged
 * against origin/main as just fetched), nor one with nothing unmerged, which
 * is its owner's to commit; unmerged derived caches are unioned from their stages, as in a merge this
 * pull starts; any other unmerged path is reported for resolution before a
 * merge is tried, since git would refuse one over it. With nothing left
 * unmerged the pending state is finished by its kind (`conclude`).
 *
 * A status in INTEGRATED claims origin/main is in HEAD, and must be true. A
 * pass can leave it out (a squash merge never records it as a parent), so a
 * pass that does gets one more, and after that the pull is merge-failed.
 */
function pullOriginMain(root: string): { pass: PullPass; concluded: PendingKind | null } {
  const pending = pendingState(root);
  if (pending.kind === "blocked") {
    const reason = `a ${pending.blocker} is in progress`;
    return { pass: { status: "merge-failed", conflicts: [], mergedCaches: [], reason }, concluded: null };
  }

  // Not even its caches are touched: their stages are the owner's.
  if (pending.kind === "merge" || pending.kind === "squash") {
    const reason = foreignReason(root, pending.kind);
    if (reason) return { pass: { status: "merge-failed", conflicts: [], mergedCaches: [], reason }, concluded: null };
  }

  // A merge or squash with nothing unmerged is its owner's to commit (a
  // `--no-commit` merge, or a squash git stopped before committing). A merge
  // over it is refused, and a refused squash merge deletes SQUASH_MSG, which
  // turns the squash into staged work nothing tells from anyone else's.
  if ((pending.kind === "merge" || pending.kind === "squash") && pending.unmerged.length === 0) {
    const reason = `a ${pending.kind} is pending with nothing unmerged; finish it with \`brain sync conclude\``;
    return { pass: { status: "merge-failed", conflicts: [], mergedCaches: [], reason }, concluded: null };
  }

  const resolvedCaches = pending.unmerged.filter((file) => DERIVED_CACHES.has(file));
  let concluded: PendingKind | null = null;
  let committed = false;
  // A stash leftover resolved since it was remembered has nothing unmerged
  // and is still unstaged here.
  if (pending.unmerged.length > 0 || pending.kind === "stash") {
    unionDerivedCaches(root, resolvedCaches, new Map(), new Set(resolvedCaches));
    if (resolvedCaches.length > 0) git(root, ["add", "--", ...resolvedCaches]);
    const conflicts = pending.unmerged.filter((file) => !DERIVED_CACHES.has(file));
    if (conflicts.length > 0) {
      rememberStash(root, pending);
      return { pass: { status: "conflicted", conflicts, mergedCaches: resolvedCaches }, concluded: null };
    }
    const done = conclude(root, pending);
    if (done.outcome !== "committed" && done.outcome !== "unstaged") {
      const reason = done.detail ?? done.outcome;
      return { pass: { status: "merge-failed", conflicts: [], mergedCaches: resolvedCaches, reason }, concluded: null };
    }
    concluded = pending.kind;
    committed = done.outcome === "committed";
  }

  let pass = mergeOriginMain(root);
  if (INTEGRATED.has(pass.status) && !isAncestor(root, "origin/main", "HEAD")) {
    // A pass that left state pending (a squash merge git did not commit)
    // would only be refused by a second merge.
    if (pendingState(root).kind === "none") {
      const again = mergeOriginMain(root);
      pass = { ...again, mergedCaches: [...new Set([...pass.mergedCaches, ...again.mergedCaches])] };
    }
    if (INTEGRATED.has(pass.status) && !isAncestor(root, "origin/main", "HEAD")) {
      pass = { ...pass, status: "merge-failed", reason: "origin/main is not in HEAD" };
    }
  }
  // Nothing new to fetch, but the pull did finish a merge.
  if (committed && pass.status === "synced") pass = { ...pass, status: "merged" };
  return { pass: { ...pass, mergedCaches: [...new Set([...resolvedCaches, ...pass.mergedCaches])] }, concluded };
}

/** Fetch origin/main, then `pullOriginMain`. */
export function pull(root: string): PullEnvelope {
  const fetch = git(root, ["fetch", "origin", "main"]);
  if (fetch.code !== 0) {
    return {
      status: "fetch-failed",
      localAhead: 0,
      remoteAhead: 0,
      conflicts: [],
      mergedCaches: [],
      concluded: null,
      reason: fetch.stderr || fetch.stdout,
    };
  }
  // Measured before anything below moves HEAD.
  const localAhead = countCommits(root, "origin/main..HEAD");
  const remoteAhead = countCommits(root, "HEAD..origin/main");
  const { pass, concluded } = pullOriginMain(root);
  const { status, conflicts, mergedCaches, reason } = pass;
  return { status, localAhead, remoteAhead, conflicts, mergedCaches, concluded, ...(reason === undefined ? {} : { reason }) };
}
