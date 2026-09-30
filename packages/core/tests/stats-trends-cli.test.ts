import { afterEach, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";
import { STATS_HISTORY_FILE } from "../src/lib/stats-history";
import { readStatsTrends } from "../src/lib/stats-trends";

const roots: string[] = [];
afterEach(() => { while (roots.length) cleanup(roots.pop()!); });

test("real stats, history, briefing and maintain reuse nonempty core verdicts; evaluation never writes history", async () => {
  const root = makeTempBrain(); roots.push(root);
  expect((await runCli(root, ["index", "--json"])).code).toBe(0);
  const now = new Date();
  const midnight = Date.parse(now.toISOString().slice(0, 10) + "T00:00:00Z");
  const rows = Array.from({ length: 14 }, (_, i) => {
    const date = new Date(midnight + (i - 13) * 86_400_000).toISOString().slice(0, 10);
    return { date, at: date + "T00:00:00.000Z", version: "0.40.0", links: 100, brokenLinks: i < 7 ? 0 : 10,
      health: { embeddingCoverage: i < 7 ? 1 : 0.7, brokenLinkRate: i < 7 ? 0 : 0.1, orphans: i < 7 ? 10 : 15 } };
  });
  const path = join(root, STATS_HISTORY_FILE);
  const original = rows.map(r => JSON.stringify(r)).join("\n") + "\n";
  writeFileSync(path, original);
  const expected = readStatsTrends(root, { coverageFloor: 0.9, brokenLinkCeiling: 0.05 }, now).verdicts;
  expect(expected).toHaveLength(3);
  expect(expected.every(v => v.state === "warning")).toBe(true);
  for (const command of [["stats", "--json"], ["stats", "--history", "--since", rows[13].date, "--json"]]) {
    const result = await runCli(root, command);
    expect(result.code, result.stderr).toBe(0);
    const value = JSON.parse(result.stdout);
    expect(value.trends.verdicts).toEqual(expected);
    if (command.includes("--history")) expect(value.dates).toEqual([rows[13].date]);
    expect(readFileSync(path, "utf8")).toBe(original);
  }
  for (const command of [["stats"], ["briefing"]]) {
    const result = await runCli(root, command);
    expect(result.code, result.stderr).toBe(0);
    for (const v of expected) expect(result.stdout).toContain(v.message);
    expect(readFileSync(path, "utf8")).toBe(original);
  }
  const maintain = await runCli(root, ["maintain", "--no-git", "--json"]);
  expect(maintain.code, maintain.stderr).toBe(0);
  const stats = JSON.parse(maintain.stdout).find((r: { step: string }) => r.step === "stats");
  expect(stats.trends.verdicts).toEqual(expected);
  expect(stats.result).toStartWith("ok — replaced");
  const recorded = readFileSync(path, "utf8").trim().split("\n").map(r => JSON.parse(r));
  expect(recorded).toHaveLength(14);
  expect(recorded.at(-1)).not.toHaveProperty("trends");
  expect(recorded.slice(0, 13)).toEqual(rows.slice(0, 13));
}, 120_000);

test("no history is an explicit insufficient verdict with no briefing warnings or new file", async () => {
  const root = makeTempBrain(); roots.push(root);
  expect((await runCli(root, ["index", "--json"])).code).toBe(0);
  const result = await runCli(root, ["stats", "--json"]);
  expect(result.code).toBe(0);
  const { trends } = JSON.parse(result.stdout);
  expect(trends.verdicts).toHaveLength(3);
  expect(trends.verdicts.every((v: { state: string }) => v.state === "insufficient")).toBe(true);
  expect((await runCli(root, ["briefing"])).stdout).not.toContain("Initial policy thresholds");
  expect(existsSync(join(root, STATS_HISTORY_FILE))).toBe(false);
});
