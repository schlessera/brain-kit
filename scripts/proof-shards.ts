/** Hosted shard counts for the measured browser domains. The ci.yml matrices,
 * retention, weight refresh and input partitions all read this one table (#2414). */
export const PROOF_SHARDS = { browser: 3, layout: 2 } as const;
export type ShardedDomain = keyof typeof PROOF_SHARDS;

export function shardNumbers(domain: ShardedDomain): number[] {
  return Array.from({ length: PROOF_SHARDS[domain] }, (_, index) => index + 1);
}
