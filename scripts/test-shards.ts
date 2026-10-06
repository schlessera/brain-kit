/**
 * CI's file partition. Costs include imports/hooks: median elapsed file time
 * on Ubuntu 24.04 with Bun 1.3.14 in #629 (runs 36710401927/36712389676,
 * source ac5741eb). Each file was measured in three different layouts.
 * The fixed-deadline suites added in #286 use weights from their five-second
 * waits and bounded cleanup budgets.
 * Chat focus includes its package-build/browser setup, measured in #765
 * on CI run 36874037551 (head d4771bb7, test shard 3): 121.627s.
 * External speech runtime builds packages and launches Chrome the same way:
 * 62.43s on Depot run h1hfj72q5h (test shard 2), recorded in #1003. The two
 * Claude follow-up suites are from the same PR's CI run (bzvr9l77k7).
 * Answer delivery's browser suite (#910) is a local measurement until CI
 * re-measures it: 87.54s, including its 35s Liveness B blackhole case.
 * Only files costing >=1s are recorded; this is a weight table, not an allowlist.
 * New/renamed tests are discovered on every run and receive the small-file cost.
 */
import { readdirSync } from "node:fs";
import { join } from "node:path";
import measuredCosts from "./test-shard-costs.json";

export const FILE_COST_SECONDS: Readonly<Record<string, number>> = measuredCosts;
const SMALL_FILE_SECONDS = 0.1;
const comparePaths = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

/** Bun 1.3.14 Scanner.zig's directory exclusions and test-name suffixes. */
export function discoverTests(cwd: string, roots: readonly string[]): string[] {
  const files: string[] = [];
  const visit = (dir: string) => {
    for (const entry of readdirSync(join(cwd, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) {
        if (!entry.name.startsWith(".") && entry.name.toLowerCase() !== "node_modules") visit(path);
      } else if (entry.isFile() && /(?:\.test|\.spec|_test|_spec)\.(?:[cm]?[jt]s|[jt]sx)$/i.test(entry.name)) {
        files.push(path);
      }
    }
  };
  for (const root of roots) visit(root);
  return files.sort(comparePaths);
}

/** Refuse an empty, duplicated, omitted or unexpected file assignment. */
export function assertPartition(files: readonly string[], shards: readonly (readonly string[])[]): void {
  const expected = new Set(files);
  const assigned = shards.flat();
  if (!files.length || !shards.length || expected.size !== files.length || shards.some((shard) => shard.length === 0) ||
      assigned.length !== files.length || new Set(assigned).size !== assigned.length ||
      assigned.some((file) => !expected.has(file))) {
    throw new Error("Test shards must be non-empty and cover every discovered file exactly once");
  }
}

/** Longest files first, placing each in the lightest shard; stable path ties. */
export function balanceTests(
  files: readonly string[], total: number,
  costs: Readonly<Record<string, number>> = FILE_COST_SECONDS,
): string[][] {
  if (!Number.isSafeInteger(total) || total < 1) throw new Error("Invalid test shard count");
  if (files.length < total) throw new Error("Test shards must be non-empty");
  const cost = (file: string) => costs[file] ?? SMALL_FILE_SECONDS;
  if (files.some((file) => !Number.isFinite(cost(file)) || cost(file) <= 0)) {
    throw new Error("Test file costs must be positive finite seconds");
  }
  const shards: string[][] = Array.from({ length: total }, () => []);
  const seconds = Array<number>(total).fill(0);
  const ordered = [...files].sort((a, b) => cost(b) - cost(a) || comparePaths(a, b));
  for (const file of ordered) {
    let lightest = 0;
    for (let i = 1; i < total; i++) {
      if (seconds[i]! < seconds[lightest]! ||
          (seconds[i] === seconds[lightest] && shards[i]!.length < shards[lightest]!.length)) lightest = i;
    }
    shards[lightest]!.push(file);
    seconds[lightest]! += cost(file);
  }
  assertPartition(files, shards);
  // Retain Bun's native alphabetical execution order within each process.
  return shards.map((shard) => shard.sort(comparePaths));
}

export function selectShard(cwd: string, roots: readonly string[], value: string): string[] {
  const match = /^([1-9]\d*)\/([1-9]\d*)$/.exec(value);
  if (!match) throw new Error("Expected --balanced-shard=M/N (1 <= M <= N)");
  const index = Number(match[1]), total = Number(match[2]);
  if (!Number.isSafeInteger(index) || !Number.isSafeInteger(total) || index > total) {
    throw new Error("Expected --balanced-shard=M/N (1 <= M <= N)");
  }
  const files = discoverTests(cwd, roots);
  const selected = balanceTests(files, total)[index - 1]!;
  const seconds = selected.reduce((sum, file) => sum + (FILE_COST_SECONDS[file] ?? SMALL_FILE_SECONDS), 0);
  console.error(`Balanced shard ${value}: ${selected.length}/${files.length} files, estimated ${seconds.toFixed(1)}s`);
  return selected.map((file) => `./${file}`);
}
