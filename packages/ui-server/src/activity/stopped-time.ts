import type { ActivityTurnHold, ActivityTurnLifecycle } from "@schlessera/brain-ui-sdk/protocol";

/** Sweep observed endpoints once, partitioning the union even for partially overlapping holds. */
export function stoppedTime(holds: readonly ActivityTurnHold[]): NonNullable<ActivityTurnLifecycle["stoppedTime"]> {
  const total = { totalMs: 0, intervals: 0, sharedHolds: 0, openHolds: 0, inferenceMs: 0, noInferenceMs: 0, unknownMs: 0 };
  type Bucket = "inferenceMs" | "noInferenceMs" | "unknownMs";
  const edges: Array<{ at: number; bucket: Bucket; change: number }> = [];
  const distinct = new Set<string>();
  for (const { stoppedAt, resumedAt, inferenceInFlight } of holds) {
    if (stoppedAt === null) continue;
    if (resumedAt === null) { total.openHolds++; continue; }
    if (resumedAt < stoppedAt) continue;
    const interval = JSON.stringify([stoppedAt, resumedAt]);
    if (distinct.has(interval)) total.sharedHolds++;
    distinct.add(interval);
    const bucket = inferenceInFlight === null ? "unknownMs" : inferenceInFlight ? "inferenceMs" : "noInferenceMs";
    edges.push({ at: stoppedAt, bucket, change: 1 }, { at: resumedAt, bucket, change: -1 });
  }
  total.intervals = distinct.size;
  edges.sort((a, b) => a.at - b.at);
  const active = { inferenceMs: 0, noInferenceMs: 0, unknownMs: 0 };
  let previous = edges[0]?.at ?? 0;
  for (const { at, bucket, change } of edges) {
    if (active.inferenceMs) total.inferenceMs += at - previous;
    else if (active.unknownMs) total.unknownMs += at - previous;
    else if (active.noInferenceMs) total.noInferenceMs += at - previous;
    active[bucket] += change;
    previous = at;
  }
  total.totalMs = total.inferenceMs + total.unknownMs + total.noInferenceMs;
  return total;
}
