/** The proof-system lane's merge gates (docs/decisions/ci-utility.md,
 * "Proof-system lane", answers 1–3): the two-green-main stability window
 * (#3269) and off-main qualification evidence on the PR (#3271).
 *
 * `integrate.ts confirm` and `merge` refuse a proof-system candidate with the
 * refusals built here, and `integrate.ts lane --json` reports the same
 * `LaneDecision`. Which diffs are proof-system changes is decided only by
 * `classify` from `scripts/proof-system.ts`; this file lists no globs.
 *
 * Every GitHub read goes through a caller-supplied lookup so the gate stays
 * bounded: at most `WINDOW` main-run reads and `MAX_QUALIFICATION_RUNS` run
 * reads per decision. */
import { classify, type ClassifyOptions } from "./proof-system";

/** The proof-system squash's own main run plus the next two (answer 2). */
export const WINDOW = 3;
/** First-parent main squashes examined for the last proof-system change. */
export const SCAN_LIMIT = 200;
/** Run URLs read from one PR body's qualification section. */
export const MAX_QUALIFICATION_RUNS = 5;
export const QUALIFICATION_HEADING = "Off-main qualification";

export interface MainRun { id: number; status: string; conclusion: string | null }
export interface WindowEntry { position: number; sha: string | null; run: MainRun | null; green: boolean }
export interface LaneDecision {
  schemaVersion: 1;
  /** The main squash the history was read from. */
  main: string;
  /** The most recent proof-system squash within the scan, or null. */
  proofSystemSquash: string | null;
  scanned: number;
  window: WindowEntry[];
  /** Window positions without a completed, successful main-push run. */
  missing: number;
  open: boolean;
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

export interface ProofSystemHistory { squash: string | null; later: string[]; scanned: number }

/** The most recent first-parent squash at or before `main` whose diff to its
 * parent is a proof-system change, and up to `WINDOW - 1` squashes after it in
 * merge order. */
export function lastProofSystemSquash(main: string, options: ClassifyOptions & { limit?: number } = {}): ProofSystemHistory {
  const cwd = options.cwd ?? process.cwd();
  const lines = git(cwd, ["rev-list", "--first-parent", "--parents", `--max-count=${options.limit ?? SCAN_LIMIT}`, main]).split("\n").filter(Boolean);
  const newestFirst: string[] = [];
  for (const line of lines) {
    const [sha, parent] = line.split(" ") as [string, string | undefined];
    newestFirst.push(sha);
    if (parent && classify(parent, sha, options).proofSystem) {
      const index = newestFirst.length - 1;
      return { squash: sha, later: newestFirst.slice(Math.max(0, index - (WINDOW - 1)), index).reverse(), scanned: newestFirst.length };
    }
  }
  return { squash: null, later: [], scanned: newestFirst.length };
}

/** The stability-window decision for a history and the main-push runs found
 * at its squashes. Pure: `lane --json` and the refusal both read it. */
export function decideLane(main: string, history: ProofSystemHistory, runs: ReadonlyMap<string, MainRun | null>): LaneDecision {
  if (!history.squash) return { schemaVersion: 1, main, proofSystemSquash: null, scanned: history.scanned, window: [], missing: 0, open: true };
  const shas = [history.squash, ...history.later];
  const window = Array.from({ length: WINDOW }, (_, position): WindowEntry => {
    const sha = shas[position] ?? null, run = sha ? runs.get(sha) ?? null : null;
    return { position, sha, run, green: isGreen(run) };
  });
  const missing = window.filter(entry => !entry.green).length;
  return { schemaVersion: 1, main, proofSystemSquash: history.squash, scanned: history.scanned, window, missing, open: missing === 0 };
}

/** Reads the decision: local first-parent history plus at most `WINDOW` run lookups. */
export async function readLane(main: string, runAt: (sha: string) => Promise<MainRun | null>, options: ClassifyOptions = {}): Promise<LaneDecision> {
  const cwd = options.cwd ?? process.cwd();
  const resolved = git(cwd, ["rev-parse", "--verify", "--end-of-options", `${main}^{commit}`]);
  const history = lastProofSystemSquash(resolved, options);
  const runs = new Map<string, MainRun | null>();
  for (const sha of history.squash ? [history.squash, ...history.later] : []) runs.set(sha, await runAt(sha));
  return decideLane(resolved, history, runs);
}

const short = (sha: string) => sha.slice(0, 12);
function describe(entry: WindowEntry): string {
  const label = entry.position === 0 ? "own run" : `next run ${entry.position}`;
  if (!entry.sha) return `${label}: no main squash yet`;
  if (!entry.run) return `${label} at ${short(entry.sha)}: no main-push CI run`;
  return `${label} at ${short(entry.sha)}: run ${entry.run.id} ${entry.run.status === "completed" ? entry.run.conclusion ?? "no conclusion" : entry.run.status}`;
}

/** The stability-window refusal, or null when the lane is open. */
export function laneRefusal(decision: LaneDecision): string | null {
  if (decision.open) return null;
  return `Proof-system lane closed: the last proof-system squash ${decision.proofSystemSquash} needs its own main run and the next ${WINDOW - 1} main runs green (${decision.window.map(describe).join("; ")}); ` +
    `${decision.missing} more green main run${decision.missing === 1 ? "" : "s"} required. A failed or cancelled window run counts only once a rerun at the same squash succeeds`;
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
