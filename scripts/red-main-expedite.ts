/**
 * Expedited red-main fix proof (#2940, ruling 7 of #2938). A declared fix (a
 * forward fix or a targeted revert) merges ahead of complete candidate proof
 * when the open record's failing test files are shown red on the bad base and
 * green on the fix head, and the exact-head affected fast invariants pass. The
 * next main run, which includes the red set, is the complete backstop.
 */
import type { RedMainRecord } from "./red-main";

export const PROBE_RECEIPT = "BRAIN_RED_MAIN_PROBE";
export const fixProbeTitle = (source: number, sha: string) => `red-main probe fix ${source} ${sha}`;

export interface ProbeReceipt { purpose: string; sha: string; tests: string[]; absent: string[]; exitCode: number; }
export interface ProbeEvidence { run: number; status: string; conclusion: string | null; receipt: ProbeReceipt | null; }
export interface FeedbackEvidence { run: number; cadence: string | null; changeset: string | null; verify: string | null; }

/** The single structured line a probe prints after running its files. */
export function probeReceipt(log: string): ProbeReceipt | null {
  const lines = log.split("\n").filter(line => line.includes(`${PROBE_RECEIPT} `));
  if (lines.length !== 1) return null;
  try {
    const r = JSON.parse(lines[0]!.slice(lines[0]!.indexOf(`${PROBE_RECEIPT} `) + PROBE_RECEIPT.length + 1).trim()) as ProbeReceipt;
    if (!r || typeof r.purpose !== "string" || !/^[a-f0-9]{40}$/.test(r.sha ?? "") || !Array.isArray(r.tests) || !Array.isArray(r.absent) ||
        ![...r.tests, ...r.absent].every(test => typeof test === "string") || !Number.isSafeInteger(r.exitCode)) return null;
    return r;
  } catch { return null; }
}

/**
 * The failing test files an expedited fix must show red and green. Refuses a run
 * that is not the open record's, and category-level failures with no test file.
 */
export function expeditedTests(record: RedMainRecord, run: number): string[] {
  const open = record.open;
  if (!open) throw new Error("Main is not red: --fixes-main-run needs an open red-main record");
  if (open.run !== run) throw new Error(`--fixes-main-run ${run} does not match the open red-main record's run ${open.run}`);
  const categories = open.failures.filter(failure => failure.test === null).map(failure => failure.category);
  if (categories.length) throw new Error(`Category-level red failures (${[...new Set(categories)].join(", ")}) have no failing test file to show red and green; an expedited fix cannot prove them. Use ordinary confirmation as a declared fix`);
  return [...new Set(open.failures.map(failure => failure.test!))].sort();
}

const same = (a: string[], b: string[]) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());

/**
 * Problems with the expedited evidence; empty means it satisfies the ruling.
 * `deleted` lists files the fix head deletes relative to the base: only those may
 * be absent at the head, which is how a targeted revert removes a failing test.
 */
export function expeditedProblems(input: { tests: string[]; base: string; head: string; deleted: string[];
  baseProbe: ProbeEvidence | null; headProbe: ProbeEvidence | null; feedback: FeedbackEvidence | null }): string[] {
  const problems: string[] = [];
  const { tests, base, head, baseProbe, headProbe, feedback } = input;
  const label = tests.join(", ");
  if (!baseProbe || baseProbe.status !== "completed") problems.push(`no completed fix probe at the bad base ${base}`);
  else {
    const r = baseProbe.receipt;
    if (!r || r.purpose !== "fix" || r.sha !== base) problems.push(`fix probe ${baseProbe.run} has no receipt for the bad base ${base}`);
    else if (r.absent.length || !same(r.tests, tests)) problems.push(`fix probe ${baseProbe.run} did not run every failing test file at the bad base (${label})`);
    else if (r.exitCode === 0 || baseProbe.conclusion !== "failure") problems.push(`the failing tests were not shown red on the bad base ${base} (probe ${baseProbe.run})`);
  }
  if (!headProbe || headProbe.status !== "completed") problems.push(`no completed fix probe at the fix head ${head}`);
  else {
    const r = headProbe.receipt;
    if (!r || r.purpose !== "fix" || r.sha !== head) problems.push(`fix probe ${headProbe.run} has no receipt for the fix head ${head}`);
    else if (!same([...r.tests, ...r.absent], tests)) problems.push(`fix probe ${headProbe.run} did not cover every failing test file at the fix head (${label})`);
    else if (r.absent.some(test => !input.deleted.includes(test))) problems.push(`failing test files absent at the fix head without the fix deleting them: ${r.absent.filter(test => !input.deleted.includes(test)).join(", ")}`);
    else if (r.exitCode !== 0 || headProbe.conclusion !== "success") problems.push(`the failing tests were not shown green on the fix head ${head} (probe ${headProbe.run})`);
  }
  if (!feedback) problems.push(`no hosted CI run at the fix head ${head} for its affected fast invariants`);
  else if (!["feedback", "confirmation"].includes(feedback.cadence ?? "")) problems.push(`CI run ${feedback.run} at the fix head is a ${feedback.cadence ?? "unknown"} run, which selects no fast invariants`);
  else if (feedback.changeset !== "success" || !["success", "skipped"].includes(feedback.verify ?? "")) problems.push(`affected fast invariants did not pass at the fix head (CI run ${feedback.run}: changeset ${feedback.changeset ?? "pending"}, verify ${feedback.verify ?? "pending"})`);
  return problems;
}
