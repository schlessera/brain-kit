/** Offline deterministic browser partition; measured costs are weights, never an allowlist. */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { resolve } from "node:path";

export interface BrowserSpec { key: string; project: string; }
export interface BrowserCosts { seconds: Record<string, number>; }
export const UNKNOWN_BROWSER_SECONDS = 1;
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;

export function readBrowserCosts(path = fileURLToPath(new URL("./browser-shard-costs.json", import.meta.url))): BrowserCosts {
  const value = JSON.parse(readFileSync(path, "utf8")) as BrowserCosts;
  if (!value.seconds || !Object.keys(value.seconds).length || Object.values(value.seconds).some(cost => !Number.isFinite(cost) || cost <= 0)) throw new Error("Browser costs must be a nonempty positive finite seconds table");
  return value;
}

export function assertBrowserPartition(specs: readonly BrowserSpec[], shards: readonly (readonly BrowserSpec[])[]): void {
  const expected = new Set(specs.map(spec => spec.key));
  const keys = shards.flat().map(spec => spec.key);
  if (!specs.length || expected.size !== specs.length || !shards.length || shards.some(shard => !shard.length) ||
      keys.length !== specs.length || new Set(keys).size !== keys.length || keys.some(key => !expected.has(key))) throw new Error("Browser shards must cover every project/file spec exactly once");
}

export function balanceBrowserSpecs<T extends BrowserSpec>(specs: readonly T[], count: number, costs: BrowserCosts): T[][] {
  if (!Number.isSafeInteger(count) || count < 1 || specs.length < count) throw new Error("Invalid browser shard count");
  if (!costs.seconds || !Object.keys(costs.seconds).length || Object.values(costs.seconds).some(cost => !Number.isFinite(cost) || cost <= 0)) throw new Error("Browser costs must be a nonempty positive finite seconds table");
  const shards: T[][] = Array.from({ length: count }, () => []);
  const totals = Array<number>(count).fill(0);
  const projects = Array.from({ length: count }, () => new Map<string, number>());
  const weight = (spec: BrowserSpec) => costs.seconds[spec.key] ?? UNKNOWN_BROWSER_SECONDS;
  for (const spec of [...specs].sort((a, b) => weight(b) - weight(a) || compare(a.key, b.key))) {
    // Each browser project runs one file at a time. Balance its critical path,
    // then total runner work, without increasing per-project contention.
    const peak = (index: number) => Math.max(...projects[index]!.values(),
      (projects[index]!.get(spec.project) ?? 0) + weight(spec));
    let target = 0;
    for (let i = 1; i < count; i++) if (peak(i) < peak(target) ||
        (peak(i) === peak(target) && (totals[i]! < totals[target]! ||
          (totals[i] === totals[target] && shards[i]!.length < shards[target]!.length)))) target = i;
    shards[target]!.push(spec); totals[target]! += weight(spec);
    projects[target]!.set(spec.project, (projects[target]!.get(spec.project) ?? 0) + weight(spec));
  }
  assertBrowserPartition(specs, shards);
  return shards.map(shard => shard.sort((a, b) => compare(a.key, b.key)));
}

/** Recorded Vitest reports contain each reported project/file elapsed time. */
export function browserCostsFromLogs(logs: readonly string[]): Record<string, number> {
  const observations = new Map<string, number[]>();
  for (const raw of logs) {
    const text = raw.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
    for (const match of text.matchAll(/✓\s+([^ ]+) \(chromium\)\s+(.+?) \([^\n]*?tests[^\n]*?\)\s+(\d+)ms/g)) {
      const file = resolve("/repo/packages/ui-kit", match[2]!).slice("/repo/".length);
      const key = `${match[1]}::${file}`;
      const cost = Number(match[3]) / 1000;
      if (!Number.isFinite(cost) || cost < 0) throw new Error("Invalid recorded browser cost");
      if (cost === 0) continue; // The documented positive unknown default covers sub-millisecond files.
      observations.set(key, [...(observations.get(key) ?? []), cost]);
    }
  }
  if (!observations.size) throw new Error("Recorded logs contain no nonempty browser timing evidence");
  return Object.fromEntries([...observations.entries()].sort(([a], [b]) => compare(a, b)).map(([key, values]) => {
    const sorted = values.sort((a, b) => a - b); const mid = Math.floor(sorted.length / 2);
    return [key, sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2];
  }));
}
