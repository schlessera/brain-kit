import { DAY, HOUR, RECENT, bucket, type Capacity, type HistoryPayload, type Sample } from "./history-model.js";

export type EvidenceReason = "no-observation" | "stale" | "future" | "incomplete" | "changed-scope" | "changed-capacity" | "gap" | "ordering" | "insufficient-count" | "insufficient-span" | "mixed-direction" | "single-burst" | "arithmetic";
export interface WindowEvidence {
  state: "unavailable" | "finite" | "non-depleting";
  reason: EvidenceReason | null;
  start: number | null; end: number | null; samples: number;
  depletionPerDay: number | null; days: number | null;
}
export interface ObservedRate { start: number; end: number; samples: number; bytesPerDay: number }
export interface CapacityEvidence {
  identity: string; rootScope: string;
  at: number; total: number | null; available: number | null;
  fresh: boolean; short: WindowEvidence; long: WindowEvidence;
  appLogical: ObservedRate | null; appAllocated: ObservedRate | null; availableChange: ObservedRate | null;
}
type Point = { sample: Sample; capacity: Capacity | null; scope: string; basis: number; identity: string; rootScope: string };
const unavailable = (reason: EvidenceReason, window: Point[] = []): WindowEvidence => ({ state: "unavailable", reason, start: window[0]?.sample[3] ?? null, end: window.at(-1)?.sample[3] ?? null, samples: window.length, depletionPerDay: null, days: null });

function point<S>(payload: HistoryPayload<S>, sample: Sample, identity: string): Point {
  const capacity = sample[9].find(row => payload.metadata.capacities[row[0]]?.[0] === identity) ?? null;
  const descriptor = capacity ? payload.metadata.capacities[capacity[0]] : null;
  return { sample, capacity, scope: payload.metadata.samples[sample[6]]?.[1] ?? "", basis: payload.metadata.samples[sample[6]]?.[2] ?? 0, identity: descriptor?.[0] ?? "", rootScope: descriptor?.[1] ?? "" };
}
function invalid(value: Point, latest: Point): EvidenceReason | null {
  if (value.sample[2]) return "gap";
  if (!value.capacity || value.capacity[5] !== 0 || value.capacity[1] === null || value.capacity[1] <= 0 || value.capacity[4] === null || (value.sample[7] !== 0 && value.sample[8] !== 3)) return "incomplete";
  if (value.identity !== latest.identity || value.rootScope !== latest.rootScope || value.scope !== latest.scope || value.basis !== latest.basis) return "changed-scope";
  if (value.capacity[1] !== latest.capacity?.[1]) return "changed-capacity";
  return null;
}
function suffix(points: Point[], span: number, interval: number, now: number): { values: Point[]; reason: EvidenceReason | null } {
  const latest = points.at(-1);
  if (!latest) return { values: [], reason: "no-observation" };
  if (latest.sample[3] > now) return { values: [], reason: "future" };
  if (now - latest.sample[3] > RECENT) return { values: [], reason: "stale" };
  const issue = invalid(latest, latest);
  if (issue) return { values: [], reason: issue };
  const values: Point[] = [latest];
  let reason: EvidenceReason | null = null;
  for (let index = points.length - 2; index >= 0; index--) {
    const value = points[index]!, next = values[0]!;
    if (value.sample[3] >= next.sample[3]) { reason = "ordering"; break; }
    if (latest.sample[3] - value.sample[3] > span) break;
    reason = invalid(value, latest) ?? (next.sample[3] - value.sample[3] > interval ? "gap" : null);
    if (reason) break;
    values.unshift(value);
  }
  return { values, reason };
}
function scenario(points: Point[], minimum: number, minimumSpan: number, maximumSpan: number, maximumInterval: number, now: number): WindowEvidence {
  const { values, reason } = suffix(points, maximumSpan, maximumInterval, now);
  if (values.length < minimum) return unavailable(reason ?? "insufficient-count", values);
  const first = values[0]!, last = values.at(-1)!, elapsed = last.sample[3] - first.sample[3];
  if (elapsed < minimumSpan) return unavailable("insufficient-span", values);
  const changes = values.slice(1).map((value, index) => values[index]!.capacity![4]! - value.capacity![4]!);
  const net = first.capacity![4]! - last.capacity![4]!;
  const observation = { start: first.sample[3], end: last.sample[3], samples: values.length };
  if (net === 0) return changes.every(change => change === 0)
    ? { ...observation, state: "non-depleting", reason: null, depletionPerDay: 0, days: null }
    : unavailable("mixed-direction", values);
  if (changes.filter(change => change === 0 || Math.sign(change) === Math.sign(net)).length * 3 < changes.length * 2) return unavailable("mixed-direction", values);
  if (changes.some(change => Math.abs(change) > Math.abs(net) / 2)) return unavailable("single-burst", values);
  const depletionPerDay = net / (elapsed / DAY), days = last.capacity![4]! / depletionPerDay;
  if (!Number.isFinite(depletionPerDay) || !Number.isFinite(days)) return unavailable("arithmetic", values);
  return { ...observation, state: net > 0 ? "finite" : "non-depleting", reason: null, depletionPerDay, days: net > 0 ? days : null };
}
function rate(points: Point[], field: 4 | 8 | 9, now: number): ObservedRate | null {
  let { values } = suffix(points, 7 * DAY, 12 * HOUR, now);
  const lastUnknown = values.findLastIndex(value => value.capacity?.[field] === null);
  if (lastUnknown >= 0) values = values.slice(lastUnknown + 1);
  const first = values[0], last = values.at(-1);
  if (values.length < 5 || !first || !last || last.sample[3] - first.sample[3] < 48 * HOUR) return null;
  const bytesPerDay = (last.capacity![field]! - first.capacity![field]!) / ((last.sample[3] - first.sample[3]) / DAY);
  return Number.isFinite(bytesPerDay) ? { start: first.sample[3], end: last.sample[3], samples: values.length, bytesPerDay } : null;
}

/** Named evidence has no interpolation, confidence interval or implied infinite capacity. */
export function capacityEvidence<S>(payload: HistoryPayload<S>, identity: string, now: number): CapacityEvidence | null {
  const recent = payload.samples.filter(row => row[1] === 0).map(row => point(payload, row, identity));
  const latest = recent.at(-1);
  if (!latest?.capacity) return null;
  const daily = payload.samples.filter(row => row[1] === 1 && bucket(1, row[3]) < bucket(1, latest.sample[3])).map(row => point(payload, row, identity));
  const long = [...daily.filter(value => value.sample[3] !== latest.sample[3]), latest];
  return { identity, rootScope: latest.rootScope, at: latest.sample[3], total: latest.capacity[1], available: latest.capacity[4],
    fresh: latest.capacity[5] !== 2 && latest.capacity[1] !== null && latest.capacity[1] > 0 && latest.capacity[4] !== null && latest.sample[3] <= now && now - latest.sample[3] <= RECENT,
    short: scenario(recent, 5, 48 * HOUR, 7 * DAY, 12 * HOUR, now),
    long: scenario(long, 15, 14 * DAY, 28 * DAY, 48 * HOUR, now),
    appLogical: rate(recent, 8, now), appAllocated: rate(recent, 9, now), availableChange: rate(recent, 4, now) };
}
