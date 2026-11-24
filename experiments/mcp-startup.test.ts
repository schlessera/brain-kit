import { expect, test } from "bun:test";
import { join } from "node:path";
import coreManifest from "../packages/core/package.json" with { type: "json" };

test("one indexed corpus yields cold and warm MCP startup distributions and quiet protocol frames", async () => {
  const run = Bun.spawnSync([process.execPath, join(import.meta.dir, "../scripts/measure-mcp-startup.ts"), "--repetitions", "1", "--json", "--verify-quiet"]);
  expect(run.exitCode, run.stderr.toString()).toBe(0);
  const result = JSON.parse(run.stdout.toString());
  expect(result.entry).toBe(coreManifest.bin.brain);
  expect(result.repetitions).toBe(1);
  for (const group of [result.cold, result.warm]) {
    expect(Object.keys(group).sort()).toEqual(["connect", "context", "database", "exitMs", "import", "initializeMs", "moduleTools", "toolsListMs", "vector"]);
    for (const stat of Object.values<{ median: number; p90: number; max: number }>(group)) {
      expect(stat.median).toBeGreaterThanOrEqual(0);
      expect(stat).toEqual({ median: stat.median, p90: stat.median, max: stat.median });
    }
  }
});
