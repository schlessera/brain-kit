/** Hosted shard counts for the measured browser domains. The ci.yml matrices,
 * the merge path's job inventory and the weight refresh all read this one table (#2414). */
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

/** `determinism` partitions (#4117): the one owner of one job's capacity, the
 * most partitions a selection may use and the proof step's limit. Capacity is
 * in reviewed-weight seconds at the selection's repetition count, and it is
 * also the budget that reduces the count (`BUDGET_SECONDS`,
 * scripts/determinism-plan.ts). `loadRatio` is the largest elapsed seconds per
 * weighted second measured in a complete hosted run of at least 90 weighted
 * seconds; capacity times that ratio must fit the step limit. The planner's
 * `determinism_shards` output, each partition's command, both aggregates, the
 * merge path and the workflow guard read this table. Measured basis:
 * docs/decisions/ci-utility.md, "Changed tests repeat under load before merge".
 *
 * `deadlineFactor` multiplies test deadlines inside the job (#4191): Bun's
 * per-test cap, explicit test and hook timeouts and `watchdogMs` watchdogs
 * (scripts/test-deadlines.ts). It is the smallest whole number at least 15%
 * above `loadRatio`, the largest slowdown measured under the job's own load,
 * so a watchdog trips on a hang and not on the load. One hung test waiting out
 * its scaled cap after a full capacity must still fit the step limit. Basis:
 * docs/decisions/ci-utility.md, "Test watchdogs are a worst-case catch-all". */
export const DETERMINISM_PARTITIONS = { capacitySeconds: 300, max: 10, stepMinutes: 40, loadRatio: 6.84, deadlineFactor: 8 } as const;

/** `browser_determinism` partitions (#4163): the one owner of one job's
 * capacity, the most partitions a selection may use, the proof step's limit
 * and the cost of a project/file pair that has no reviewed weight. Capacity is
 * in seconds of `scripts/browser-shard-costs.json` at the selection's
 * repetition count, and it is also the budget that reduces the count
 * (`BROWSER_BUDGET_SECONDS`, scripts/browser-determinism-plan.ts). `loadRatio`
 * is the largest elapsed seconds per weighted second the #4116 spike measured
 * for a pass under burners inside the container. The planner's
 * `browser_determinism_shards` output, each partition's command, both
 * aggregates, the merge path and the workflow guard read this table. Measured
 * basis: docs/decisions/ci-utility.md, "Changed browser specs repeat under
 * load before merge". `deadlineFactor` is the smallest integer at least 15%
 * above the measured ratio: Vitest defaults and in-spec watchdogs scale by
 * it only inside this deliberately loaded job (#4192). */
export const BROWSER_DETERMINISM_PARTITIONS = { capacitySeconds: 300, max: 15, stepMinutes: 20, loadRatio: 1.8, unweightedSeconds: 10, deadlineFactor: 3 } as const;
