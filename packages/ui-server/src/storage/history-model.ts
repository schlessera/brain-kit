import { createHash } from "node:crypto";
import type { StorageCollection } from "./collect.js";
import { storageTotals } from "./collect.js";

export const HISTORY_LIMITS = Object.freeze({ slots: [64, 90, 32] as const, sampleBytes: 1152, metadataBytes: 40960, payloadBytes: 262144, capacities: 4, writeInterval: 60_000 });
export const HOUR = 3_600_000, DAY = 24 * HOUR, RECENT = 6 * HOUR;
export type Quantity = number | null;
export type Coverage = 0 | 1 | 2;
export type Tier = 0 | 1 | 2;
export type Source = 0 | 1 | 2;
export type Capacity = [number, Quantity, Quantity, Quantity, Quantity, Coverage, Quantity, Quantity, Quantity, Quantity, Quantity, Quantity, Quantity, Quantity];
export type Sample = [1, Tier, 0 | 1, number, number, Source, number, Coverage, 0 | 1 | 2 | 3 | 4 | 5, Capacity[]];
export type SampleDescriptor = [string, string, 1];
export type CapacityDescriptor = [string, string];
export interface HistoryMetadata<S> {
  samples: Record<string, SampleDescriptor>;
  capacities: Record<string, CapacityDescriptor>;
  state: S;
}
export interface HistoryPayload<S> { metadata: HistoryMetadata<S>; samples: Sample[] }
export interface Aggregate {
  at: number; startedAt: number; source: Source; descriptor: SampleDescriptor;
  coverage: Coverage; reason: Sample[8];
  capacities: Array<{ descriptor: CapacityDescriptor; values: OmitFirst<Capacity> }>;
}
type OmitFirst<T extends unknown[]> = T extends [unknown, ...infer Rest] ? Rest : never;
export const hashScope = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex").slice(0, 32);
export const coverage = (value: "complete" | "partial" | "unknown"): Coverage => value === "complete" ? 0 : value === "partial" ? 1 : 2;
export const bucket = (tier: Tier, at: number) => Math.floor((at - (tier === 2 ? 4 * DAY : 0)) / (tier === 0 ? RECENT : tier === 1 ? DAY : 7 * DAY));
export const bucketStart = (tier: Tier, index: number) => index * (tier === 0 ? RECENT : tier === 1 ? DAY : 7 * DAY) + (tier === 2 ? 4 * DAY : 0);
export const jsonBytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const safe = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const quantity = (value: unknown) => value === null || safe(value);
const id = (value: unknown, limit: number) => safe(value) && value < limit;
const descriptorHash = (value: unknown) => typeof value === "string" && /^[a-f0-9]{32}$/.test(value);

/** Fixed tuples are private. Validate the actual bytes before every durable replacement. */
export function validateHistory<S>(payload: HistoryPayload<S>): void {
  const { metadata, samples } = payload;
  if (jsonBytes(metadata) > HISTORY_LIMITS.metadataBytes) throw Error("history-metadata-budget");
  if (samples.length > 186 || jsonBytes(payload) > HISTORY_LIMITS.payloadBytes) throw Error("history-payload-budget");
  for (const [key, value] of Object.entries(metadata.samples)) {
    if (!/^(0|[1-9]\d*)$/.test(key) || !id(Number(key), 186) || value.length !== 3 || !/^[\x20-\x7e]{1,32}$/.test(value[0]) || !descriptorHash(value[1]) || value[2] !== 1) throw Error("history-sample-descriptor");
  }
  for (const [key, value] of Object.entries(metadata.capacities)) {
    if (!/^(0|[1-9]\d*)$/.test(key) || !id(Number(key), 744) || value.length !== 2 || !value.every(descriptorHash)) throw Error("history-capacity-descriptor");
  }
  for (const tier of [0, 1, 2] as const) {
    const rows = samples.filter(row => row[1] === tier);
    if (rows.length > HISTORY_LIMITS.slots[tier] || new Set(rows.map(row => bucket(tier, row[3]))).size !== rows.length) throw Error("history-tier-budget");
  }
  for (const sample of samples) {
    if (sample.length !== 10 || sample[0] !== 1 || !id(sample[1], 3) || !id(sample[2], 2) || !safe(sample[3]) || !safe(sample[4]) || sample[4] > sample[3] || !id(sample[5], 3) || !id(sample[6], 186) || !id(sample[7], 3) || !id(sample[8], 6) || !metadata.samples[sample[6]] || sample[9].length > 4 || jsonBytes(sample) > HISTORY_LIMITS.sampleBytes) throw Error("history-sample-budget");
    if (new Set(sample[9].map(row => row[0])).size !== sample[9].length) throw Error("history-duplicate-capacity");
    for (const row of sample[9]) {
      if (row.length !== 14 || !id(row[0], 744) || !metadata.capacities[row[0]] || !id(row[5], 3) || row.some((value, index) => index !== 0 && index !== 5 && !quantity(value))) throw Error("history-capacity-shape");
    }
  }
}

/** A single scan supplies all tiers. Union attribution is deduplicated per capacity. */
export function aggregateCollection(value: StorageCollection, source: Source, collector: string): Aggregate {
  if (!/^[\x20-\x7e]{1,32}$/.test(collector)) throw Error("history-collector-version");
  const { summary, entries } = value, owner = new Map(summary.roots.map(root => [root.id, root.owner]));
  const scope = summary.roots.map(root => [root.id, root.owner, root.category]).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  const capacities = [...summary.capacities].sort((a, b) => a.id.localeCompare(b.id));
  return { at: summary.observedAt, startedAt: summary.startedAt, source,
    descriptor: [collector, hashScope(scope), 1], coverage: capacities.length > 4 ? 1 : coverage(summary.coverage), reason: capacities.length > 4 ? 3 : summary.coverage === "complete" ? 0 : 1,
    capacities: capacities.slice(0, 4).map(capacity => {
      const rows = entries.filter(entry => entry.capacityId === capacity.id), roots = summary.roots.filter(root => capacity.rootIds.includes(root.id));
      const complete = roots.length > 0 && roots.every(root => root.coverage === "complete") && !summary.errors.some(error => !error.rootId || capacity.rootIds.includes(error.rootId));
      const owners = (["brain", "app", "operator"] as const).map(kind => storageTotals(rows.filter(entry => owner.get(entry.rootId) === kind), complete));
      const union = storageTotals(rows, complete);
      const known = capacity.identity === "resolved" && capacity.total !== null && capacity.total > 0 && capacity.available !== null && capacity.free !== null && capacity.used !== null && capacity.used + capacity.free === capacity.total && capacity.available <= capacity.free;
      return { descriptor: [capacity.id, hashScope([...capacity.rootIds].sort())], values: [capacity.total, capacity.used, capacity.free, capacity.available, known && complete ? 0 : known ? 1 : 2,
        owners[0]!.logical, owners[0]!.allocated, owners[1]!.logical, owners[1]!.allocated, owners[2]!.logical, owners[2]!.allocated, union.logical, union.allocated] };
    }) };
}

function collectDescriptors<S>(payload: HistoryPayload<S>) {
  const samples = new Set(payload.samples.map(row => String(row[6]))), capacities = new Set(payload.samples.flatMap(row => row[9].map(capacity => String(capacity[0]))));
  for (const key of Object.keys(payload.metadata.samples)) if (!samples.has(key)) delete payload.metadata.samples[key];
  for (const key of Object.keys(payload.metadata.capacities)) if (!capacities.has(key)) delete payload.metadata.capacities[key];
}
function intern<T>(dictionary: Record<string, T>, value: T, limit: number) {
  const encoded = JSON.stringify(value), found = Object.entries(dictionary).find(([, item]) => JSON.stringify(item) === encoded);
  if (found) return Number(found[0]);
  for (let index = 0; index < limit; index++) if (!(index in dictionary)) { dictionary[index] = value; return index; }
  throw Error("history-descriptor-budget");
}

/** Pure candidate construction. Caller commits only after the whole payload validates. */
export function retainAggregate<S>(previous: HistoryPayload<S>, input: Aggregate): HistoryPayload<S> {
  const next = structuredClone(previous), { samples, metadata } = next;
  const latest = Math.max(0, ...samples.map(row => row[3]));
  if (!safe(input.at) || !safe(input.startedAt) || input.startedAt > input.at || input.at < latest) throw Error("history-clock-reversal");
  // Age and count are independent bounds. Do not replace good endpoints with failure.
  for (let index = samples.length - 1; index >= 0; index--) {
    const row = samples[index]!, current = bucket(row[1], input.at), old = bucket(row[1], row[3]);
    if (old < current - HISTORY_LIMITS.slots[row[1]] + 1 || old > current) samples.splice(index, 1);
    else if (old < current && bucket(0, row[3]) < bucket(0, bucketStart(row[1], old + 1) - 1)) row[2] = 1;
  }
  const lastRecent = samples.filter(row => row[1] === 0).sort((a, b) => b[3] - a[3])[0];
  const changed = lastRecent && (JSON.stringify(metadata.samples[lastRecent[6]]?.slice(1)) !== JSON.stringify(input.descriptor.slice(1))
    || JSON.stringify(lastRecent[9].map(row => metadata.capacities[row[0]])) !== JSON.stringify(input.capacities.map(row => row.descriptor)));
  const missed = !!lastRecent && bucket(0, input.at) > bucket(0, lastRecent[3]) + 1;
  const incomplete = (input.coverage !== 0 && input.reason !== 3) || input.capacities.some(row => row.values[4] !== 0);
  const replaced = new Map<Tier, Sample>();
  for (const tier of [0, 1, 2] as const) {
    const prior = samples.find(row => row[1] === tier && bucket(tier, row[3]) === bucket(tier, input.at));
    if (prior) {
      if (prior[7] === 0 && input.coverage !== 0) { prior[2] = 1; continue; }
      replaced.set(tier, prior); samples.splice(samples.indexOf(prior), 1);
    }
  }
  collectDescriptors(next);
  // Protect a complete bucket even when the incoming input contains a new scope.
  const tiers = ([0, 1, 2] as const).filter(tier => !samples.some(row => row[1] === tier && bucket(tier, row[3]) === bucket(tier, input.at)));
  if (tiers.length) {
    const descriptor = intern(metadata.samples, input.descriptor, 186), capacities = input.capacities.map(row => [intern(metadata.capacities, row.descriptor, 744), ...row.values] as Capacity);
    for (const tier of tiers) {
      const gap = !!replaced.get(tier)?.[2] || incomplete || !!changed || missed || (!replaced.has(tier) && input.at >= bucketStart(tier, bucket(tier, input.at)) + RECENT);
      samples.push([1, tier, gap ? 1 : 0, input.at, input.startedAt, input.source, descriptor, input.coverage, changed ? 5 : input.reason, capacities]);
    }
  }
  samples.sort((a, b) => a[1] - b[1] || a[3] - b[3]);
  collectDescriptors(next); validateHistory(next); return next;
}
