/** Proof-policy epochs (docs/decisions/ci-utility.md, "Proof-system lane",
 * answer 4). Each squash on main's first-parent history that
 * `scripts/proof-system.ts` classifies as a proof-system change opens a new
 * epoch, identified by that squash SHA and its commit time. A squash whose
 * classification cannot be computed opens an epoch with an `unknown` boundary,
 * so a comparison never silently spans a policy change. */
import { percentage, seconds } from "./ci-timing-stats";
import { classify, loadPathSet, parsePathSet, type PathSet } from "./proof-system";

const PATH_SET = "scripts/proof-system-paths.json";

export interface HistoryCommit { sha: string; parents: string[]; at: string }
export type CommitClassification = { proofSystem: boolean } | { error: string };
/** Main's first-parent history, newest first, and a classifier for one of its commits. */
export type EpochSource =
  | { ref: string; history: HistoryCommit[]; classify(commit: HistoryCommit): CommitClassification; lookback?: number }
  | { ref: string; error: string };

export interface Boundary { sha: string; at: string; kind: "proof-system" | "unknown"; error?: string }
export interface Delivery { number: number; merge: string | null; firstMainOutcome: string; firstMain: { run: number; attempt: number } | null }
export const UNBOUNDED = "unbounded";
/** Commits classified beyond the window's oldest commit while looking for the epoch it starts in. */
export const DEFAULT_LOOKBACK = 2000;

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed (${result.exitCode}): ${result.stderr.toString().trim()}`);
  return result.stdout.toString();
}

/** First-parent history of `ref` in a local checkout. Each squash is classified
 * with the path set in force when it merged, read from its first parent; history
 * from before `scripts/proof-system-paths.json` existed uses the current file. */
export function gitEpochSource(cwd: string, ref: string): EpochSource {
  try {
    if (!ref || ref.startsWith("-")) throw new Error(`Invalid history ref ${JSON.stringify(ref)}`);
    const history = git(cwd, ["log", "--first-parent", "--format=%H|%P|%cI", "--end-of-options", ref, "--"]).split("\n").filter(Boolean).map(line => {
      const [sha, parents, at] = line.split("|");
      return { sha: sha!, parents: parents ? parents.split(" ") : [], at: new Date(at!).toISOString() };
    });
    const current = loadPathSet(), sets = new Map<string, PathSet>();
    const pathSetAt = (commit: string): PathSet => {
      const blob = Bun.spawnSync(["git", "rev-parse", "--verify", "--quiet", `${commit}:${PATH_SET}`], { cwd, stdout: "pipe", stderr: "pipe" });
      if (blob.exitCode !== 0) return current;
      const id = blob.stdout.toString().trim();
      if (!sets.has(id)) sets.set(id, parsePathSet(git(cwd, ["cat-file", "blob", id]), `${commit}:${PATH_SET}`));
      return sets.get(id)!;
    };
    return { ref, history, classify(commit) {
      if (!commit.parents.length) return { error: "root commit has no parent to compare" };
      try { return { proofSystem: classify(commit.parents[0]!, commit.sha, { cwd, pathSet: pathSetAt(commit.parents[0]!) }).proofSystem }; }
      catch (error) { return { error: (error as Error).message }; }
    } };
  } catch (error) { return { ref, error: (error as Error).message }; }
}

/** Assigns each delivery to its epoch and summarizes every epoch the window touches. */
export function proofPolicyEpochs<D extends Delivery>(deliveries: D[], failureClassified: Set<string>,
  window: { since: string; until: string }, source: EpochSource) {
  const assigned = new Map<number, string | null>(deliveries.map(d => [d.number, null]));
  if ("error" in source) return { assigned, report: { ref: source.ref, status: "unavailable" as const, error: source.error,
    commitsClassified: 0, lookbackLimit: null, boundaries: [], epochs: [], unassigned: deliveries.map(d => d.number), current: null } };
  const since = Date.parse(window.since), until = Date.parse(window.until), lookback = source.lookback ?? DEFAULT_LOOKBACK;
  const index = new Map(source.history.map((c, i) => [c.sha, i]));
  // Newest commit before the window ends, and the oldest commit the window or a delivery needs.
  const top = source.history.findIndex(c => Date.parse(c.at) < until);
  const positions = deliveries.flatMap(d => d.merge !== null && index.has(d.merge) ? [index.get(d.merge)!] : []);
  let bottom = top < 0 ? -1 : Math.max(top, ...positions);
  for (let i = Math.max(top, 0); top >= 0 && i < source.history.length && Date.parse(source.history[i]!.at) >= since; i++) bottom = Math.max(bottom, i);
  const boundaries = new Map<number, Boundary>();
  let classified = 0;
  if (top >= 0) for (let i = Math.min(top, ...positions); i < source.history.length; i++) {
    if (i > bottom && (boundaries.size && [...boundaries.keys()].some(k => k >= bottom) || i > bottom + lookback)) break;
    const commit = source.history[i]!, result = source.classify(commit);
    classified++;
    if ("error" in result) boundaries.set(i, { sha: commit.sha, at: commit.at, kind: "unknown", error: result.error });
    else if (result.proofSystem) boundaries.set(i, { sha: commit.sha, at: commit.at, kind: "proof-system" });
  }
  // Oldest first. A delivery belongs to the nearest boundary at or below it in first-parent order.
  const starts = [...boundaries.entries()].sort(([a], [b]) => b - a);
  const epochOf = (position: number) => starts.filter(([i]) => i >= position).at(-1)?.[1].sha ?? UNBOUNDED;
  for (const d of deliveries) if (d.merge !== null && index.has(d.merge)) assigned.set(d.number, epochOf(index.get(d.merge)!));
  const currentId = top < 0 ? null : epochOf(top);
  const ids = [...(starts.length && starts[0]![0] >= bottom ? [] : [UNBOUNDED]), ...starts.map(([, b]) => b.sha)];
  const epochs = ids.map((id, n) => {
    const start = id === UNBOUNDED ? null : boundaries.get(index.get(id)!)!;
    const next = ids[n + 1] === undefined ? null : boundaries.get(index.get(ids[n + 1]!)!)!;
    const end = next ? next.at : window.until, members = deliveries.filter(d => assigned.get(d.number) === id);
    const known = members.filter(d => d.firstMainOutcome !== "unknown");
    return { id, start, end, current: id === currentId, durationSeconds: start ? seconds(start.at, end) : null,
      merges: members.length, deliveries: members.map(d => d.number),
      firstMainGreen: percentage(known.filter(d => d.firstMainOutcome === "success").length, known.length) };
  });
  const current = epochs.find(e => e.current) ?? null;
  const failed = current ? deliveries.filter(d => assigned.get(d.number) === current.id && d.firstMain &&
    !["success", "unknown"].includes(d.firstMainOutcome)) : [];
  const attributed = failed.filter(d => failureClassified.has(`${d.firstMain!.run}/${d.firstMain!.attempt}`)).length;
  return { assigned, report: { ref: source.ref, status: "derived" as const, error: undefined, commitsClassified: classified, lookbackLimit: lookback,
    boundaries: starts.map(([, b]) => b), epochs, unassigned: deliveries.filter(d => assigned.get(d.number) === null).map(d => d.number),
    current: current && { id: current.id, start: current.start, since: current.start?.at ?? null, until: window.until,
      days: current.durationSeconds === null ? null : current.durationSeconds / 86400, firstMainGreen: current.firstMainGreen,
      incidentAttribution: { status: attributed === 0 ? "unknown" as const : attributed < failed.length ? "partial" as const : "recorded" as const,
        failedFirstMainAttempts: failed.length, classifiedAttempts: attributed,
        note: "Counts failure-classified records for failed first-main attempts. No record means unknown, not unattributed; incidents outside first-main runs are not observed here." } } } };
}
