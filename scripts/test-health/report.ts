/**
 * Metrics from the ledger: how much of the suite has been audited, what the
 * audits found and fixed, and whether the fixes are landing and sticking.
 *
 * Everything here is computed, so two agents on different models produce the
 * same numbers from the same ledger. The agent's only input is the worksheet's
 * enumerated fields.
 */
import { LENS_IDS } from "./catalog";
import type { Inventory } from "./inventory";
import { landedOrPending, type LedgerState, type Snapshot } from "./ledger";
import { changedFilesOf } from "./batch";
import type { FileSignals } from "./signals";
import { countSignals } from "./signals";
import { fileState, type IssueRef } from "./select";
import { median } from "./measure";

export interface Metrics {
  schemaVersion: 1;
  generatedAt: string;
  sha: string;
  coverage: { files: number; auditedCurrent: number; stale: number; never: number; share: number; medianAuditAgeDays: number | null };
  runs: { total: number; byOutcome: Record<string, number>; byAgent: Record<string, number>; byProfile: Record<string, number> };
  audits: { clusters: number; files: number; filesChanged: number };
  findings: { total: number; perAuditedFile: number; byLens: Record<string, number>; bySmell: Record<string, number>; byAction: Record<string, number>; byStatus: Record<string, number> };
  proof: { mutationsKilled: number; testsThatCouldNotFail: number; deflaked: number; secondsSavedPerRun: number; testsRemoved: number };
  /** Tests and executed cases in the files the audits changed, before and after. Every removal in it was declared. */
  accounting: { testsBefore: number; testsAfter: number; declaredRemoved: number; casesBefore: number; casesAfter: number; assertionsBefore: number; assertionsAfter: number };
  batches: { open: number; landed: number; abandoned: number; parkedChangedFiles: number; droppedCommits: number; landingAttempts: number; meanFilesPerLanded: number | null; meanHoursToLand: number | null };
  /** Later audits of a file that found something in a lens an earlier audit called clean. */
  refind: { reaudits: number; refound: number; rate: number | null };
  trend: Array<Snapshot & { at: string }>;
}

const bump = (counts: Record<string, number>, key: string, by = 1) => { counts[key] = (counts[key] ?? 0) + by; };
const round = (value: number, digits = 3) => Math.round(value * 10 ** digits) / 10 ** digits;
const mean = (values: readonly number[]): number | null => values.length ? round(values.reduce((sum, value) => sum + value, 0) / values.length, 1) : null;

/** The suite's measurable state at one commit; recorded with each run so trends need no archaeology. */
export function buildSnapshot(inventory: Inventory, signals: ReadonlyMap<string, FileSignals>, issues: ReadonlyMap<string, readonly IssueRef[]>): Snapshot {
  const costs = inventory.rows.map(row => row.costSeconds ?? 0).sort((a, b) => b - a);
  const total = costs.reduce((sum, value) => sum + value, 0);
  const counts: Record<string, number> = {};
  for (const entry of signals.values()) for (const [smell, count] of Object.entries(countSignals(entry.signals))) bump(counts, smell, count);
  const open = new Map<number, IssueRef>();
  for (const refs of issues.values()) for (const ref of refs) open.set(ref.number, ref);
  return { sha: inventory.sha, files: inventory.rows.length,
    scenarios: inventory.rows.reduce((sum, row) => sum + row.scenarios, 0), assertions: inventory.rows.reduce((sum, row) => sum + row.assertions, 0),
    costSeconds: round(total, 1), top50CostShare: total ? round(costs.slice(0, 50).reduce((sum, value) => sum + value, 0) / total) : 0,
    signals: Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a < b ? -1 : 1)),
    openIssues: open.size, openIssuesNeedingRepro: [...open.values()].filter(ref => ref.needsRepro).length };
}

export function buildMetrics(state: LedgerState, inventory: Inventory, now: Date, reauditDays: number): Metrics {
  const audits = landedOrPending(state);
  const coverage = { files: inventory.rows.length, auditedCurrent: 0, stale: 0, never: 0, share: 0, medianAuditAgeDays: null as number | null };
  const ages: number[] = [];
  for (const row of inventory.rows) {
    const audit = audits.get(row.file);
    const status = fileState(row, audit, now, reauditDays);
    if (status === "fresh") { coverage.auditedCurrent++; ages.push((now.getTime() - Date.parse(audit!.at)) / 86_400_000); }
    else coverage[status]++;
  }
  coverage.share = coverage.files ? round(coverage.auditedCurrent / coverage.files) : 0;
  const age = median(ages);
  coverage.medianAuditAgeDays = age === null ? null : round(age, 1);

  const runs: Metrics["runs"] = { total: state.runs.length, byOutcome: {}, byAgent: {}, byProfile: {} };
  for (const run of state.runs) { bump(runs.byOutcome, run.outcome); bump(runs.byAgent, run.agent); bump(runs.byProfile, run.profile); }

  const findings: Metrics["findings"] = { total: 0, perAuditedFile: 0, byLens: {}, bySmell: {}, byAction: {}, byStatus: {} };
  const proof: Metrics["proof"] = { mutationsKilled: 0, testsThatCouldNotFail: 0, deflaked: 0, secondsSavedPerRun: 0, testsRemoved: 0 };
  const refind = { reaudits: 0, refound: 0, rate: null as number | null };
  const accounting: Metrics["accounting"] = { testsBefore: 0, testsAfter: 0, declaredRemoved: 0, casesBefore: 0, casesAfter: 0, assertionsBefore: 0, assertionsAfter: 0 };
  const previous = new Map<string, Record<string, string>>();
  let auditedFiles = 0, filesChanged = 0;
  for (const record of state.clusters) {
    for (const audit of record.audits) {
      auditedFiles++;
      if (audit.blobAfter !== audit.blobBefore) filesChanged++;
      const before = previous.get(audit.file);
      if (before) {
        refind.reaudits++;
        if (LENS_IDS.some(lens => before[lens] === "clean" && audit.lenses[lens] === "findings")) refind.refound++;
      }
      previous.set(audit.file, audit.lenses);
    }
    for (const entry of record.accounting ?? []) {
      accounting.testsBefore += entry.testsBefore; accounting.testsAfter += entry.testsAfter; accounting.declaredRemoved += entry.declaredRemoved;
      accounting.casesBefore += entry.runtime?.casesBefore ?? 0; accounting.casesAfter += entry.runtime?.casesAfter ?? 0;
      accounting.assertionsBefore += entry.runtime?.assertionsBefore ?? 0; accounting.assertionsAfter += entry.runtime?.assertionsAfter ?? 0;
    }
    for (const finding of record.worksheet.findings) {
      findings.total++;
      bump(findings.byLens, finding.lens); bump(findings.bySmell, finding.smell);
      bump(findings.byAction, finding.action); bump(findings.byStatus, finding.status);
      if (finding.status !== "fixed") continue;
      if (finding.evidence?.mutation?.verdict === "killed") proof.mutationsKilled++;
      if (finding.lens === "cannot-fail") proof.testsThatCouldNotFail++;
      if (finding.action === "deflake") proof.deflaked++;
      if (finding.action === "remove") proof.testsRemoved++;
      const { before: was, after: is } = finding.evidence ?? {};
      if (finding.action === "speed-up" && was?.medianMs != null && is?.medianMs != null) proof.secondsSavedPerRun += (was.medianMs - is.medianMs) / 1000;
    }
  }
  findings.perAuditedFile = auditedFiles ? round(findings.total / auditedFiles, 2) : 0;
  proof.secondsSavedPerRun = round(proof.secondsSavedPerRun, 1);
  refind.rate = refind.reaudits ? round(refind.refound / refind.reaudits) : null;

  const all = [...state.batches.values()];
  const landed = all.filter(batch => batch.status === "landed");
  const batches: Metrics["batches"] = {
    open: all.filter(batch => batch.status === "open").length, landed: landed.length, abandoned: all.filter(batch => batch.status === "abandoned").length,
    parkedChangedFiles: all.filter(batch => batch.status === "open").reduce((sum, batch) => sum + changedFilesOf(batch, state).length, 0),
    droppedCommits: all.reduce((sum, batch) => sum + batch.dropped.length, 0), landingAttempts: all.reduce((sum, batch) => sum + batch.attempts, 0),
    meanFilesPerLanded: mean(landed.map(batch => changedFilesOf(batch, state).length)),
    meanHoursToLand: mean(landed.filter(batch => batch.closedAt).map(batch => (Date.parse(batch.closedAt!) - Date.parse(batch.openedAt)) / 3_600_000)),
  };
  const trend = state.runs.filter(run => run.snapshot).map(run => ({ ...run.snapshot!, at: run.at })).slice(-60);
  return { schemaVersion: 1, generatedAt: now.toISOString(), sha: inventory.sha, coverage, runs,
    audits: { clusters: state.clusters.length, files: auditedFiles, filesChanged }, findings, proof, accounting, batches, refind, trend };
}

const table = (rows: Array<[string, string | number]>): string => ["| Measure | Value |", "| --- | --- |", ...rows.map(([name, value]) => `| ${name} | ${value} |`)].join("\n");
const breakdown = (counts: Record<string, number>): string => Object.entries(counts).sort(([, a], [, b]) => b - a).map(([key, value]) => `${key} ${value}`).join(", ") || "none";

export function renderReport(metrics: Metrics): string {
  const first = metrics.trend[0], last = metrics.trend[metrics.trend.length - 1];
  const delta = (pick: (snapshot: Snapshot) => number): string => first && last && first !== last ? `${pick(first)} to ${pick(last)}` : last ? String(pick(last)) : "no snapshot yet";
  return [
    "# Test health",
    "",
    `Generated ${metrics.generatedAt} at \`${metrics.sha.slice(0, 12)}\`.`,
    "",
    "## Coverage of the rotation",
    "",
    table([
      ["Test files", metrics.coverage.files],
      ["Audited at their current content", `${metrics.coverage.auditedCurrent} (${(metrics.coverage.share * 100).toFixed(1)}%)`],
      ["Changed since their audit", metrics.coverage.stale],
      ["Never audited", metrics.coverage.never],
      ["Median audit age in days", metrics.coverage.medianAuditAgeDays ?? "n/a"],
    ]),
    "",
    "## What the audits found",
    "",
    table([
      ["Runs", `${metrics.runs.total} (${breakdown(metrics.runs.byOutcome)})`],
      ["Runs by agent", breakdown(metrics.runs.byAgent)],
      ["Files audited", metrics.audits.files],
      ["Files changed", metrics.audits.filesChanged],
      ["Findings", `${metrics.findings.total} (${metrics.findings.perAuditedFile} per audited file)`],
      ["By lens", breakdown(metrics.findings.byLens)],
      ["By action", breakdown(metrics.findings.byAction)],
      ["By status", breakdown(metrics.findings.byStatus)],
    ]),
    "",
    "## Proof and efficacy",
    "",
    table([
      ["Tests fixed that could not fail", metrics.proof.testsThatCouldNotFail],
      ["Mutations killed", metrics.proof.mutationsKilled],
      ["Tests made deterministic", metrics.proof.deflaked],
      ["Seconds saved per run of the changed files", metrics.proof.secondsSavedPerRun],
      ["Test declarations in changed files", `${metrics.accounting.testsBefore} before, ${metrics.accounting.testsAfter} after (${metrics.accounting.declaredRemoved} removed, each declared with its obligation map)`],
      ["Executed cases in changed files", `${metrics.accounting.casesBefore} before, ${metrics.accounting.casesAfter} after`],
      ["Executed assertions in changed files", `${metrics.accounting.assertionsBefore} before, ${metrics.accounting.assertionsAfter} after`],
      ["Re-audits that found what an earlier audit missed", metrics.refind.rate === null ? "n/a" : `${metrics.refind.refound} of ${metrics.refind.reaudits}`],
    ]),
    "",
    "## Landing",
    "",
    table([
      ["Batches landed", metrics.batches.landed],
      ["Batches open", `${metrics.batches.open} (${metrics.batches.parkedChangedFiles} changed files waiting)`],
      ["Batches abandoned", metrics.batches.abandoned],
      ["Commits dropped from a batch", metrics.batches.droppedCommits],
      ["Landing attempts", metrics.batches.landingAttempts],
      ["Mean changed files per landed batch", metrics.batches.meanFilesPerLanded ?? "n/a"],
      ["Mean hours from first commit to landing", metrics.batches.meanHoursToLand ?? "n/a"],
    ]),
    "",
    "## Suite trend",
    "",
    table([
      ["Measured cost of one full pass, in seconds", delta(snapshot => snapshot.costSeconds)],
      ["Share of that cost in the 50 slowest files", delta(snapshot => snapshot.top50CostShare)],
      ["Open failure issues", delta(snapshot => snapshot.openIssues)],
      ["Sleep-shaped call sites", delta(snapshot => snapshot.signals["settling-sleep"] ?? 0)],
      ["Weak matchers", delta(snapshot => snapshot.signals["weak-matcher"] ?? 0)],
      ["Conditionally skipped tests", delta(snapshot => snapshot.signals["conditional-skip"] ?? 0)],
    ]),
    "",
    "Signal counts are scanner leads, not defects. Timings saved are local medians of the changed files, not a hosted benchmark.",
    "",
  ].join("\n");
}
