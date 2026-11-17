/**
 * Repetition and partition planning for the hosted `determinism` job (#4109, #4117).
 *
 * Pure: the planner (scripts/ci-plan.ts), each partition's command
 * (scripts/ci-proof.ts) and the runner (scripts/test-determinism.ts) read these
 * functions, so they cannot disagree about the repetition count or about which
 * partition runs a file. The count is decided first, over the whole selection;
 * the selection is then partitioned for that count.
 * Policy: docs/decisions/ci-utility.md, "Changed tests repeat under load before merge".
 */
import { DETERMINISM_PARTITIONS } from "./proof-shards";
import { balanceTests, FILE_COST_SECONDS } from "./test-shards";

export const DEFAULT_REPETITIONS = 5;
export const FLOOR_REPETITIONS = 2;
/**
 * Ready confirmation runs the floor (#4137, maintainer ruling 2026-11-17). The
 * merge lease is held while it runs, and the draft head already ran the full
 * count; the floor re-checks the tree that merges without making this job the
 * confirmation's longest. Undefined keeps the command's default.
 */
export function repetitionsFor(cadence: string | undefined): number | undefined {
  return cadence === "confirmation" ? FLOOR_REPETITIONS : undefined;
}
/**
 * Reviewed-weight seconds the repetitions may cost before they are reduced:
 * one partition's capacity (#4117), so a selection is split only at the floor.
 */
export const BUDGET_SECONDS: number = DETERMINISM_PARTITIONS.capacitySeconds;
/** A file without a reviewed weight costs the small-file default (scripts/test-shards.ts). */
const UNWEIGHTED_SECONDS = 0.1;

export interface FileRepetitions { file: string; weightSeconds: number; weighted: boolean; repetitions: number; observed?: number; }
export interface RepetitionPlan {
  requested: number; floor: number; repetitions: number; reduced: boolean;
  budgetSeconds: number; weightSeconds: number; estimatedSeconds: number; overBudget: boolean;
  files: FileRepetitions[];
}

/**
 * The same count for every file: the most repetitions that fit the budget,
 * never more than requested and never fewer than the floor. A selection too
 * heavy for the floor still runs at the floor and is reported over budget.
 */
export function planRepetitions(files: readonly string[], options: { repetitions?: number; floor?: number; budgetSeconds?: number;
  costs?: Readonly<Record<string, number>>; unweightedSeconds?: number } = {}): RepetitionPlan {
  const requested = options.repetitions ?? DEFAULT_REPETITIONS, floor = options.floor ?? FLOOR_REPETITIONS;
  const budgetSeconds = options.budgetSeconds ?? BUDGET_SECONDS, costs = options.costs ?? FILE_COST_SECONDS;
  const unweightedSeconds = options.unweightedSeconds ?? UNWEIGHTED_SECONDS;
  if (!Number.isSafeInteger(floor) || floor < 2) throw new Error("The repetition floor is at least two: one run proves nothing about the next");
  if (!Number.isSafeInteger(requested) || requested < floor) throw new Error(`Repetitions must be an integer of at least ${floor}`);
  if (!Number.isFinite(budgetSeconds) || budgetSeconds <= 0) throw new Error("The time budget must be positive seconds");
  if (new Set(files).size !== files.length) throw new Error("A test file was selected twice");
  const weights = files.map(file => {
    const weighted = Object.hasOwn(costs, file), weightSeconds = weighted ? costs[file]! : unweightedSeconds;
    if (!Number.isFinite(weightSeconds) || weightSeconds <= 0) throw new Error(`Test file costs must be positive finite seconds: ${file}`);
    return { file, weightSeconds, weighted };
  });
  const weightSeconds = weights.reduce((sum, entry) => sum + entry.weightSeconds, 0);
  const fit = weightSeconds > 0 ? Math.floor(budgetSeconds / weightSeconds) : requested;
  const repetitions = Math.max(floor, Math.min(requested, fit));
  const estimatedSeconds = weightSeconds * repetitions;
  return { requested, floor, repetitions, reduced: repetitions < requested, budgetSeconds, weightSeconds, estimatedSeconds,
    overBudget: estimatedSeconds > budgetSeconds, files: weights.map(entry => ({ ...entry, repetitions })) };
}

/** What a planner repeats, for its refusals: the Bun gate's files, or another gate's units (#4163). */
export interface PartitionSubject { proof: string; units: string; unit: string; owner: string; }
const BUN_FILES: PartitionSubject = { proof: "Repeated-run proof", units: "changed Bun test file(s)", unit: "file", owner: "DETERMINISM_PARTITIONS" };

export interface DeterminismPartition { files: string[]; weightSeconds: number; estimatedSeconds: number; }
export interface PartitionPlan extends RepetitionPlan { capacitySeconds: number; maxPartitions: number; partitions: DeterminismPartition[]; }

/**
 * One job while the selection fits one job's capacity at its count; otherwise
 * the fewest partitions, balanced longest file first, in which every partition
 * fits (#4117). A file cannot be split, so one whose repetitions alone exceed
 * the capacity runs in a partition by itself. Every file is in exactly one
 * partition, at the count decided over the whole selection. A selection that
 * needs more partitions than the maximum is refused: it is never skipped and
 * never reduced below the floor.
 */
export function planPartitions(files: readonly string[], options: { cadence?: string; repetitions?: number;
  costs?: Readonly<Record<string, number>>; capacitySeconds?: number; maxPartitions?: number; unweightedSeconds?: number;
  subject?: PartitionSubject } = {}): PartitionPlan {
  const capacitySeconds = options.capacitySeconds ?? DETERMINISM_PARTITIONS.capacitySeconds;
  const maxPartitions = options.maxPartitions ?? DETERMINISM_PARTITIONS.max, subject = options.subject ?? BUN_FILES;
  if (!Number.isSafeInteger(maxPartitions) || maxPartitions < 1) throw new Error("The maximum partition count is a positive integer");
  if (!files.length) throw new Error(`${subject.proof} was not selected`);
  const plan = planRepetitions([...files].sort(), { repetitions: options.repetitions ?? repetitionsFor(options.cadence),
    budgetSeconds: capacitySeconds, costs: options.costs, unweightedSeconds: options.unweightedSeconds });
  const weights = Object.fromEntries(plan.files.map(entry => [entry.file, entry.weightSeconds]));
  const names = plan.files.map(entry => entry.file);
  for (let count = 1; count <= Math.min(maxPartitions, names.length); count++) {
    const partitions = balanceTests(names, count, weights).map(partition => {
      const weightSeconds = partition.reduce((sum, file) => sum + weights[file]!, 0);
      return { files: partition, weightSeconds, estimatedSeconds: weightSeconds * plan.repetitions };
    });
    if (partitions.every(partition => partition.estimatedSeconds <= capacitySeconds || partition.files.length === 1))
      return { ...plan, capacitySeconds, maxPartitions, partitions };
  }
  throw new Error(`${subject.proof} refused before it ran: ${names.length} ${subject.units} weigh ${plan.weightSeconds.toFixed(1)} weighted s per pass, ` +
    `${plan.estimatedSeconds.toFixed(1)} s at the floor of ${plan.repetitions} repetitions. That needs more than the limit of ${maxPartitions} partitions ` +
    `of ${capacitySeconds} weighted s each (${subject.owner}, scripts/proof-shards.ts). No ${subject.unit} is skipped and the count stays at the floor: split the change.`);
}

/** Partition `M/N` of the plan. `N` must be the planned count, so a matrix or a command that disagrees with the planner runs nothing. */
export function selectPartition(plan: PartitionPlan, shard: string): DeterminismPartition {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(shard);
  if (!match) throw new Error("Expected proof --shard=M/N");
  const index = Number(match[1]), total = Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index > total) throw new Error("Invalid proof shard");
  if (total !== plan.partitions.length) throw new Error(`Repeated-run partition ${shard} is not in the planned set of ${plan.partitions.length}`);
  return plan.partitions[index - 1]!;
}
