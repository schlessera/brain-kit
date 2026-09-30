/**
 * The sync verbs that act, and `brain sync run`, which chains them into a
 * whole sync with no agent: set stashes straight, ignore what should not be
 * tracked, commit the rest by domain, pull, resolve what git could not merge
 * by the file's strategy, push, and reindex.
 *
 * Every step is one of the verbs a caller can also run alone. `run` decides
 * only the order and when to stop: a conflict no strategy resolves stops it
 * with the merge left in progress and nothing pushed (`needs-judgment`), for
 * whoever can write the merge. Unknown files and media are listed, never a
 * reason to stop: an unattended sync leaves them where they are.
 *
 * Git answers every question about the repository; the judge (Jev, when a
 * key is set) only picks between outcomes a rule already allows, and a
 * judgment it does not return means the conservative default.
 */

import { closeSync, existsSync, mkdirSync, openSync, readSync, writeFileSync } from "fs";
import { dirname, resolve } from "path";

import type { MediaPolicy } from "../media.js";
import type { Taxonomy } from "../taxonomy.js";
import {
  applyIgnores,
  planIgnores,
  type AssessedFile,
  type IgnoreAddition,
  type IgnoreCommit,
  type IgnoreReason,
} from "./artifacts.js";
import { matchesAnyPattern } from "../tool-leftovers.js";
import {
  ARTIFACT_PATTERNS,
  assess,
  CONFLICT_OPEN_GREP,
  conflictMarked,
  DERIVED_CACHES,
  domainFor,
  hasConflictMarkers,
  SENSITIVE_PATTERNS,
  UNAMBIGUOUS_SENSITIVE_PATTERNS,
} from "./assess.js";
import {
  applyCommitPlan,
  bumpUpdated,
  planCommits,
  type CommitPlan,
  type CommitResult,
  type GroupedFile,
} from "./commit.js";
import { currentBranch, git, isAncestor, unmergedPaths } from "./git.js";
import { FILE_HEAD_MAX_BYTES, type SyncJudge, type SyncJudgeReport } from "./judge.js";
import { conclude, pendingState, rememberResolvedExtras, type Conclusion } from "./merge-state.js";
import { pull, type PullEnvelope } from "./pull.js";
import { renderReport } from "./report.js";
import { planMerge, type MergeInput } from "./resolve/plan.js";
import { strategyFor, type MergeSides } from "./resolve/strategy.js";
import { reconcileStashes, type StashReport } from "./stash.js";
import type { FileDecision, MergeStrategy, PairDecision, UnknownFile } from "./types.js";

/** What `brain sync post-sync` reports. */
export interface PostSyncResult {
  skills: string;
  index: string;
  cacheCommit: string;
  treeDirty: string[];
  branch: string;
  localHead: string;
  remoteHead: string;
  sync: "complete" | "dirty" | "diverged";
  warnings: string[];
}

/** What the verbs need from the brain they run in. */
export interface SyncEnv {
  root: string;
  taxonomy: Taxonomy;
  media: MediaPolicy;
  /** One per sync, so every judgment of one run lands in one report. */
  judge: SyncJudge;
  /** Divergent pull policy; unset defaults to rebase with merge fallback. */
  pullStrategy?: "rebase" | "merge";
  /** The local calendar date, `YYYY-MM-DD`, that `updated` is bumped to. */
  today: string;
  /** The reindex and skill sync; it needs the CLI's providers, so it is passed in. */
  postSync(): Promise<PostSyncResult>;
}

/** Today in the local time zone, as `YYYY-MM-DD`: the day the person syncing is living. */
export function localDate(now: Date = new Date()): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

// ---------------------------------------------------------------------------
// assess --fix
// ---------------------------------------------------------------------------

export interface AssessFixEnvelope {
  branch: string;
  /** `assess`'s files, with the classes the judge settled. */
  files: AssessedFile[];
  fixed: {
    /** The `.gitignore` lines the plan asked for, written now or already there. */
    ignored: IgnoreAddition[];
    /** The `.gitignore` commit, or null when nothing was written. */
    committed: IgnoreCommit | null;
    /** Artifacts and secrets git already tracks: ignoring them changes nothing. */
    trackedArtifacts: { path: string; reason: IgnoreReason }[];
    /** UNKNOWN files the judge decided, at or above its line. */
    judged: { path: string; decision: FileDecision; confidence: number }[];
    /**
     * SENSITIVE files whose name only may be a secret's (`*_token*` also
     * names notes): made UNKNOWN, so neither ignored nor committed, with why.
     */
    heldBack: { path: string; reason: string }[];
    /** Planned paths git still does not ignore. */
    notIgnored: string[];
    /** Why nothing was written, when `.gitignore` could not be changed safely. */
    refused?: string;
    /** Why nothing was written, when git or the file system failed (`IgnoreResult.failed`); the run fails. */
    failed?: string;
  };
}

/** The start of a file as text, enough for the judge's bounded head. Null when unreadable. */
function readHead(root: string, path: string): { head: string; bytes: number } | null {
  let fd: number | null = null;
  try {
    fd = openSync(resolve(root, path), "r");
    // Twice the bound: the judge cuts on a character boundary itself.
    const buffer = Buffer.alloc(FILE_HEAD_MAX_BYTES * 2);
    const read = readSync(fd, buffer, 0, buffer.length, 0);
    const size = Bun.file(resolve(root, path)).size;
    return { head: new TextDecoder().decode(buffer.subarray(0, read)), bytes: size };
  } catch {
    return null;
  } finally {
    if (fd !== null) closeSync(fd);
  }
}

/**
 * `assess`, then settle what it can: an UNKNOWN file the judge calls an
 * artifact is ignored by its exact path, one it calls content becomes TRACK,
 * and any other stays UNKNOWN. ARTIFACT files and SENSITIVE files whose name
 * settles it (`UNAMBIGUOUS_SENSITIVE_PATTERNS`) are ignored (`planIgnores` /
 * `applyIgnores`), all in one `.gitignore` commit. Any other SENSITIVE file
 * becomes UNKNOWN, held back for someone to decide; the judge never sees it.
 */
export async function assessFix(env: SyncEnv): Promise<AssessFixEnvelope> {
  const { root } = env;
  const files = assess(root, env.media);

  const unknown: UnknownFile[] = [];
  for (const file of files) {
    if (file.class !== "UNKNOWN" || file.status === "D") continue;
    const read = readHead(root, file.path);
    if (read) unknown.push({ id: file.path, path: file.path, head: read.head, bytes: read.bytes });
  }
  const decided = unknown.length > 0 ? await env.judge.classifyFiles(unknown) : new Map();
  const judged: AssessFixEnvelope["fixed"]["judged"] = [];
  for (const file of files) {
    const judgment = decided.get(file.path);
    if (!judgment) continue;
    file.class = judgment.decision === "artifact" ? "ARTIFACT" : "TRACK";
    judged.push({ path: file.path, decision: judgment.decision, confidence: judgment.confidence });
  }
  const heldBack: AssessFixEnvelope["fixed"]["heldBack"] = [];
  for (const file of files) {
    if (file.class !== "SENSITIVE" || matchesAnyPattern(file.path, UNAMBIGUOUS_SENSITIVE_PATTERNS)) continue;
    file.class = "UNKNOWN";
    const pattern = SENSITIVE_PATTERNS.find((p) => matchesAnyPattern(file.path, [p]));
    heldBack.push({ path: file.path, reason: `its name matches ${pattern}, so it may be a secret: not ignored, not committed` });
  }

  const plan = planIgnores(files, { artifact: ARTIFACT_PATTERNS, sensitive: SENSITIVE_PATTERNS });
  const applied = applyIgnores(root, plan);
  const fixed: AssessFixEnvelope["fixed"] = {
    ignored: plan.additions,
    committed: applied.commit,
    trackedArtifacts: plan.tracked,
    judged,
    heldBack,
    notIgnored: applied.notIgnored,
  };
  if (applied.refused !== undefined) fixed.refused = applied.refused;
  if (applied.failed !== undefined) fixed.failed = applied.failed;
  return { branch: currentBranch(root), files, fixed };
}

// ---------------------------------------------------------------------------
// commit
// ---------------------------------------------------------------------------

export interface CommitEnvelope {
  commits: CommitResult[];
  /** Files whose `updated` was set to today before committing. */
  bumped: string[];
  /** Files whose `updated` could not be set without rewriting other frontmatter. */
  refused: string[];
  /** TRACK files left uncommitted because they hold a conflict-marker block. */
  conflicted: string[];
}

/**
 * The TRACK files of an assessment as `group` lists them, and the set a plan
 * may commit. A file holding a conflict-marker block is in neither: it is
 * returned as `conflicted`, never committed.
 */
export function trackedGroups(
  env: SyncEnv,
  files: AssessedFile[]
): { groups: GroupedFile[]; allowed: Set<string>; conflicted: string[] } {
  const track = files.filter((file) => file.class === "TRACK");
  const conflicted = new Set(conflictMarked(env.root, track.filter((file) => file.status !== "D").map((file) => file.path)));
  const groups = track
    .filter((file) => !conflicted.has(file.path))
    .map((file) => ({ domain: domainFor(file.path, env.taxonomy), status: file.status, path: file.path }));
  return { groups, allowed: new Set(groups.map((group) => group.path)), conflicted: [...conflicted] };
}

/** The plan `commit` would apply to `files`, changing nothing (`commit --plan`). */
export function planTracked(env: SyncEnv, files: AssessedFile[]): CommitPlan {
  return planCommits(env.root, trackedGroups(env, files).groups);
}

/**
 * Commit the TRACK files of `files`: `updated` bumped to today where the body
 * changed, then one commit per domain (`planCommits`). With `plan`, that plan
 * is applied instead, its messages as given and its files checked against the
 * TRACK set; `updated` is bumped only when every file it names is in that set.
 * A file holding conflict markers is left out of the TRACK set (`trackedGroups`).
 */
export function commitTracked(env: SyncEnv, files: AssessedFile[], plan?: CommitPlan): CommitEnvelope {
  const { groups, allowed, conflicted } = trackedGroups(env, files);
  const planned = plan ? plan.commits.flatMap((commit) => commit.files) : groups;
  const bump = planned.every((file) => allowed.has(file.path))
    ? bumpUpdated(env.root, planned, env.today)
    : { bumped: [], refused: [] };
  const commits = applyCommitPlan(env.root, plan ?? planCommits(env.root, groups), allowed);
  return { commits, bumped: bump.bumped, refused: bump.refused, conflicted };
}

// ---------------------------------------------------------------------------
// resolve
// ---------------------------------------------------------------------------

export interface ResolvedFile {
  path: string;
  strategy: MergeStrategy;
  notes: string[];
  /** How many of the file's passage pairs the judge decided, and how many took the default. */
  decisions: { jev: number; default: number };
  /** Files written beside it: keep-both's `<name>-remote.md`. */
  extraFiles: string[];
  /** True when the merge deleted the file. */
  deleted: boolean;
}

export interface ResolveEnvelope {
  status: "resolved" | "needs-judgment";
  resolved: ResolvedFile[];
  unresolved: { path: string; strategy: MergeStrategy; reason: string }[];
  /** Derived caches: `pull` merges those, so `resolve` leaves them alone. */
  skipped: { path: string; reason: string }[];
  judge: SyncJudgeReport;
}

/** A conflicted file's stage (1 base, 2 ours, 3 theirs) as text, or null when that side has no file. */
function stage(root: string, n: 1 | 2 | 3, path: string): string | null {
  const shown = git(root, ["show", `:${n}:${path}`], true);
  return shown.code === 0 ? shown.stdout : null;
}

/** Taken in the working tree, the index or HEAD: a keep-both copy must not land on it. */
function taken(root: string, path: string): boolean {
  return existsSync(resolve(root, path)) || git(root, ["--literal-pathspecs", "ls-files", "--error-unmatch", "--", path]).code === 0;
}

/**
 * Resolve every unmerged path the index holds by its strategy
 * (`strategyFor` → `planMerge`). The passage pairs of all files go to the
 * judge in one call; a pair it does not decide keeps both sides, newer first.
 * A resolved file is written and staged (a deleted one removed); an unresolved
 * one is left exactly as git left it. Nothing is committed. A strategy that
 * throws leaves its file unresolved with the error as the reason; nothing
 * here throws into the run.
 */
export async function resolveConflicts(env: SyncEnv): Promise<ResolveEnvelope> {
  const { root } = env;
  const envelope: ResolveEnvelope = { status: "resolved", resolved: [], unresolved: [], skipped: [], judge: env.judge.report() };
  const files: { input: MergeInput; strategy: MergeStrategy; pairs: ReturnType<typeof planMerge>["pairs"] }[] = [];
  const failed = (path: string, strategy: MergeStrategy, e: unknown) =>
    envelope.unresolved.push({ path, strategy, reason: `the ${strategy} merge failed: ${(e as Error)?.message ?? String(e)}` });
  for (const path of unmergedPaths(root)) {
    if (DERIVED_CACHES.has(path)) {
      envelope.skipped.push({ path, reason: "a derived cache: pull merges it by key" });
      continue;
    }
    const input: MergeInput = {
      path,
      base: stage(root, 1, path),
      ours: stage(root, 2, path),
      theirs: stage(root, 3, path),
      exists: (candidate) => taken(root, candidate),
    };
    let strategy: MergeStrategy = "code-merge";
    try {
      strategy = strategyFor(path, env.taxonomy, input);
      // Planned once here to collect its pairs; one that throws goes no further.
      files.push({ input, strategy, pairs: planMerge(input, strategy).pairs });
    } catch (e) {
      failed(path, strategy, e);
    }
  }

  const pairs = files.flatMap((file) => file.pairs);
  const judged = pairs.length > 0 ? await env.judge.decidePairs(pairs) : new Map();
  const decisions = new Map<string, PairDecision>([...judged].map(([id, j]) => [id, j.decision]));

  const writeResolution = (input: MergeInput, strategy: MergeStrategy): void => {
    // Planned again at write time: a keep-both copy written for an earlier
    // file now counts as taken.
    const plan = planMerge(input, strategy);
    const outcome = plan.render(decisions);
    if (outcome.status === "unresolved") {
      envelope.unresolved.push({ path: input.path, strategy, reason: outcome.reason });
      return;
    }
    const jev = plan.pairs.filter((pair) => decisions.has(pair.id)).length;
    const unjudged = plan.pairs.length - jev;
    const notes = [...outcome.notes];
    if (unjudged > 0) {
      const why = env.judge.enabled ? "Jev did not clear its line" : "Jev is off";
      notes.push(`${unjudged} of ${plan.pairs.length} passage pairs kept both by default (${why})`);
    }
    const target = resolve(root, input.path);
    let staged;
    if (outcome.content === null) {
      staged = git(root, ["--literal-pathspecs", "rm", "-q", "-f", "--", input.path]);
    } else {
      writeFileSync(target, outcome.content, "utf-8");
      staged = git(root, ["--literal-pathspecs", "add", "--", input.path]);
    }
    if (staged.code !== 0) {
      envelope.unresolved.push({ path: input.path, strategy, reason: `could not stage the merge: ${staged.stderr || staged.stdout}` });
      return;
    }
    for (const extra of outcome.extraFiles) {
      mkdirSync(dirname(resolve(root, extra.path)), { recursive: true });
      writeFileSync(resolve(root, extra.path), extra.content, "utf-8");
      const added = git(root, ["--literal-pathspecs", "add", "--", extra.path]);
      if (added.code !== 0) {
        envelope.unresolved.push({ path: input.path, strategy, reason: `could not stage ${extra.path}: ${added.stderr || added.stdout}` });
        return;
      }
    }
    envelope.resolved.push({
      path: input.path,
      strategy,
      notes,
      decisions: { jev, default: unjudged },
      extraFiles: outcome.extraFiles.map((extra) => extra.path),
      deleted: outcome.content === null,
    });
  };

  for (const { input, strategy } of files) {
    try {
      writeResolution(input, strategy);
    } catch (e) {
      failed(input.path, strategy, e);
    }
  }
  // Whoever concludes the merge, this run or a later verb, takes them as the sync's own.
  rememberResolvedExtras(root, envelope.resolved.flatMap((file) => file.extraFiles));
  if (envelope.unresolved.length > 0 || unmergedPaths(root).some((path) => !DERIVED_CACHES.has(path))) {
    envelope.status = "needs-judgment";
  }
  envelope.judge = env.judge.report();
  return envelope;
}

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------

export interface PushEnvelope {
  status: "pushed" | "rejected" | "up-to-date";
  detail: string;
}

export type RunStatus = "complete" | "needs-judgment" | "failed";

export interface RunEnvelope {
  status: RunStatus;
  /** Why the run stopped, when it did not complete. */
  reason?: string;
  /** Each step's envelopes, in the order they ran; a step can run more than once. */
  steps: {
    stash: StashReport[];
    assess: (AssessFixEnvelope | { skipped: string })[];
    commit: CommitEnvelope[];
    pull: PullEnvelope[];
    resolve: ResolveEnvelope[];
    conclude: Conclusion[];
    push: PushEnvelope[];
    postSync: PostSyncResult[];
  };
  leftovers: {
    unresolved: ResolveEnvelope["unresolved"];
    unknown: string[];
    media: { path: string; bytes: number }[];
  };
  judge: SyncJudgeReport;
  /** Wall time per step in milliseconds, summed over each time it ran. */
  timings: Partial<Record<keyof RunEnvelope["steps"], number>>;
  report: string;
}

/** The first pull and three re-pulls, whatever sent the run back to pull. */
export const MAX_PULLS = 4;

/** Push main, or say there is nothing to push. */
function pushMain(root: string): PushEnvelope {
  if (git(root, ["rev-parse", "HEAD"]).stdout === git(root, ["rev-parse", "-q", "--verify", "origin/main"]).stdout) {
    return { status: "up-to-date", detail: "HEAD is origin/main" };
  }
  const pushed = git(root, ["push", "origin", "main"]);
  return { status: pushed.code === 0 ? "pushed" : "rejected", detail: pushed.stderr || pushed.stdout };
}

type Unresolved = ResolveEnvelope["unresolved"][number];

/** An unresolved leftover for `path`, under the strategy its text would be merged by. */
function leftover(env: SyncEnv, path: string, sides: MergeSides, reason: string): Unresolved {
  let strategy: MergeStrategy = "code-merge";
  try {
    strategy = strategyFor(path, env.taxonomy, sides);
  } catch {
    // The reason is what matters here; code-merge is the strategy that assumes nothing.
  }
  return { path, strategy, reason };
}

/**
 * What stops HEAD from being pushed: a path the index still holds unmerged,
 * or a file HEAD changes from origin/main that holds a conflict-marker block.
 * `error` when git could not say.
 */
function unpushable(env: SyncEnv): { unresolved: Unresolved[] } | { error: string } {
  const { root } = env;
  const unresolved = unmergedPaths(root).map((path) =>
    leftover(env, path, { base: stage(root, 1, path), ours: stage(root, 2, path), theirs: stage(root, 3, path) }, "still unmerged in the index")
  );
  const changed = git(root, ["diff", "--name-only", "-z", "--no-renames", "--diff-filter=d", "origin/main", "HEAD"], true);
  if (changed.code !== 0) return { error: `could not list what the push carries: ${changed.stderr}` };
  const paths = changed.stdout.split("\0").filter(Boolean);
  if (paths.length === 0) return { unresolved };
  // git grep narrows the candidates; `hasConflictMarkers` decides on the whole file.
  const found = git(root, ["--literal-pathspecs", "grep", "-l", "-z", "-E", CONFLICT_OPEN_GREP, "HEAD", "--", ...paths], true);
  if (found.code > 1) return { error: `could not search what the push carries: ${found.stderr}` };
  for (const hit of found.stdout.split("\0").filter(Boolean)) {
    const path = hit.slice("HEAD:".length);
    const text = git(root, ["cat-file", "blob", `HEAD:${path}`], true);
    if (text.code !== 0 || !hasConflictMarkers(text.stdout)) continue;
    unresolved.push(leftover(env, path, { base: null, ours: text.stdout, theirs: null }, "committed with conflict markers; nothing is pushed until it is fixed"));
  }
  return { unresolved };
}

/** Why a stash drop or pop that git refused fails the run. */
function stashFailure(report: StashReport): string {
  return `stash: ${report.failed.map((entry) => `${entry.ref} (${entry.sha.slice(0, 12)}) ${entry.reason}`).join("; ")}`;
}

/**
 * Why a post-sync failed the run, or null: a step it reports FAILED, heads
 * that disagree, or working-tree dirt the run did not already list as a
 * leftover (`listed`).
 */
function postSyncFailure(post: PostSyncResult, listed: ReadonlySet<string>): string | null {
  const failures: string[] = [];
  if (post.skills.startsWith("FAILED")) failures.push(`skills ${post.skills}`);
  if (post.index.startsWith("FAILED")) failures.push(`index ${post.index}`);
  if (post.cacheCommit.startsWith("FAILED") || post.cacheCommit.startsWith("skipped") || post.cacheCommit.includes("push rejected")) {
    failures.push(`caches ${post.cacheCommit}`);
  }
  if (post.sync === "diverged") failures.push(`local ${post.localHead} and remote ${post.remoteHead} diverged`);
  const stray = post.treeDirty.filter((path) => !listed.has(path));
  if (stray.length > 0) failures.push(`left uncommitted: ${stray.join(", ")}`);
  return failures.length > 0 ? `post-sync: ${failures.join("; ")}` : null;
}

/**
 * The whole sync, in order:
 * 1. on main only; settle the stash;
 * 2. `assess --fix` and `commit`, unless merge state is already pending —
 *    its staged files are the merge's, not local work, so `pull` finishes
 *    it first and the local work is committed after;
 * 3. `pull`; a conflict goes to `resolve`, and anything it cannot resolve
 *    stops the run with the merge in progress (`needs-judgment`); resolved,
 *    it is concluded, and a stash leftover's files are committed like any
 *    local change;
 * 4. the stash again, since a resolution can make an entry redundant; what
 *    an autostash pop puts back is committed like any local change;
 * 5. `push`, unless the index holds an unmerged path or HEAD carries a file
 *    with conflict markers (`needs-judgment`); rejected (the remote moved) →
 *    back to 3, pulling at most MAX_PULLS times in all;
 * 6. `post-sync`.
 *
 * A TRACK file holding conflict markers is never committed: it is left as an
 * unresolved leftover, the rest syncs, and the run ends `needs-judgment`. A
 * step that fails — a commit or the `.gitignore` commit, a post-sync step,
 * heads left apart, dirt no leftover names, or a step that throws — ends it
 * `failed`.
 */
export async function runSync(env: SyncEnv): Promise<RunEnvelope> {
  const { root } = env;
  const steps: RunEnvelope["steps"] = {
    stash: [], assess: [], commit: [], pull: [], resolve: [], conclude: [], push: [], postSync: [],
  };
  let lastAssess: AssessFixEnvelope | null = null;
  const unresolved: Unresolved[] = [];
  const timings: RunEnvelope["timings"] = {};
  let running: keyof RunEnvelope["steps"] | null = null;
  const timed = async <T>(step: keyof RunEnvelope["steps"], fn: () => T | Promise<T>): Promise<T> => {
    const start = performance.now();
    running = step;
    try {
      return await fn();
    } finally {
      timings[step] = (timings[step] ?? 0) + (performance.now() - start);
    }
  };

  const finish = (status: RunStatus, reason?: string): RunEnvelope => {
    const files = lastAssess?.files ?? [];
    const envelope: RunEnvelope = {
      status,
      ...(reason === undefined ? {} : { reason }),
      steps,
      leftovers: {
        unresolved: unresolved.filter((file, i) => unresolved.findIndex((other) => other.path === file.path) === i),
        unknown: files.filter((file) => file.class === "UNKNOWN").map((file) => file.path),
        media: files
          .filter((file) => (file.class === "MEDIA" || file.class === "LARGE") && file.status !== "D")
          .map((file) => ({ path: file.path, bytes: file.bytes ?? 0 })),
      },
      judge: env.judge.report(),
      timings,
      report: "",
    };
    envelope.report = renderReport(envelope);
    return envelope;
  };

  /** Assess, fix and commit the local work; why it failed, or null. */
  const commitLocal = async (): Promise<string | null> => {
    const assessed = await timed("assess", () => assessFix(env));
    lastAssess = assessed;
    steps.assess.push(assessed);
    if (assessed.fixed.failed !== undefined) return `the .gitignore lines could not be checked: ${assessed.fixed.failed}`;
    if (assessed.fixed.committed?.status === "failed") return `the .gitignore commit failed: ${assessed.fixed.committed.reason}`;
    const committed = await timed("commit", () => commitTracked(env, assessed.files));
    steps.commit.push(committed);
    for (const path of committed.conflicted) {
      const text = readHead(root, path)?.head ?? null;
      unresolved.push(leftover(env, path, { base: null, ours: text, theirs: null }, "holds conflict markers; left uncommitted"));
    }
    const failed = committed.commits.flatMap((result) => ("error" in result ? [`${result.subject}: ${result.error}`] : []));
    return failed.length > 0 ? `commit failed: ${failed.join("; ")}` : null;
  };

  const branch = currentBranch(root);
  if (branch !== "main") return finish("failed", `not on main branch (current: ${branch})`);

  try {
    const settled = await timed("stash", () => reconcileStashes(root));
    steps.stash.push(settled);
    if (settled.failed.length > 0) return finish("failed", stashFailure(settled));
    const pendingAtStart = pendingState(root);
    let commitAfterPull = false;
    if (pendingAtStart.kind === "none") {
      const failed = await commitLocal();
      if (failed) return finish("failed", failed);
    } else {
      steps.assess.push({ skipped: `merge state is pending (${pendingAtStart.kind}); pull finishes it first` });
      // Whatever it was, finishing it leaves this clone's own work to commit:
      // a stash leftover's resolved files are unstaged, not committed. It is
      // also the only way to one; nothing this run does leaves a stash leftover.
      commitAfterPull = pendingAtStart.kind !== "blocked";
    }

    let concludedPending = false;
    for (let pulls = 0; ; ) {
      if (pulls >= MAX_PULLS) {
        const last = steps.push[steps.push.length - 1];
        return finish("failed", `still not pushed after ${MAX_PULLS} pulls${last ? `: ${last.detail}` : ""}`);
      }

      // A merge or squash with nothing left unmerged: finished once, the way
      // `pull` asks for, before pulling over it.
      const pending = pendingState(root);
      if (!concludedPending && (pending.kind === "merge" || pending.kind === "squash") && pending.unmerged.length === 0) {
        concludedPending = true;
        const done = await timed("conclude", () => conclude(root, pending));
        steps.conclude.push(done);
        if (done.outcome !== "committed") return finish("failed", `could not finish the pending ${pending.kind}: ${done.detail ?? done.outcome}`);
      }

      pulls++;
      const pulled = await timed("pull", () => pull(root, env.pullStrategy));
      steps.pull.push(pulled);
      if (pulled.status === "fetch-failed" || pulled.status === "merge-failed") {
        return finish("failed", `pull: ${pulled.status}${pulled.reason ? ` — ${pulled.reason}` : ""}`);
      }

      if (pulled.status === "conflicted") {
        const resolved = await timed("resolve", () => resolveConflicts(env));
        steps.resolve.push(resolved);
        if (resolved.status === "needs-judgment") {
          unresolved.push(...resolved.unresolved);
          return finish("needs-judgment", "a conflict no strategy resolves; the merge is left in progress");
        }
        const done = await timed("conclude", () => conclude(root));
        steps.conclude.push(done);
        if (done.outcome !== "committed" && done.outcome !== "unstaged") {
          return finish("failed", `could not conclude the resolved merge: ${done.detail ?? done.outcome}`);
        }
      }

      if (commitAfterPull) {
        commitAfterPull = false;
        const failed = await commitLocal();
        if (failed) return finish("failed", failed);
      }
      // A conflict pull found already pending was resolved without a fetch-merge.
      if (!isAncestor(root, "origin/main", "HEAD")) continue;

      const stashed = await timed("stash", () => reconcileStashes(root));
      steps.stash.push(stashed);
      if (stashed.failed.length > 0) return finish("failed", stashFailure(stashed));
      if (stashed.popped.length > 0) {
        const failed = await commitLocal();
        if (failed) return finish("failed", failed);
      }
      const blocked = unpushable(env);
      if ("error" in blocked) return finish("failed", blocked.error);
      if (blocked.unresolved.length > 0) {
        unresolved.push(...blocked.unresolved);
        return finish("needs-judgment", "HEAD is not pushed: it carries conflict markers or unmerged paths");
      }
      const pushed = await timed("push", () => pushMain(root));
      steps.push.push(pushed);
      if (pushed.status !== "rejected") break;
    }

    const post = await timed("postSync", () => env.postSync());
    steps.postSync.push(post);
    const listed = new Set([
      ...unresolved.map((file) => file.path),
      // Every file an assessment did not take for a commit is named in the report.
      ...steps.assess.flatMap((assess) => ("skipped" in assess ? [] : assess.files))
        .filter((file) => file.class !== "TRACK" && file.class !== "DERIVED")
        .map((file) => file.path),
    ]);
    const failure = postSyncFailure(post, listed);
    if (failure) return finish("failed", failure);
    if (unresolved.length > 0) return finish("needs-judgment", "files with conflict markers were left uncommitted");
    return finish("complete");
  } catch (e) {
    return finish("failed", `${running ?? "run"} threw: ${(e as Error)?.message ?? String(e)}`);
  }
}
