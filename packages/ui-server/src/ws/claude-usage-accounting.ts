import type { ModelUsage, TurnUsage } from "@schlessera/brain-ui-sdk/protocol";
import { sumModelUsage } from "@schlessera/brain-ui-sdk/protocol";

const classes = ["inputTokens", "outputTokens", "cacheReadTokens", "cacheCreationTokens"] as const;
type Counts = Record<string, ModelUsage>;
const emptyCounts = (): Counts => Object.create(null);
// structuredClone/JSON restore ordinary objects. Rebuild the dictionary after
// cloning so arbitrary model ids cannot resolve inherited properties/setters.
const cloneCounts = (counts: Counts): Counts => Object.assign(emptyCounts(), structuredClone(counts));
export interface ClaudeUsageState {
  completed: Counts;
  auxiliary: Counts;
  partial: boolean;
  baselinePending: boolean;
}
function valid(usage: Counts): boolean {
  return Object.values(usage).every(model => classes.every(key => Number.isSafeInteger(model[key]) && model[key]! >= 0));
}
function add(left: Counts, right: Counts): Counts {
  const result = cloneCounts(left);
  for (const [model, counts] of Object.entries(right)) {
    const target = result[model] ??= {};
    for (const key of classes) target[key] = (target[key] ?? 0) + counts[key]!;
  }
  return result;
}
/** Cumulative runtime totals are evidence of unstreamed spend, never a main
 * turn receipt. Reconcile their nonnegative remainder against all completed
 * responses observed since the session baseline. Keep each remainder high
 * water so a resume or rollback cannot charge previously observed work again.
 * This identifies unstreamed usage, not a title/model/request classifier.
 */
export function reconcileClaudeUsage(previous: ClaudeUsageState | undefined, own: TurnUsage | undefined,
  cumulative: TurnUsage | undefined, resumed: boolean, snapshotOwn?: TurnUsage): { state: ClaudeUsageState; auxiliary?: TurnUsage } {
  const completed = cloneCounts(own?.perModel ?? emptyCounts());
  const totals = cumulative?.perModel ? cloneCounts(cumulative.perModel) : undefined;
  const snapshot = snapshotOwn?.perModel ? cloneCounts(snapshotOwn.perModel) : completed;
  const state: ClaudeUsageState = previous
    ? { ...previous, completed: cloneCounts(previous.completed), auxiliary: cloneCounts(previous.auxiliary) }
    : { completed: emptyCounts(), auxiliary: emptyCounts(), partial: resumed, baselinePending: resumed };
  if (!valid(completed) || !valid(snapshot) || totals && !valid(totals)) {
    state.partial = true;
    return { state };
  }
  const comparison = add(state.completed, snapshot);
  state.completed = add(state.completed, completed);
  if (Object.keys(completed).some(model => classes.some(key => (completed[model]?.[key] ?? 0) !== (snapshot[model]?.[key] ?? 0)))) state.partial = true;
  if (!totals) { state.partial = true; return { state }; }
  // Imported sessions have unknown earlier response coverage. A delayed first
  // terminal snapshot is still an opening baseline, never new auxiliary work.
  if (state.baselinePending) {
    for (const [model, counts] of Object.entries(comparison)) for (const key of classes) {
      if ((totals[model]?.[key] ?? 0) < counts[key]!) return { state };
    }
    // Keep responses completed after an intermediate SDK result as well.
    const baseline = cloneCounts(totals);
    for (const [model, counts] of Object.entries(state.completed)) {
      const target = baseline[model] ??= {};
      for (const key of classes) target[key] = (target[key] ?? 0) + counts[key]! - (comparison[model]?.[key] ?? 0);
    }
    state.completed = baseline;
    state.baselinePending = false;
    return { state };
  }
  const remainder = emptyCounts();
  for (const model of new Set([...Object.keys(totals), ...Object.keys(comparison)])) {
    remainder[model] = {};
    for (const key of classes) {
      const n = (totals[model]?.[key] ?? 0) - (comparison[model]?.[key] ?? 0);
      // Cancellation/CLI state rollback or unjoinable model ids: main usage
      // stays intact, auxiliary coverage is unknown. Never subtract spend.
      if (n < 0) { state.partial = true; return { state }; }
      remainder[model]![key] = n;
    }
  }
  const delta = emptyCounts();
  for (const [model, counts] of Object.entries(remainder)) {
    const accounted = state.auxiliary[model] ??= {};
    const added: ModelUsage = {};
    for (const key of classes) {
      if (counts[key]! < (accounted[key] ?? 0)) state.partial = true;
      added[key] = Math.max(0, counts[key]! - (accounted[key] ?? 0));
      accounted[key] = Math.max(accounted[key] ?? 0, counts[key]!);
    }
    if (classes.some(key => added[key]! > 0)) delta[model] = added;
  }
  return { state, ...(Object.keys(delta).length ? { auxiliary: sumModelUsage(delta) } : {}) };
}

export interface ClaudeUsageEvidence {
  completed?: TurnUsage;
  cumulative?: TurnUsage;
  reportedCostUsd?: number;
  /** Completed receipt at the latest available cumulative snapshot. */
  cumulativeCompleted?: TurnUsage;
}
