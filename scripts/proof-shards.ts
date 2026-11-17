/** Hosted shard counts for the measured browser domains. The ci.yml matrices,
 * retention, weight refresh and input partitions all read this one table (#2414). */
export const PROOF_SHARDS = { browser: 3, layout: 2 } as const;
export type ShardedDomain = keyof typeof PROOF_SHARDS;

export function shardNumbers(domain: ShardedDomain): number[] {
  return Array.from({ length: PROOF_SHARDS[domain] }, (_, index) => index + 1);
}

/** Unit-tier partition caps (#4108). Ready confirmation holds the one merge
 * lease while its unit jobs run, and draft heavy feedback runs the same jobs,
 * so both use eight. Main pushes, exhaustive runs and local diagnostics keep
 * the base four, so a main run needs no more runners than before. The planner,
 * the merge path's partition validation, the weight refresh and the workflow
 * guard read this table; the matrix and the divisor reach it through the
 * planner's `unit_shards` output. */
export const UNIT_PARTITIONS = { base: 4, cadence: { confirmation: 8, "feedback-heavy": 8 } } as const;
export const MAX_UNIT_PARTITIONS = Math.max(UNIT_PARTITIONS.base, ...Object.values(UNIT_PARTITIONS.cadence));

export function unitPartitionLimit(cadence: string | undefined): number {
  const wide: Readonly<Record<string, number>> = UNIT_PARTITIONS.cadence;
  return cadence !== undefined && Object.hasOwn(wide, cadence) ? wide[cadence]! : UNIT_PARTITIONS.base;
}

/** Partition numbers for an inventory of `files` test files: never more
 * partitions than files, so every partition is nonempty. Complete discovery
 * passes no count and takes the cadence's cap. */
export function unitPartitions(cadence: string | undefined, files?: number): number[] {
  const limit = unitPartitionLimit(cadence);
  if (files !== undefined && !(Number.isSafeInteger(files) && files >= 1)) throw new Error("Empty selected unit inventory");
  return Array.from({ length: Math.min(limit, files ?? limit) }, (_, index) => index + 1);
}
