/** The proof-system lane's merge gates (docs/decisions/ci-utility.md,
 * "Proof-system lane", answers 1–3): the single-run stability window (#3269)
 * and off-main qualification evidence on the PR (#3271).
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

/** Main-push runs one lane decision reads at most: the own run and up to nine later ones. */
export const MAX_MAIN_RUNS = 10;
/** First-parent main squashes examined for the last proof-system change. */
export const SCAN_LIMIT = 200;
/** Run URLs read from one PR body's qualification section. */
export const MAX_QUALIFICATION_RUNS = 5;
export const QUALIFICATION_HEADING = "Off-main qualification";

export interface MainRun { id: number; status: string; conclusion: string | null }
/** One main squash the decision read. `position` counts squashes in merge
 * order from the proof-system squash, which is position 0. `settled` is false
 * while its run may still change: queued, in progress, or not created yet at
 * the newest squash. */
export interface WindowEntry { position: number; sha: string; run: MainRun | null; green: boolean; settled: boolean }
export interface LaneDecision {
  schemaVersion: 1;
  /** The main squash the history was read from. */
  main: string;
  /** The most recent proof-system squash within the scan, or null. */
  proofSystemSquash: string | null;
  scanned: number;
  /** `unknown`: every later run the bound allows is unsettled and older ones were not read. */
  state: "open" | "closed" | "unknown";
  open: boolean;
  /** Whether the proof-system squash's own run is green; null before it is read or with no squash. */
  ownGreen: boolean | null;
  /** Green main runs still required: 0 when open, 1 when closed, null when unknown. */
  required: number | null;
  /** The runs read, own run first, then later squashes newest first. */
  window: WindowEntry[];
  /** The newest settled run, at or after the proof-system squash, that decided the lane; null otherwise. */
  decisive: WindowEntry | null;
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

/** `later` holds the newest `MAX_MAIN_RUNS - 1` squashes after the
 * proof-system squash, in merge order; `omitted` counts the older ones
 * between it and them, which the decision does not read. */
export interface ProofSystemHistory { squash: string | null; later: string[]; omitted: number; scanned: number }

/** The most recent first-parent squash at or before `main` whose diff to its
 * parent is a proof-system change, and the newest squashes after it within the bound. */
export function lastProofSystemSquash(main: string, options: ClassifyOptions & { limit?: number } = {}): ProofSystemHistory {
  const cwd = options.cwd ?? process.cwd();
  const lines = git(cwd, ["rev-list", "--first-parent", "--parents", `--max-count=${options.limit ?? SCAN_LIMIT}`, main]).split("\n").filter(Boolean);
  const newestFirst: string[] = [];
  for (const line of lines) {
    const [sha, parent] = line.split(" ") as [string, string | undefined];
    newestFirst.push(sha);
    if (parent && classify(parent, sha, options).proofSystem) {
      const index = newestFirst.length - 1, kept = Math.min(index, MAX_MAIN_RUNS - 1);
      return { squash: sha, later: newestFirst.slice(0, kept).reverse(), omitted: index - kept, scanned: newestFirst.length };
    }
  }
  return { squash: null, later: [], omitted: 0, scanned: newestFirst.length };
}

/** The stability-window decision from the runs read so far (answer 2, as
 * amended on #2938, issuecomment-6580707195). Pure: `lane --json` and the
 * refusal both read it, and `readLane` reads the run it names in `next` until
 * it is null.
 *
 * The proof-system squash's own run must settle first. The lane is then open
 * when the newest settled run at or after that squash is green, and closed
 * when it is not: a failed, cancelled or timed-out run, or a squash that never
 * got a run because a later squash exists. So the own green run opens the lane
 * without waiting for later runs, and after any failure, the own run's
 * included, the next green main run reopens it. A queued or in-progress run,
 * or no run yet at the newest squash, has not settled and decides nothing. */
export function decideLane(main: string, history: ProofSystemHistory, runs: ReadonlyMap<string, MainRun | null>): LaneDecision {
  const base = { schemaVersion: 1 as const, main, proofSystemSquash: history.squash, scanned: history.scanned };
  if (!history.squash) return { ...base, state: "open", open: true, ownGreen: null, required: 0, window: [], decisive: null, next: null };
  const newest = history.later.length ? history.later.at(-1)! : history.squash;
  const entry = (sha: string, position: number): WindowEntry => {
    const run = runs.get(sha) ?? null;
    return { position, sha, run, green: isGreen(run), settled: run ? run.status === "completed" : sha !== newest };
  };
  const window: WindowEntry[] = [];
  const decided = (state: LaneDecision["state"], ownGreen: boolean | null, decisive: WindowEntry | null, next: string | null = null): LaneDecision =>
    ({ ...base, state, open: state === "open", ownGreen, required: state === "open" ? 0 : state === "closed" ? 1 : null, window, decisive, next });
  if (!runs.has(history.squash)) return decided("closed", null, null, history.squash);
  const own = entry(history.squash, 0);
  window.push(own);
  if (!own.settled) return decided("closed", false, null);
  for (let index = history.later.length - 1; index >= 0; index--) {
    const sha = history.later[index]!;
    if (!runs.has(sha)) return decided("closed", own.green, null, sha);
    const later = entry(sha, history.omitted + index + 1);
    window.push(later);
    if (later.settled) return decided(later.green ? "open" : "closed", own.green, later);
  }
  // Every later run read is unsettled: the own run decides, unless older squashes were not read.
  if (history.omitted > 0) return decided("unknown", own.green, null);
  return decided(own.green ? "open" : "closed", own.green, own);
}

/** Reads the decision: local first-parent history plus at most `MAX_MAIN_RUNS` run lookups. */
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
  const label = entry.position === 0 ? "own run" : `run ${entry.position} after it`;
  if (!entry.run) return `${label} at ${short(entry.sha)}: ${entry.settled ? "no main-push CI run" : "no main-push CI run yet"}`;
  return `${label} at ${short(entry.sha)}: run ${entry.run.id} ${entry.run.status === "completed" ? entry.run.conclusion ?? "no conclusion" : entry.run.status}`;
}

/** The stability-window refusal, or null when the lane is open. */
export function laneRefusal(decision: LaneDecision): string | null {
  if (decision.open) return null;
  const runs = decision.window.length ? decision.window.map(describe).join("; ") : "no main run read";
  const squash = `the last proof-system squash ${decision.proofSystemSquash}`;
  if (decision.state === "unknown") return `Proof-system lane unknown: no main run settled within the ${MAX_MAIN_RUNS} main runs this check reads after ${squash} (${runs}). Ask a maintainer to inspect main`;
  const required = "1 more green main run required";
  const rule = "a missing, queued, in-progress, cancelled or failed run is not green";
  if (!decision.decisive) return `Proof-system lane closed: ${squash} has no settled main run of its own yet (${runs}); ${required}. Its own run must complete first; ${rule}`;
  const which = decision.decisive.position === 0 ? "its own main run" : "the newest settled main run after it";
  return `Proof-system lane closed: ${which} is not green, so ${squash} waits for the next green main run (${runs}); ${required}. ` +
    `No rerun or revoke is needed; ${rule}`;
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

export interface QualificationRun { id: number; headSha: string | null; repository: string | null; status: string | null; conclusion: string | null }
export interface QualificationEvidence { run: number; headSha: string; via: "head" | "ancestor" }

/** Whether a completed, successful run's head SHA qualifies `head`: it is the head, or an ancestor
 * whose diff to the head is not a proof-system change. Returns why not. */
export function qualifies(run: QualificationRun, repository: string, head: string, options: ClassifyOptions = {}): "head" | "ancestor" | string {
  if (run.repository?.toLowerCase() !== repository.toLowerCase()) return `run ${run.id} is not a run in ${repository}`;
  if (run.status !== "completed" || run.conclusion !== "success") return `run ${run.id} is ${run.status ?? "unknown"} with conclusion ${run.conclusion ?? "none"}; only completed runs with conclusion success qualify`;
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
