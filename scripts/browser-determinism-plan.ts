/**
 * Selection, repetition and partition planning for the hosted `browser_determinism` job (#4163).
 *
 * Pure: the planner (scripts/ci-plan.ts), each partition's command
 * (scripts/ci-proof.ts) and the runner (scripts/browser-determinism.ts) read
 * these functions, so they cannot disagree about which specs count, which
 * project/file pairs a spec expands to, the repetition count or the partition
 * that runs a pair. Counting and partitioning are the Bun gate's
 * (scripts/determinism-plan.ts), applied to pairs and browser weights.
 * Policy: docs/decisions/ci-utility.md, "Changed browser specs repeat under load before merge".
 */
import { readBrowserCosts } from "./browser-shards";
import { planPartitions, planRepetitions, repetitionsFor, selectPartition, type PartitionSubject } from "./determinism-plan";
import { BROWSER_DETERMINISM_PARTITIONS } from "./proof-shards";

/** One run of a spec: Vitest runs a file once in every project that includes it. */
export interface SpecPair { project: string; file: string; }
/** The key `scripts/browser-shard-costs.json` records a pair's weight under. */
export const pairKey = (pair: SpecPair): string => `${pair.project}::${pair.file}`;
export function parsePairKey(key: string): SpecPair {
  const match = /^([A-Za-z0-9][A-Za-z0-9-]*)::([A-Za-z0-9_@.-]+(?:\/[A-Za-z0-9_@.-]+)+)$/.exec(key);
  if (!match || match[2]!.split("/").some(part => part === ".." || part === ".")) throw new Error(`Expected <project>::<repository path of a spec>, received ${JSON.stringify(key)}`);
  return { project: match[1]!, file: match[2]! };
}
const comparePairs = (a: SpecPair, b: SpecPair) => pairKey(a) < pairKey(b) ? -1 : pairKey(a) > pairKey(b) ? 1 : 0;

/**
 * The specs the Vitest projects in `packages/ui-kit/vitest.config.ts` include,
 * without the one endurance spec: real-time media proof has its own job. A
 * helper beside a spec matches none of these and selects nothing.
 */
const SPEC_PATTERNS: readonly RegExp[] = [
  /^packages\/ui-kit\/tests\/visual\/(?:[^/]+\/)*[^/]+\.visual\.tsx$/,
  /^packages\/ui-kit\/stories\/(?:[^/]+\/)*[^/]+\.stories\.tsx$/,
  /^packages\/ui-react\/tests\/browser\/(?:[^/]+\/)*[^/]+\.(?:pointer|layout|offline)\.tsx$/,
];
export const isRepeatedSpec = (path: string): boolean => SPEC_PATTERNS.some(pattern => pattern.test(path));

/**
 * Each spec as the project/file pairs Vitest's own file listing reports for
 * it: three `rail-*` projects for a pointer spec, both themes for a story. A
 * spec that no project lists never runs, so repeating it would prove nothing:
 * it is refused here, before any runner starts.
 */
export function expandSpecs(files: readonly string[], listing: readonly SpecPair[]): SpecPair[] {
  const pairs: SpecPair[] = [];
  for (const file of [...new Set(files)].sort()) {
    if (!isRepeatedSpec(file)) throw new Error(`Not a browser, layout or story spec the gate repeats: ${file}`);
    const listed = listing.filter(spec => spec.file === file);
    if (!listed.length) throw new Error(`${file} is a changed spec that no Vitest project lists, so nothing runs it: add it to a project's include in packages/ui-kit/vitest.config.ts`);
    pairs.push(...listed.map(spec => ({ project: spec.project, file: spec.file })));
  }
  return pairs.sort(comparePairs);
}

export const DEFAULT_REPETITIONS = 5;
export const FLOOR_REPETITIONS = 2;
/** Five repetitions, and the floor of two at ready confirmation while the merge lease is held: the Bun gate's counts (#4137). */
export const browserRepetitionsFor = repetitionsFor;
/** Weighted seconds the repetitions may cost before they are reduced: one partition's capacity. */
export const BROWSER_BUDGET_SECONDS: number = BROWSER_DETERMINISM_PARTITIONS.capacitySeconds;
/** A pair without a reviewed weight is never free: an added spec has none until the table is refreshed. */
export const UNWEIGHTED_PAIR_SECONDS: number = BROWSER_DETERMINISM_PARTITIONS.unweightedSeconds;
const SUBJECT: PartitionSubject = { proof: "Repeated browser proof", units: "changed project/file pair(s)", unit: "pair", owner: "BROWSER_DETERMINISM_PARTITIONS" };

export interface PairRepetitions extends SpecPair { weightSeconds: number; weighted: boolean; repetitions: number; observed?: number; }
export interface BrowserRepetitionPlan {
  requested: number; floor: number; repetitions: number; reduced: boolean;
  budgetSeconds: number; weightSeconds: number; estimatedSeconds: number; overBudget: boolean;
  unweightedSeconds: number; pairs: PairRepetitions[];
}
export interface PlanOptions { repetitions?: number; budgetSeconds?: number; costs?: Readonly<Record<string, number>>; unweightedSeconds?: number; }

let recorded: Readonly<Record<string, number>> | undefined;
const reviewedCosts = () => recorded ??= readBrowserCosts().seconds;

function keysOf(pairs: readonly SpecPair[]): string[] {
  const keys = pairs.map(pair => pairKey(parsePairKey(pairKey(pair))));
  if (new Set(keys).size !== keys.length) throw new Error("A project/file pair was selected twice");
  return keys.sort();
}

/**
 * The same count for every pair: the most repetitions that fit the budget,
 * never more than requested and never fewer than the floor. A selection too
 * heavy for the floor still runs at the floor and is reported over budget.
 */
export function planBrowserRepetitions(pairs: readonly SpecPair[], options: PlanOptions = {}): BrowserRepetitionPlan {
  const unweightedSeconds = options.unweightedSeconds ?? UNWEIGHTED_PAIR_SECONDS;
  const { files, ...plan } = planRepetitions(keysOf(pairs), { repetitions: options.repetitions, budgetSeconds: options.budgetSeconds ?? BROWSER_BUDGET_SECONDS,
    costs: options.costs ?? reviewedCosts(), unweightedSeconds });
  return { ...plan, unweightedSeconds, pairs: files.map(({ file, ...entry }) => ({ ...parsePairKey(file), ...entry })) };
}

export interface BrowserPartition { pairs: SpecPair[]; weightSeconds: number; estimatedSeconds: number; }
export interface BrowserPartitionPlan extends BrowserRepetitionPlan { capacitySeconds: number; maxPartitions: number; partitions: BrowserPartition[]; }

/**
 * One job while the selection fits one job's capacity at its count; otherwise
 * the fewest partitions, balanced heaviest pair first, in which every
 * partition fits. Every pair is in exactly one partition, at the count decided
 * over the whole selection. A pair cannot be split, so one whose repetitions
 * alone exceed the capacity runs in a partition by itself. A selection that
 * needs more partitions than the maximum is refused: it is never skipped and
 * never reduced below the floor.
 */
export function planBrowserPartitions(pairs: readonly SpecPair[], options: Omit<PlanOptions, "budgetSeconds"> & { cadence?: string; capacitySeconds?: number; maxPartitions?: number } = {}): BrowserPartitionPlan {
  const unweightedSeconds = options.unweightedSeconds ?? UNWEIGHTED_PAIR_SECONDS;
  const { files, partitions, ...plan } = planPartitions(keysOf(pairs), { cadence: options.cadence, repetitions: options.repetitions,
    costs: options.costs ?? reviewedCosts(), unweightedSeconds, subject: SUBJECT,
    capacitySeconds: options.capacitySeconds ?? BROWSER_DETERMINISM_PARTITIONS.capacitySeconds, maxPartitions: options.maxPartitions ?? BROWSER_DETERMINISM_PARTITIONS.max });
  return { ...plan, unweightedSeconds, pairs: files.map(({ file, ...entry }) => ({ ...parsePairKey(file), ...entry })),
    partitions: partitions.map(partition => ({ pairs: partition.files.map(parsePairKey), weightSeconds: partition.weightSeconds, estimatedSeconds: partition.estimatedSeconds })) };
}

/** Partition `M/N` of the plan. `N` must be the planned count, so a matrix or a command that disagrees with the planner runs nothing. */
export function selectBrowserPartition(plan: BrowserPartitionPlan, shard: string): BrowserPartition {
  // The Bun gate's reader validates `M/N` against the planned count; the partition at `M` is this plan's.
  const keyed = plan.partitions.map(partition => ({ files: partition.pairs.map(pairKey), weightSeconds: partition.weightSeconds, estimatedSeconds: partition.estimatedSeconds }));
  return plan.partitions[keyed.indexOf(selectPartition({ ...plan, files: [], partitions: keyed }, shard))]!;
}
