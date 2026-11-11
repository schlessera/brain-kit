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
 * A run stays inside one group. Hosted proof for a test edit is priced by the
 * workspaces it touches, not by the number of files, so a batch that widens to
 * a second large package buys a second closure. A small package is the
 * exception: alone it could only ever land a pull request of a few files, so
 * the small packages share one group (`small`) and pay their closures once,
 * together. A cluster still stays inside one package.
 */
import { UNFINISHED_REASONS } from "./catalog";
import type { Profile } from "./config";
import { TIER_LEVEL, type Inventory, type Row } from "./inventory";
import type { FileAuditState } from "./ledger";
import { neighboursOf, type Affinity, type Neighbour } from "./neighbours";

/** `unfinished`: audited at its current content, but the audit deferred work on the file for budget or proof. */
export type FileState = "never" | "stale" | "unfinished" | "fresh";
export type Mode = "hot" | "sweep";

export interface IssueRef { number: number; title: string; needsRepro: boolean; assigned: boolean }

export interface Candidate { row: Row; state: FileState; auditedAt: string | null; hot: number; issues: number; signalWeight: number }

export interface Cluster {
  index: number;
  /** The package every member belongs to. */
  package: string;
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
  /** The group the run stays inside: a package's own name, or `small`. */
  group: string | null;
  /** The package, when every cluster is in one; a `small` run may span several. */
  package: string | null;
  clusters: Cluster[];
  /** Set when the run should record itself and stop without auditing. */
  throttled: string | null;
  stats: {
    files: number; never: number; stale: number; unfinished: number; fresh: number; claimed: number; inOpenPrs: number;
    skippedTiers: Record<string, number>; eligibleInGroup: number; selected: number;
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
  /** Restricts the run to one package, inside that package's group. */
  package?: string;
  /** Restricts the run to one group (a shard of the push wrapper names its group). */
  group?: string;
  /** The group of the batch this run should continue, when one is open. */
  preferGroup?: string;
  /** Restricts the run to these files (a shard of the push wrapper). */
  only?: ReadonlySet<string>;
  /** Changed files waiting in open batches; the cron profile stops adding beyond its cap. */
  parkedChangedFiles?: number;
}

export function fileState(row: Row, audit: FileAuditState | undefined, now: Date, reauditDays: number): FileState {
  if (!audit) return "never";
  const sameContent = row.blob === audit.blobBefore || row.blob === audit.blobAfter;
  const ageDays = (now.getTime() - Date.parse(audit.at)) / 86_400_000;
  if (!sameContent || ageDays >= reauditDays) return "stale";
  // Work deferred for budget or proof was never done; marking the file fresh would drop it for the whole re-audit window.
  return audit.deferred?.some(finding => UNFINISHED_REASONS.includes(finding.deferredFor)) ? "unfinished" : "fresh";
}

export const SMALL_GROUP = "small";

/** Each package's group: `small` for a package with at most `smallPackageFiles`
 * test files in the profile's tiers, otherwise the package's own name. */
export function groupsOf(rows: readonly Row[], profile: Pick<Profile, "tiers" | "smallPackageFiles">): Map<string, string> {
  const counts = new Map<string, number>();
  if (rows.some(row => row.package === SMALL_GROUP)) throw new Error(`A package named "${SMALL_GROUP}" would share its name with the shared group; rename it or the group`);
  for (const row of rows) counts.set(row.package, (counts.get(row.package) ?? 0) + (profile.tiers.includes(row.tier) ? 1 : 0));
  return new Map([...counts].map(([name, count]) => [name, profile.smallPackageFiles !== null && count <= profile.smallPackageFiles ? SMALL_GROUP : name]));
}

/** The current group a batch's recorded group stands for. A batch opened before
 * groups records its package, and a package that is small now belongs to `small`. */
export const resolveGroup = (name: string, groups: ReadonlyMap<string, string>): string => groups.get(name) ?? name;

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
    // Unfinished work weighs at least as much as a file nobody has looked at.
    const hot = weights.cost * (Math.log1p(row.costSeconds ?? 0) / Math.log1p(maxCost))
      + weights.issues * (Math.min(issues, 3) / 3)
      + weights.signals * (1 - Math.exp(-signalWeight / 10))
      + weights.neverAudited * (state === "never" || state === "unfinished" ? 1 : 0);
    return { row, state, auditedAt: audit?.at ?? null, hot: Math.round(hot * 10_000) / 10_000, issues, signalWeight };
  });
}

/** In the hot queue, at an equal score, resuming started work comes first, then files never audited. */
const urgency = (state: FileState): number => state === "unfinished" ? 0 : state === "never" ? 1 : 2;

function order(candidates: Candidate[], mode: Mode): Candidate[] {
  if (mode === "hot") return [...candidates].sort((a, b) => b.hot - a.hot || urgency(a.state) - urgency(b.state) || byFile(a, b));
  // The sweep keeps its own order, never audited first and then the oldest audit, unfinished files included:
  // a file deferred again and again must not hold every run, or the long tail is never reached.
  return [...candidates].sort((a, b) => {
    if (a.state !== b.state && (a.state === "never" || b.state === "never")) return a.state === "never" ? -1 : 1;
    if (a.auditedAt !== b.auditedAt) return (a.auditedAt ?? "") < (b.auditedAt ?? "") ? -1 : 1;
    return byFile(a, b);
  });
}

export function planRun(input: PlanInput): Plan {
  const { profile } = input;
  const mode = input.mode ?? modeFor(input.runCount, profile.sweepEvery);
  const ranked = rank(input);
  const groups = groupsOf(input.inventory.rows, profile);
  const stats: Plan["stats"] = { files: ranked.length, never: 0, stale: 0, unfinished: 0, fresh: 0, claimed: 0, inOpenPrs: 0, skippedTiers: {}, eligibleInGroup: 0, selected: 0 };
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
  const plan: Plan = { runId: input.runId, profile: profile.name, mode, group: null, package: null, clusters: [], throttled: null, stats };
  const cap = profile.backlog.maxParkedChangedFiles;
  if (cap !== null && (input.parkedChangedFiles ?? 0) >= cap) {
    plan.throttled = `${input.parkedChangedFiles} changed files are waiting to land (cap ${cap})`;
    return plan;
  }
  if (!eligible.length) return plan;

  const budget = profile.budgetFiles;
  const groupOf = (candidate: Candidate) => groups.get(candidate.row.package)!;
  const byGroup = new Map<string, Candidate[]>();
  for (const candidate of order(eligible, mode)) byGroup.set(groupOf(candidate), [...(byGroup.get(groupOf(candidate)) ?? []), candidate]);
  const preferred = input.preferGroup ? resolveGroup(input.preferGroup, groups) : undefined;
  let chosen = input.group ?? (input.package ? groups.get(input.package) : undefined) ?? (preferred && byGroup.has(preferred) ? preferred : undefined);
  if (!chosen) {
    if (mode === "sweep") chosen = groupOf(order(eligible, mode)[0]!);
    else {
      // The group where this run's budget does the most good.
      const value = (list: Candidate[]) => list.slice(0, budget ?? 25).reduce((sum, candidate) => sum + candidate.hot, 0);
      chosen = [...byGroup.entries()].sort(([a, x], [b, y]) => value(y) - value(x) || (a < b ? -1 : 1))[0]![0];
    }
  }
  plan.group = chosen;
  const queue = (byGroup.get(chosen) ?? []).filter(candidate => !input.package || candidate.row.package === input.package);
  stats.eligibleInGroup = queue.length;
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
      // In the small group a neighbour may sit in another package of the group: it is context, not a member.
      if (available.get(neighbour.file)?.row.package !== candidate.row.package || taken.has(neighbour.file)) continue;
      members.push(neighbour.file);
      taken.add(neighbour.file);
    }
    // Vertical neighbours first: an expensive test's overlap with a cheap one is the costly kind.
    const context = neighbours.filter(neighbour => !members.includes(neighbour.file))
      .sort((a, b) => (a.relation === b.relation ? 0 : a.relation === "vertical" ? -1 : 1) || b.score - a.score)
      .slice(0, 6).map(neighbour => neighbour.file);
    plan.clusters.push({ index: plan.clusters.length, package: candidate.row.package, seed: candidate.row.file, members, context,
      neighbours: neighbours.filter(n => members.includes(n.file) || context.includes(n.file)) });
  }
  const packages = new Set(plan.clusters.map(cluster => cluster.package));
  plan.package = input.package ?? (packages.size === 1 ? [...packages][0]! : null);
  stats.selected = taken.size;
  return plan;
}

/** Files of a group that still need an audit and could get one. A claimed
 * file counts: another run is working on it, so the group is not finished. A
 * file in someone's open pull request does not: it is unavailable, and a batch
 * must not wait on it. `groupName` may be a batch's recorded group, which
 * `resolveGroup` maps to the group it stands for now. */
export function remainingIn(input: Pick<PlanInput, "inventory" | "profile" | "now" | "audits" | "signalWeights" | "issues" | "openPrFiles">, groupName: string): number {
  const groups = groupsOf(input.inventory.rows, input.profile);
  const group = resolveGroup(groupName, groups);
  return rank(input).filter(candidate => groups.get(candidate.row.package) === group && candidate.state !== "fresh"
    && input.profile.tiers.includes(candidate.row.tier) && !input.openPrFiles.has(candidate.row.file)).length;
}

export interface Shard { id: string; group: string; files: string[]; effort: number }

/** Disjoint work lists for parallel workers. Each shard stays inside one
 * group, so the count is a target: every group with work gets at least one,
 * and the small packages share theirs. */
export function makeShards(candidates: readonly Candidate[], count: number, groups: ReadonlyMap<string, string>): Shard[] {
  const effortOf = (row: Row) => 1 + Math.min(row.costSeconds ?? 0, 120) / 30 + (TIER_LEVEL[row.tier] - 1);
  const packages = new Map<string, Row[]>();
  for (const candidate of [...candidates].sort(byFile)) {
    const group = groups.get(candidate.row.package) ?? candidate.row.package;
    if (candidate.state !== "fresh") packages.set(group, [...(packages.get(group) ?? []), candidate.row]);
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
      shards.push({ id: `${name}-${String(index++).padStart(2, "0")}`, group: name, files: piece.map(row => row.file), effort: Math.round(pieceEffort * 10) / 10 });
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
