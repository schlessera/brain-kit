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
import { ARTIFACT_PATTERNS, assess, DERIVED_CACHES, domainFor, SENSITIVE_PATTERNS } from "./assess.js";
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
import { conclude, pendingState, type Conclusion } from "./merge-state.js";
import { pull, type PullEnvelope } from "./pull.js";
import { renderReport } from "./report.js";
import { planMerge, type MergeInput } from "./resolve/plan.js";
import { strategyFor } from "./resolve/strategy.js";
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
    /** Planned paths git still does not ignore. */
    notIgnored: string[];
    /** Why nothing was written, when `.gitignore` could not be changed safely. */
    refused?: string;
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
 * and any other stays UNKNOWN. ARTIFACT and SENSITIVE files are ignored
 * (`planIgnores` / `applyIgnores`), all in one `.gitignore` commit.
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

  const plan = planIgnores(files, { artifact: ARTIFACT_PATTERNS, sensitive: SENSITIVE_PATTERNS });
  const applied = applyIgnores(root, plan);
  const fixed: AssessFixEnvelope["fixed"] = {
    ignored: plan.additions,
    committed: applied.commit,
    trackedArtifacts: plan.tracked,
    judged,
    notIgnored: applied.notIgnored,
  };
  if (applied.refused !== undefined) fixed.refused = applied.refused;
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
}

/** The TRACK files of an assessment as `group` lists them, and the set a plan may commit. */
export function trackedGroups(env: SyncEnv, files: AssessedFile[]): { groups: GroupedFile[]; allowed: Set<string> } {
  const groups = files
    .filter((file) => file.class === "TRACK")
    .map((file) => ({ domain: domainFor(file.path, env.taxonomy), status: file.status, path: file.path }));
  return { groups, allowed: new Set(groups.map((group) => group.path)) };
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
 */
export function commitTracked(env: SyncEnv, files: AssessedFile[], plan?: CommitPlan): CommitEnvelope {
  const { groups, allowed } = trackedGroups(env, files);
  const planned = plan ? plan.commits.flatMap((commit) => commit.files) : groups;
  const bump = planned.every((file) => allowed.has(file.path))
    ? bumpUpdated(env.root, planned, env.today)
    : { bumped: [], refused: [] };
  const commits = applyCommitPlan(env.root, plan ?? planCommits(env.root, groups), allowed);
  return { commits, bumped: bump.bumped, refused: bump.refused };
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
 * one is left exactly as git left it. Nothing is committed.
 */
export async function resolveConflicts(env: SyncEnv): Promise<ResolveEnvelope> {
  const { root } = env;
  const envelope: ResolveEnvelope = { status: "resolved", resolved: [], unresolved: [], skipped: [], judge: env.judge.report() };
  const files: { input: MergeInput; strategy: MergeStrategy }[] = [];
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
    files.push({ input, strategy: strategyFor(path, env.taxonomy, input) });
  }

  const pairs = files.flatMap(({ input, strategy }) => planMerge(input, strategy).pairs);
  const judged = pairs.length > 0 ? await env.judge.decidePairs(pairs) : new Map();
  const decisions = new Map<string, PairDecision>([...judged].map(([id, j]) => [id, j.decision]));

  for (const { input, strategy } of files) {
    // Planned again at write time: a keep-both copy written for an earlier
    // file now counts as taken.
    const plan = planMerge(input, strategy);
    const outcome = plan.render(decisions);
    if (outcome.status === "unresolved") {
      envelope.unresolved.push({ path: input.path, strategy, reason: outcome.reason });
      continue;
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
      continue;
    }
    for (const extra of outcome.extraFiles) {
      mkdirSync(dirname(resolve(root, extra.path)), { recursive: true });
      writeFileSync(resolve(root, extra.path), extra.content, "utf-8");
      git(root, ["--literal-pathspecs", "add", "--", extra.path]);
    }
    envelope.resolved.push({
      path: input.path,
      strategy,
      notes,
      decisions: { jev, default: unjudged },
      extraFiles: outcome.extraFiles.map((extra) => extra.path),
      deleted: outcome.content === null,
    });
  }
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
 * 4. the stash again, since a resolution can make an entry redundant;
 * 5. `push`; rejected (the remote moved) → back to 3, pulling at most
 *    MAX_PULLS times in all;
 * 6. `post-sync`.
 */
export async function runSync(env: SyncEnv): Promise<RunEnvelope> {
  const { root } = env;
  const steps: RunEnvelope["steps"] = {
    stash: [], assess: [], commit: [], pull: [], resolve: [], conclude: [], push: [], postSync: [],
  };
  let lastAssess: AssessFixEnvelope | null = null;
  const timings: RunEnvelope["timings"] = {};
  const timed = async <T>(step: keyof RunEnvelope["steps"], fn: () => T | Promise<T>): Promise<T> => {
    const start = performance.now();
    try {
      return await fn();
    } finally {
      timings[step] = (timings[step] ?? 0) + (performance.now() - start);
    }
  };

  const finish = (status: RunStatus, reason?: string): RunEnvelope => {
    const last = steps.resolve[steps.resolve.length - 1];
    const files = lastAssess?.files ?? [];
    const envelope: RunEnvelope = {
      status,
      ...(reason === undefined ? {} : { reason }),
      steps,
      leftovers: {
        unresolved: status === "needs-judgment" && last ? last.unresolved : [],
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

  const commitLocal = async (): Promise<void> => {
    const assessed = await timed("assess", () => assessFix(env));
    lastAssess = assessed;
    steps.assess.push(assessed);
    steps.commit.push(await timed("commit", () => commitTracked(env, assessed.files)));
  };

  const branch = currentBranch(root);
  if (branch !== "main") return finish("failed", `not on main branch (current: ${branch})`);

  steps.stash.push(await timed("stash", () => reconcileStashes(root)));
  const pendingAtStart = pendingState(root);
  let commitAfterPull = false;
  if (pendingAtStart.kind === "none") {
    await commitLocal();
  } else {
    steps.assess.push({ skipped: `merge state is pending (${pendingAtStart.kind}); pull finishes it first` });
    // Whatever it was, finishing it leaves this clone's own work to commit:
    // a stash leftover's resolved files are unstaged, not committed. It is
    // also the only way to one; nothing this run does leaves a stash leftover.
    commitAfterPull = pendingAtStart.kind !== "blocked";
  }

  let concludedPending = false;
  for (let pulls = 0; ; ) {
    if (pulls >= MAX_PULLS) return finish("failed", `still not pushed after ${MAX_PULLS} pulls`);

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
    const pulled = await timed("pull", () => pull(root));
    steps.pull.push(pulled);
    if (pulled.status === "fetch-failed" || pulled.status === "merge-failed") {
      return finish("failed", `pull: ${pulled.status}${pulled.reason ? ` — ${pulled.reason}` : ""}`);
    }

    if (pulled.status === "conflicted") {
      const resolved = await timed("resolve", () => resolveConflicts(env));
      steps.resolve.push(resolved);
      if (resolved.status === "needs-judgment") {
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
      await commitLocal();
    }
    // A conflict pull found already pending was resolved without a fetch-merge.
    if (!isAncestor(root, "origin/main", "HEAD")) continue;

    steps.stash.push(await timed("stash", () => reconcileStashes(root)));
    const pushed = await timed("push", () => pushMain(root));
    steps.push.push(pushed);
    if (pushed.status !== "rejected") break;
  }

  steps.postSync.push(await timed("postSync", () => env.postSync()));
  return finish("complete");
}
