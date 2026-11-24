import { expect, test } from "bun:test";
import { measureMcpStartup } from "../scripts/measure-mcp-startup.js";

test("one indexed corpus yields cold and warm MCP startup distributions and quiet protocol frames", async () => {
  const result = await measureMcpStartup(1, true);
  expect(result.repetitions).toBe(1);
  for (const group of [result.cold, result.warm]) {
    expect(Object.keys(group).sort()).toEqual(["connect", "context", "database", "exitMs", "import", "initializeMs", "moduleTools", "toolsListMs", "vector"]);
    for (const stat of Object.values(group)) {
      expect(stat.median).toBeGreaterThanOrEqual(0);
      expect(stat).toEqual({ median: stat.median, p90: stat.median, max: stat.median });
    }
  }
});
