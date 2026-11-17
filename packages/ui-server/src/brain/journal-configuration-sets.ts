import { createHash } from "node:crypto";

/**
 * A set of configuration inputs steering could not trace, as the journal
 * stores it once per distinct set (#3257). Its identity is the SHA-256 of the
 * sorted, de-duplicated path list as JSON, so the same set always has the same
 * hash, whichever turn observed it and in whatever order.
 */
interface ConfigurationSet { hash: string; paths: string[] }

export function configurationSet(paths: Iterable<string>): ConfigurationSet {
  const sorted = [...new Set(paths)].sort();
  const json = JSON.stringify(sorted);
  return { hash: createHash("sha256").update(json).digest("hex"), paths: sorted };
}

/** A turn row's view of its set: the referenced set, or a legacy per-turn array not moved yet. */
interface ConfigurationSetColumns { configuration_set: string | null; steering_inventory_missing: string }

type RecordedConfigurationSet = (ConfigurationSet & { recorded: true }) | { recorded: false; paths: [] };

/**
 * What a turn recorded. A legacy empty array cannot tell "recorded nothing"
 * from "never recorded", so it reads as not recorded; a nonempty one is a set.
 */
export function recordedConfigurationSet(
  row: ConfigurationSetColumns,
  lookup: (hash: string) => string[] | undefined,
): RecordedConfigurationSet {
  if (row.configuration_set) {
    const paths = lookup(row.configuration_set);
    if (paths) return { recorded: true, hash: row.configuration_set, paths };
  }
  const legacy = JSON.parse(row.steering_inventory_missing) as string[];
  return legacy.length ? { recorded: true, ...configurationSet(legacy) } : { recorded: false, paths: [] };
}
