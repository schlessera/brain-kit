/** The proof-system lane's merge gates (docs/decisions/ci-utility.md,
 * "Proof-system lane", answers 1–3): the two-consecutive-green-main stability window
 * (#3269) and off-main qualification evidence on the PR (#3271).
 *
 * `integrate.ts confirm` and `merge` refuse a proof-system candidate with the
 * refusals built here, and `integrate.ts lane --json` reports the same
 * `LaneDecision`. Which diffs are proof-system changes is decided only by
 * `classify` from `scripts/proof-system.ts`; this file lists no globs.
 *
 * Every GitHub read goes through a caller-supplied lookup so the gate stays
 * bounded: at most `MAX_MAIN_RUNS` main-run reads and `MAX_QUALIFICATION_RUNS` run
 * reads per decision. */
import { classify, type ClassifyOptions } from "./proof-system";

/** Consecutive completed-green main runs required after the proof-system
 * squash's own green run, and again after any later failure (answer 2, as
 * clarified on #3269, issuecomment-6575963951). */
export const STREAK = 2;
/** Main-push runs one lane decision reads at most: the own run and up to nine later ones. */
export const MAX_MAIN_RUNS = 10;
/** First-parent main squashes examined for the last proof-system change. */
export const SCAN_LIMIT = 200;
/** Run URLs read from one PR body's qualification section. */
export const MAX_QUALIFICATION_RUNS = 5;
export const QUALIFICATION_HEADING = "Off-main qualification";

export interface MainRun { id: number; status: string; conclusion: string | null }
/** One main squash the decision read, in merge order; position 0 is the proof-system squash itself. */
export interface WindowEntry { position: number; sha: string; run: MainRun | null; green: boolean }
export interface LaneDecision {
  schemaVersion: 1;
  /** The main squash the history was read from. */
  main: string;
  /** The most recent proof-system squash within the scan, or null. */
  proofSystemSquash: string | null;
  scanned: number;
  /** `unknown`: no two consecutive green runs within `MAX_MAIN_RUNS` while later squashes exist. */
  state: "open" | "closed" | "unknown";
  open: boolean;
  ownGreen: boolean | null;
  /** Consecutive green later runs counted when the decision stopped. */
  streak: number;
  /** Green main runs still required, or null when unknown. */
  required: number | null;
  window: WindowEntry[];
  /** The squash whose run the decision needs next; null once decided. */
  next: string | null;
}

function git(cwd: string, args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) throw new Error(`git ${args.join(" ")} failed: ${result.stderr.toString().trim()}`);
  return result.stdout.toString().trim();
}

/** Only a completed, successful run is green: missing, queued, in-progress,
 * cancelled, failed, skipped or timed-out runs are not. */
export function isGreen(run: MainRun | null): boolean {
  return run?.status === "completed" && run.conclusion === "success";
}

/** `later` holds at most `MAX_MAIN_RUNS - 1` squashes after the proof-system
 * squash, in merge order; `more` says whether main has squashes beyond them. */
export interface ProofSystemHistory { squash: string | null; later: string[]; more: boolean; scanned: number }

/** The most recent first-parent squash at or before `main` whose diff to its
 * parent is a proof-system change, and the squashes after it within the bound. */
export function lastProofSystemSquash(main: string, options: ClassifyOptions & { limit?: number } = {}): ProofSystemHistory {
  const cwd = options.cwd ?? process.cwd();
  const lines = git(cwd, ["rev-list", "--first-parent", "--parents", `--max-count=${options.limit ?? SCAN_LIMIT}`, main]).split("\n").filter(Boolean);
  const newestFirst: string[] = [];
  for (const line of lines) {
    const [sha, parent] = line.split(" ") as [string, string | undefined];
    newestFirst.push(sha);
    if (parent && classify(parent, sha, options).proofSystem) {
      const index = newestFirst.length - 1, from = Math.max(0, index - (MAX_MAIN_RUNS - 1));
      return { squash: sha, later: newestFirst.slice(from, index).reverse(), more: from > 0, scanned: newestFirst.length };
    }
  }
  return { squash: null, later: [], more: false, scanned: newestFirst.length };
}

/** The stability-window decision from the runs read so far. Pure: `lane
 * --json` and the refusal both read it, and `readLane` reads the run it names
 * in `next` until it is null.
 *
 * The own run must be green. Later runs then count toward `STREAK`
 * consecutive greens; a completed run that is not green (failed, cancelled,
 * timed out) restarts the count, and so does a squash with no run when a later
 * squash exists. A queued or in-progress run, or a missing run at the newest
 * squash, is pending: the count stops there, not yet green. */
export function decideLane(main: string, history: ProofSystemHistory, runs: ReadonlyMap<string, MainRun | null>): LaneDecision {
  const base = { schemaVersion: 1 as const, main, proofSystemSquash: history.squash, scanned: history.scanned };
  if (!history.squash) return { ...base, state: "open", open: true, ownGreen: null, streak: 0, required: 0, window: [], next: null };
  const window: WindowEntry[] = [];
  const closed = (ownGreen: boolean, streak: number, next: string | null = null): LaneDecision =>
    ({ ...base, state: "closed", open: false, ownGreen, streak, required: (ownGreen ? 0 : 1) + STREAK - streak, window, next });
  const shas = [history.squash, ...history.later];
  let streak = 0;
  for (const [position, sha] of shas.entries()) {
    if (!runs.has(sha)) return closed(position > 0, streak, sha);
    const run = runs.get(sha) ?? null, green = isGreen(run);
    window.push({ position, sha, run, green });
    const pending = run ? run.status !== "completed" : position === shas.length - 1 && !history.more;
    if (position === 0) { if (!green) return closed(false, 0); continue; }
    if (green) { if (++streak === STREAK) return { ...base, state: "open", open: true, ownGreen: true, streak, required: 0, window, next: null }; }
    else if (pending) return closed(true, streak);
    else streak = 0;
  }
  if (history.more) return { ...base, state: "unknown", open: false, ownGreen: true, streak, required: null, window, next: null };
  return closed(true, streak);
}

/** Reads the decision: local first-parent history plus at most `MAX_MAIN_RUNS` run lookups, in merge order. */
export async function readLane(main: string, runAt: (sha: string) => Promise<MainRun | null>, options: ClassifyOptions = {}): Promise<LaneDecision> {
  const cwd = options.cwd ?? process.cwd();
  const resolved = git(cwd, ["rev-parse", "--verify", "--end-of-options", `${main}^{commit}`]);
  const history = lastProofSystemSquash(resolved, options);
  const runs = new Map<string, MainRun | null>();
  for (;;) {
    const decision = decideLane(resolved, history, runs);
    if (!decision.next || runs.size >= MAX_MAIN_RUNS) return decision;
    runs.set(decision.next, await runAt(decision.next));
  }
}

const short = (sha: string) => sha.slice(0, 12);
function describe(entry: WindowEntry): string {
  const label = entry.position === 0 ? "own run" : `next run ${entry.position}`;
  if (!entry.run) return `${label} at ${short(entry.sha)}: no main-push CI run`;
  return `${label} at ${short(entry.sha)}: run ${entry.run.id} ${entry.run.status === "completed" ? entry.run.conclusion ?? "no conclusion" : entry.run.status}`;
}

/** The stability-window refusal, or null when the lane is open. */
export function laneRefusal(decision: LaneDecision): string | null {
  if (decision.open) return null;
  const runs = decision.window.length ? decision.window.map(describe).join("; ") : "no main run read";
  const squash = `the last proof-system squash ${decision.proofSystemSquash}`;
  if (decision.state === "unknown") return `Proof-system lane unknown: ${squash} has no ${STREAK} consecutive green main runs within the ${MAX_MAIN_RUNS} main runs this check reads (${runs}). Ask a maintainer to inspect main`;
  const required = `${decision.required} more green main run${decision.required === 1 ? "" : "s"} required`;
  if (!decision.ownGreen) return `Proof-system lane closed: ${squash} needs its own main run green first, then ${STREAK} consecutive green main runs (${runs}); ${required}. Rerun its main run if it failed or was cancelled`;
  return `Proof-system lane closed: ${squash} needs ${STREAK} consecutive green main runs after its own green run (${runs}); ${required}. ` +
    `A failed or cancelled run restarts the count; a queued or in-progress run is not green yet`;
}

/** The PR body's "Off-main qualification" section without HTML comments, or
 * null when the body has no such heading. */
export function qualificationSection(body: string | null | undefined): string | null {
  const lines = (body ?? "").replace(/\r\n/g, "\n").replace(/<!--[\s\S]*?(?:-->|$)/g, "").split("\n");
  const heading = (line: string) => /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
  const start = lines.findIndex(line => heading(line)?.[2]?.toLowerCase() === QUALIFICATION_HEADING.toLowerCase());
  if (start < 0) return null;
  const level = heading(lines[start]!)![1]!.length, section: string[] = [];
  for (const line of lines.slice(start + 1)) {
    const next = heading(line);
    if (next && next[1]!.length <= level) break;
    section.push(line);
  }
  return section.join("\n");
}

/** GitHub Actions run IDs linked from `text` for `repository` (owner/name), in order. */
export function qualificationRunIds(text: string, repository: string): number[] {
  const ids: number[] = [];
  for (const match of text.matchAll(/https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/actions\/runs\/([1-9]\d*)/g)) {
    const id = Number(match[2]);
    if (match[1]!.toLowerCase() === repository.toLowerCase() && Number.isSafeInteger(id) && !ids.includes(id)) ids.push(id);
  }
  return ids;
}

export interface QualificationRun { id: number; headSha: string | null; repository: string | null }
export interface QualificationEvidence { run: number; headSha: string; via: "head" | "ancestor" }

/** Whether a run's head SHA qualifies `head`: it is the head, or an ancestor
 * whose diff to the head is not a proof-system change. Returns why not. */
export function qualifies(run: QualificationRun, repository: string, head: string, options: ClassifyOptions = {}): "head" | "ancestor" | string {
  if (run.repository?.toLowerCase() !== repository.toLowerCase()) return `run ${run.id} is not a run in ${repository}`;
  if (!run.headSha || !/^[a-f0-9]{40}$/.test(run.headSha)) return `run ${run.id} has no head SHA`;
  if (run.headSha === head) return "head";
  const cwd = options.cwd ?? process.cwd();
  const ancestor = Bun.spawnSync(["git", "merge-base", "--is-ancestor", run.headSha, head], { cwd, stdout: "pipe", stderr: "pipe" });
  if (ancestor.exitCode !== 0) return `run ${run.id} ran on ${short(run.headSha)}, which is not an ancestor of the head ${short(head)}`;
  const after = classify(run.headSha, head, options);
  if (after.proofSystem) return `run ${run.id} ran on ${short(run.headSha)}, and the diff from there to the head is a proof-system change (${after.reasons.map(r => r.path).filter((p, i, all) => all.indexOf(p) === i).join(", ")})`;
  return "ancestor";
}

/** Off-main qualification for a proof-system candidate: evidence, or the refusal naming what is missing. */
export async function checkQualification(input: { body: string | null | undefined; repository: string; head: string;
  readRun: (id: number) => Promise<QualificationRun | null>; ensure?: (sha: string) => void } & ClassifyOptions,
): Promise<{ evidence: QualificationEvidence } | { refusal: string }> {
  const how = `Add an "## ${QUALIFICATION_HEADING}" section to the PR body naming the replay or dispatch run URLs (https://github.com/${input.repository}/actions/runs/<id>), the head SHA they ran on and the comparison they establish`;
  const section = qualificationSection(input.body);
  if (section === null) return { refusal: `Off-main qualification missing: the PR body has no "${QUALIFICATION_HEADING}" section. ${how}` };
  const ids = qualificationRunIds(section, input.repository);
  if (!ids.length) return { refusal: `Off-main qualification missing: the "${QUALIFICATION_HEADING}" section links no GitHub Actions run in ${input.repository}. ${how}` };
  const problems: string[] = [];
  for (const id of ids.slice(0, MAX_QUALIFICATION_RUNS)) {
    const run = await input.readRun(id);
    if (!run) { problems.push(`run ${id} was not found`); continue; }
    if (run.headSha && run.headSha !== input.head && input.ensure) {
      try { input.ensure(run.headSha); } catch { problems.push(`run ${id} ran on ${short(run.headSha)}, which cannot be fetched`); continue; }
    }
    const verdict = qualifies(run, input.repository, input.head, input);
    if (verdict === "head" || verdict === "ancestor") return { evidence: { run: id, headSha: run.headSha!, via: verdict } };
    problems.push(verdict);
  }
  return { refusal: `Off-main qualification missing: no linked run ran on the head ${short(input.head)} or on an ancestor with no proof-system change after it (${problems.join("; ")}). ${how}` };
}
