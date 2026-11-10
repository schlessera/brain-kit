/**
 * Batches and the gate a batch passes before it lands.
 *
 * A batch is one branch of audited changes inside one package. Runs append a
 * commit per cluster; the batch lands as one pull request once it is ripe.
 *
 * `verifyBatch` is the review. These changes land without a human reading
 * them, so everything a reviewer would refuse on sight is refused here,
 * mechanically: a change outside test code, a proof-system change, a commit
 * with no recorded audit behind it, a new skip, retry or longer budget, and
 * any test that disappears without a finding that names it (accounting.ts).
 */
import { declaredFor, reportsCases, staticAccounting } from "./accounting";
import type { Profile } from "./config";
import type { BatchState, ClusterRecord, LedgerState } from "./ledger";
import { countSignals, scanSource } from "./signals";

export const TRAILER = "Test-Health";
/** The commit trailer that ties a commit to its recorded audit. */
export const trailerFor = (runId: string, cluster: number): string => `${TRAILER}: ${runId}#${cluster}`;

export const batchIdFor = (packageName: string, runId: string): string => `${packageName}-${runId}`;
export const branchFor = (batchId: string): string => `test-health/${batchId}`;

/** The open batch a run should continue: same base, oldest first, so batches finish. */
export function openBatch(state: LedgerState, base: string, packageName?: string): BatchState | undefined {
  return [...state.batches.values()]
    .filter(batch => batch.status === "open" && batch.base === base && (!packageName || batch.package === packageName))
    .sort((a, b) => a.openedAt < b.openedAt ? -1 : a.openedAt > b.openedAt ? 1 : 0)[0];
}

/** Files a batch changed, from the audits recorded against it. */
export function changedFilesOf(batch: BatchState, state: LedgerState): string[] {
  const keys = new Set(batch.clusters.map(cluster => `${cluster.runId}\n${cluster.cluster}`));
  const changed = new Set<string>();
  for (const record of state.clusters) {
    if (!keys.has(`${record.runId}\n${record.cluster}`)) continue;
    for (const audit of record.audits) if (audit.blobAfter !== audit.blobBefore) changed.add(audit.file);
  }
  return [...changed].sort();
}

export const parkedChangedFiles = (state: LedgerState): number =>
  [...state.batches.values()].filter(batch => batch.status === "open").reduce((sum, batch) => sum + changedFilesOf(batch, state).length, 0);

export interface Ripeness { ripe: boolean; reasons: string[]; changedFiles: number; ageHours: number; full: boolean }

/** `exhausted` means the package has nothing left to audit for this batch. */
export function ripeness(batch: BatchState, state: LedgerState, profile: Profile, now: Date, exhausted: boolean): Ripeness {
  const changedFiles = changedFilesOf(batch, state).length;
  const ageHours = Math.round(((now.getTime() - Date.parse(batch.openedAt)) / 3_600_000) * 10) / 10;
  const reasons: string[] = [];
  const { ripe } = profile;
  if (changedFiles > 0) {
    if (ripe.changedFiles !== null && changedFiles >= ripe.changedFiles) reasons.push(`${changedFiles} changed files (threshold ${ripe.changedFiles})`);
    if (ripe.ageHours !== null && ageHours >= ripe.ageHours) reasons.push(`${ageHours} h old (threshold ${ripe.ageHours})`);
    if (ripe.whenExhausted && exhausted) reasons.push("nothing left to audit in its package");
  }
  return { ripe: reasons.length > 0, reasons, changedFiles, ageHours, full: ripe.maxChangedFiles !== null && changedFiles >= ripe.maxChangedFiles };
}

/** How many test-health candidates may enter the landing lane now. */
export function landingSlots(state: LedgerState, profile: Profile, now: Date): { open: boolean; reason: string | null } {
  const { maxPerDay } = profile.landing;
  if (maxPerDay !== null) {
    const since = now.getTime() - 86_400_000;
    const landed = [...state.batches.values()].filter(batch => batch.status === "landed" && batch.closedAt && Date.parse(batch.closedAt) >= since).length;
    if (landed >= maxPerDay) return { open: false, reason: `${landed} batches landed in the last 24 h (cap ${maxPerDay})` };
  }
  const { maxOpenCandidates } = profile.landing;
  if (maxOpenCandidates !== null) {
    const inLane = [...state.batches.values()].filter(batch => batch.status === "open" && batch.pr !== null).length;
    if (inLane >= maxOpenCandidates) return { open: false, reason: `${inLane} batch pull request(s) already open (cap ${maxOpenCandidates})` };
  }
  return { open: true, reason: null };
}

const TEST_FILE = /(?:(?:\.test|\.spec|_test|_spec)\.(?:[cm]?[jt]s|[jt]sx)|\.(?:layout|offline|endurance|visual|pointer|stories)\.tsx)$/;
const TEST_SUPPORT = /^(?:packages\/[^/]+\/(?:tests|test|stories)\/|tests\/|experiments\/)/;
/** The authoring guide and the skill's own references may move with a batch (the guidance ratchet). */
const GUIDANCE = /^(?:docs\/process\/test-authoring\.md|\.agents\/skills\/test-health\/references\/[^/]+\.md)$/;
/** Smells whose count may never rise in a batch: they hide a test instead of fixing it. */
const GUARDED = ["skipped", "conditional-skip", "retry", "only", "long-timeout"] as const;

export interface VerifyInput {
  root: string;
  base: string;
  head: string;
  clusters: readonly ClusterRecord[];
  /** Clusters dropped from the batch. Their commits and reverts may stay, but their files must be back at the base. */
  voided?: readonly ClusterRecord[];
  /** Check the diff as a whole and skip the per-commit audit trail: for a branch that squash-merged already-gated batches. */
  netOnly?: boolean;
  /** Injectable for tests; defaults to the repository's proof-system classifier. */
  classify?: (base: string, head: string, cwd: string) => { proofSystem: boolean; reasons: unknown[] };
}
export interface VerifyResult {
  ok: boolean;
  violations: string[];
  stats: { commits: number; files: number; testsBefore: number; testsAfter: number; assertionsBefore: number; assertionsAfter: number;
    /** Test declarations present at the base and absent at the head, and how many of them a finding declared. */
    testsRemoved: number; declaredRemoved: number };
}

function git(root: string, args: string[]): string;
function git(root: string, args: string[], allowFailure: true): string | null;
function git(root: string, args: string[], allowFailure = false): string | null {
  const result = Bun.spawnSync(["git", ...args], { cwd: root, stdout: "pipe", stderr: "pipe" });
  if (result.exitCode !== 0) {
    if (allowFailure) return null;
    throw new Error(`git ${args[0]}: ${result.stderr.toString().trim()}`);
  }
  return result.stdout.toString();
}

export async function verifyBatch(input: VerifyInput): Promise<VerifyResult> {
  const { root, base, head } = input;
  const violations: string[] = [];
  const mergeBase = git(root, ["merge-base", base, head]).trim();
  const changed = git(root, ["diff", "--name-only", "--no-renames", "-z", mergeBase, head, "--"]).split("\0").filter(Boolean).sort();
  for (const path of changed) {
    if (!TEST_FILE.test(path) && !TEST_SUPPORT.test(path) && !GUIDANCE.test(path)) violations.push(`${path}: outside test code; a product or tooling change is filed, not made here`);
  }

  const proofSystem = input.classify ? null : await import("../proof-system");
  const classification = input.classify ? input.classify(mergeBase, head, root) : proofSystem!.classify(mergeBase, head, { cwd: root });
  if (classification.proofSystem) violations.push(`the diff is a proof-system change (${JSON.stringify(classification.reasons).slice(0, 300)}); file it instead`);

  const records = new Map(input.clusters.map(record => [`${record.runId}#${record.cluster}`, record]));
  const findings = input.clusters.flatMap(record => record.worksheet.findings);
  const compared = new Set(input.clusters.flatMap(record => (record.accounting ?? []).filter(entry => entry.runtime !== null).map(entry => entry.file)));
  const existedAtBase = (path: string) => git(root, ["cat-file", "-e", `${mergeBase}:${path}`], true) !== null;
  const dropped = new Map((input.voided ?? []).map(record => [`${record.runId}#${record.cluster}`, record]));
  for (const [key, record] of dropped) {
    const left = record.worksheet.members.filter(file => changed.includes(file));
    if (left.length) violations.push(`${key} was dropped, but ${left.join(", ")} still differ${left.length === 1 ? "s" : ""} from the base`);
  }
  const commits = git(root, ["rev-list", "--no-merges", `${mergeBase}..${head}`]).split("\n").filter(Boolean);
  for (const commit of input.netOnly ? [] : commits) {
    const short = commit.slice(0, 10);
    const message = git(root, ["show", "-s", "--format=%B", commit]);
    const trailer = new RegExp(`^${TRAILER}: (\\S+)$`, "m").exec(message)?.[1];
    const record = trailer ? records.get(trailer) : undefined;
    if (!trailer) { violations.push(`commit ${short}: no ${TRAILER} trailer, so no audit stands behind it`); continue; }
    // A dropped cluster's commit and its revert cancel out; the check above holds them to that.
    if (dropped.has(trailer)) continue;
    if (!record) { violations.push(`commit ${short}: ${trailer} is not a recorded cluster`); continue; }
    const touched = git(root, ["show", "--name-only", "--no-renames", "--format=", "-z", commit]).split("\0").filter(Boolean);
    for (const path of touched) {
      // A new test file has nothing to lose and no audit to belong to: adding the cheap owner of a case is how a tier move starts.
      if (TEST_FILE.test(path) && existedAtBase(path) && !record.worksheet.members.includes(path)) violations.push(`commit ${short}: ${path} is not a member of ${trailer}`);
    }
  }

  const stats: VerifyResult["stats"] = { commits: commits.length, files: 0, testsBefore: 0, testsAfter: 0, assertionsBefore: 0, assertionsAfter: 0, testsRemoved: 0, declaredRemoved: 0 };
  for (const path of changed.filter(file => TEST_FILE.test(file))) {
    stats.files++;
    const before = scanSource(path, git(root, ["show", `${mergeBase}:${path}`], true) ?? "");
    const after = scanSource(path, git(root, ["show", `${head}:${path}`], true) ?? "");
    stats.testsBefore += before.tests; stats.testsAfter += after.tests;
    stats.assertionsBefore += before.matchers; stats.assertionsAfter += after.matchers;
    const [was, now] = [countSignals(before.signals), countSignals(after.signals)];
    for (const smell of GUARDED) {
      if ((now[smell] ?? 0) > (was[smell] ?? 0)) violations.push(`${path}: adds ${smell} (${was[smell] ?? 0} before, ${now[smell] ?? 0} after)`);
    }
    // Every title that is gone must be named by a fixed finding; one declaration covers one disappearance.
    const declared = declaredFor(path, findings);
    const accounting = staticAccounting(before.titles, after.titles, declared);
    stats.testsRemoved += accounting.gone.length;
    stats.declaredRemoved += declared.removes.length;
    for (const problem of accounting.problems) violations.push(`${path}: ${problem}`);
    if (reportsCases(path) && existedAtBase(path) && !compared.has(path)) {
      violations.push(`${path}: no comparison of executed cases before and after was recorded for this change`);
    }
  }
  return { ok: violations.length === 0, violations, stats };
}
