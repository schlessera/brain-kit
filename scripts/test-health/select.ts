/**
 * Chooses what one run audits.
 *
 * Coverage comes from repetition, so the choice must vary between runs, reach
 * every file eventually and be the same for every agent that asks. Two queues
 * do that. The hot queue takes the worst first: cost, open failure issues and
 * static smell density. The sweep queue takes the oldest audit first, so the
 * long tail is reached whatever the hot signals say. Runs alternate between
 * them (`sweepEvery`). A file edited since its audit is stale again, a new
 * file has never been audited and a deleted file is simply gone, which is how
 * a moving set of tests is handled without bookkeeping.
 *
 * A run stays inside one package. Hosted proof for a test edit is priced by
 * the workspaces it touches, not by the number of files, so a batch that
 * widens to a second package buys a second closure.
 */
import type { Profile } from "./config";
import { TIER_LEVEL, type Inventory, type Row } from "./inventory";
import type { FileAuditState } from "./ledger";
import { neighboursOf, type Affinity, type Neighbour } from "./neighbours";

export type FileState = "never" | "stale" | "fresh";
export type Mode = "hot" | "sweep";

export interface IssueRef { number: number; title: string; needsRepro: boolean; assigned: boolean }

export interface Candidate { row: Row; state: FileState; auditedAt: string | null; hot: number; issues: number; signalWeight: number }

export interface Cluster {
  index: number;
  seed: string;
  /** Auditable and changeable: the seed and its neighbours in the same package. */
  members: string[];
  /** Read-only: neighbours in other packages or already audited, kept for the overlap lens. */
  context: string[];
  neighbours: Neighbour[];
}

export interface Plan {
  runId: string;
  profile: string;
  mode: Mode;
  package: string | null;
  clusters: Cluster[];
  /** Set when the run should record itself and stop without auditing. */
  throttled: string | null;
  stats: {
    files: number; never: number; stale: number; fresh: number; claimed: number; inOpenPrs: number;
    skippedTiers: Record<string, number>; eligibleInPackage: number; selected: number;
  };
}

export interface PlanInput {
  runId: string;
  inventory: Inventory;
  profile: Profile;
  now: Date;
  audits: ReadonlyMap<string, FileAuditState>;
  /** Files claimed by another live run. */
  claims: ReadonlyMap<string, string>;
  signalWeights: ReadonlyMap<string, number>;
  issues: ReadonlyMap<string, readonly IssueRef[]>;
  /** Files an open pull request already touches. */
  openPrFiles: ReadonlySet<string>;
  affinity: Affinity;
  /** Completed runs so far; decides which queue this run takes. */
  runCount: number;
  mode?: Mode;
  package?: string;
  /** The package of the batch this run should continue, when one is open. */
  preferPackage?: string;
  /** Restricts the run to these files (a shard of the push wrapper). */
  only?: ReadonlySet<string>;
  /** Changed files waiting in open batches; the cron profile stops adding beyond its cap. */
  parkedChangedFiles?: number;
}

export function fileState(row: Row, audit: FileAuditState | undefined, now: Date, reauditDays: number): FileState {
  if (!audit) return "never";
  const sameContent = row.blob === audit.blobBefore || row.blob === audit.blobAfter;
  const ageDays = (now.getTime() - Date.parse(audit.at)) / 86_400_000;
  return sameContent && ageDays < reauditDays ? "fresh" : "stale";
}

export const modeFor = (runCount: number, sweepEvery: number): Mode => (runCount + 1) % sweepEvery === 0 ? "sweep" : "hot";

const byFile = (a: { row: Row }, b: { row: Row }): number => a.row.file < b.row.file ? -1 : a.row.file > b.row.file ? 1 : 0;

export function rank(input: Pick<PlanInput, "inventory" | "profile" | "now" | "audits" | "signalWeights" | "issues">): Candidate[] {
  const { weights } = input.profile;
  const maxCost = Math.max(1, ...input.inventory.rows.map(row => row.costSeconds ?? 0));
  return input.inventory.rows.map(row => {
    const audit = input.audits.get(row.file);
    const state = fileState(row, audit, input.now, input.profile.reauditDays);
    const issues = input.issues.get(row.file)?.length ?? 0;
    const signalWeight = input.signalWeights.get(row.file) ?? 0;
    const hot = weights.cost * (Math.log1p(row.costSeconds ?? 0) / Math.log1p(maxCost))
      + weights.issues * (Math.min(issues, 3) / 3)
      + weights.signals * (1 - Math.exp(-signalWeight / 10))
      + weights.neverAudited * (state === "never" ? 1 : 0);
    return { row, state, auditedAt: audit?.at ?? null, hot: Math.round(hot * 10_000) / 10_000, issues, signalWeight };
  });
}

function order(candidates: Candidate[], mode: Mode): Candidate[] {
  if (mode === "hot") return [...candidates].sort((a, b) => b.hot - a.hot || byFile(a, b));
  return [...candidates].sort((a, b) => {
    if (a.state !== b.state) return a.state === "never" ? -1 : b.state === "never" ? 1 : 0;
    if (a.auditedAt !== b.auditedAt) return (a.auditedAt ?? "") < (b.auditedAt ?? "") ? -1 : 1;
    return byFile(a, b);
  });
}

export function planRun(input: PlanInput): Plan {
  const { profile } = input;
  const mode = input.mode ?? modeFor(input.runCount, profile.sweepEvery);
  const ranked = rank(input);
  const stats: Plan["stats"] = { files: ranked.length, never: 0, stale: 0, fresh: 0, claimed: 0, inOpenPrs: 0, skippedTiers: {}, eligibleInPackage: 0, selected: 0 };
  const eligible: Candidate[] = [];
  for (const candidate of ranked) {
    stats[candidate.state]++;
    if (candidate.state === "fresh") continue;
    if (input.only && !input.only.has(candidate.row.file)) continue;
    if (!profile.tiers.includes(candidate.row.tier)) { stats.skippedTiers[candidate.row.tier] = (stats.skippedTiers[candidate.row.tier] ?? 0) + 1; continue; }
    if (input.claims.has(candidate.row.file)) { stats.claimed++; continue; }
    if (input.openPrFiles.has(candidate.row.file)) { stats.inOpenPrs++; continue; }
    eligible.push(candidate);
  }
  const plan: Plan = { runId: input.runId, profile: profile.name, mode, package: null, clusters: [], throttled: null, stats };
  const cap = profile.backlog.maxParkedChangedFiles;
  if (cap !== null && (input.parkedChangedFiles ?? 0) >= cap) {
    plan.throttled = `${input.parkedChangedFiles} changed files are waiting to land (cap ${cap})`;
    return plan;
  }
  if (!eligible.length) return plan;

  const budget = profile.budgetFiles;
  const packages = new Map<string, Candidate[]>();
  for (const candidate of order(eligible, mode)) packages.set(candidate.row.package, [...(packages.get(candidate.row.package) ?? []), candidate]);
  let chosen = input.package ?? (input.preferPackage && packages.has(input.preferPackage) ? input.preferPackage : undefined);
  if (!chosen) {
    if (mode === "sweep") chosen = order(eligible, mode)[0]!.row.package;
    else {
      // The package where this run's budget does the most good.
      const value = (list: Candidate[]) => list.slice(0, budget ?? 25).reduce((sum, candidate) => sum + candidate.hot, 0);
      chosen = [...packages.entries()].sort(([a, x], [b, y]) => value(y) - value(x) || (a < b ? -1 : 1))[0]![0];
    }
  }
  plan.package = chosen;
  const queue = packages.get(chosen) ?? [];
  stats.eligibleInPackage = queue.length;
  const available = new Map(queue.map(candidate => [candidate.row.file, candidate]));
  const taken = new Set<string>();
  for (const candidate of queue) {
    if (budget !== null && taken.size >= budget) break;
    if (taken.has(candidate.row.file)) continue;
    const neighbours = neighboursOf(candidate.row, input.affinity);
    const members = [candidate.row.file];
    taken.add(candidate.row.file);
    for (const neighbour of neighbours) {
      if (members.length >= profile.clusterSize) break;
      if (!available.has(neighbour.file) || taken.has(neighbour.file)) continue;
      members.push(neighbour.file);
      taken.add(neighbour.file);
    }
    // Vertical neighbours first: an expensive test's overlap with a cheap one is the costly kind.
    const context = neighbours.filter(neighbour => !members.includes(neighbour.file))
      .sort((a, b) => (a.relation === b.relation ? 0 : a.relation === "vertical" ? -1 : 1) || b.score - a.score)
      .slice(0, 6).map(neighbour => neighbour.file);
    plan.clusters.push({ index: plan.clusters.length, seed: candidate.row.file, members, context, neighbours: neighbours.filter(n => members.includes(n.file) || context.includes(n.file)) });
  }
  stats.selected = taken.size;
  return plan;
}

/** Files of a package that still need an audit and could get one. A claimed
 * file counts: another run is working on it, so the package is not finished. A
 * file in someone's open pull request does not: it is unavailable, and a batch
 * must not wait on it. */
export function remainingIn(input: Pick<PlanInput, "inventory" | "profile" | "now" | "audits" | "signalWeights" | "issues" | "openPrFiles">, packageName: string): number {
  return rank(input).filter(candidate => candidate.row.package === packageName && candidate.state !== "fresh"
    && input.profile.tiers.includes(candidate.row.tier) && !input.openPrFiles.has(candidate.row.file)).length;
}

export interface Shard { id: string; package: string; files: string[]; effort: number }

/** Disjoint work lists for parallel workers. Each shard stays inside one
 * package, so the count is a target: every package with work gets at least one. */
export function makeShards(candidates: readonly Candidate[], count: number): Shard[] {
  const effortOf = (row: Row) => 1 + Math.min(row.costSeconds ?? 0, 120) / 30 + (TIER_LEVEL[row.tier] - 1);
  const packages = new Map<string, Row[]>();
  for (const candidate of [...candidates].sort(byFile)) {
    if (candidate.state !== "fresh") packages.set(candidate.row.package, [...(packages.get(candidate.row.package) ?? []), candidate.row]);
  }
  const total = [...packages.values()].flat().reduce((sum, row) => sum + effortOf(row), 0);
  const target = total / Math.max(1, count);
  const shards: Shard[] = [];
  for (const [name, rows] of [...packages.entries()].sort(([a], [b]) => a < b ? -1 : 1)) {
    const effort = rows.reduce((sum, row) => sum + effortOf(row), 0);
    const pieces = Math.max(1, Math.min(rows.length, Math.round(effort / target)));
    let piece: Row[] = [], pieceEffort = 0, index = 1;
    const flush = () => {
      if (!piece.length) return;
      shards.push({ id: `${name}-${String(index++).padStart(2, "0")}`, package: name, files: piece.map(row => row.file), effort: Math.round(pieceEffort * 10) / 10 });
      piece = []; pieceEffort = 0;
    };
    for (const row of rows) {
      piece.push(row); pieceEffort += effortOf(row);
      if (pieceEffort >= effort / pieces && index < pieces) flush();
    }
    flush();
  }
  return shards;
}
