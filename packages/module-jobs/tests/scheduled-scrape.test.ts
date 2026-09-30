import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BROWSER_SOURCES, DISABLED_BY_DEFAULT, SOURCES } from "../src/types.js";

for (const boards of [["remoteok"], ["remoteok", "builtin"]]) {
  test(`scheduled scrape selects only configured boards: ${boards.join(", ")}`, async () => {
    // The subset must expose both overrides: an extra ordinary board for
    // --all, and omitted browser boards for --browser.
    expect(boards.length).toBeGreaterThan(0);
    expect(SOURCES.some((source) => !boards.includes(source))).toBe(true);
    expect(BROWSER_SOURCES.some((source) => !boards.includes(source))).toBe(true);
    expect(Object.keys(DISABLED_BY_DEFAULT).some((source) => !boards.includes(source))).toBe(true);
    const root = mkdtempSync(join(tmpdir(), "jobs-scheduled-selection-"));
    try {
      const child = Bun.spawn([
        "bun", join(import.meta.dir, "helpers/scheduled-scrape-runner.ts"), root, JSON.stringify(boards),
      ], { stdout: "pipe", stderr: "pipe" });
      const [stdout, stderr, code] = await Promise.all([
        new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
      ]);
      expect(stderr).toBe("");
      expect(code).toBe(0);
      const result = JSON.parse(stdout);
      // Keep the behavioral assertion before the literal command check so
      // either override mutation fails for adding sources, not for its text.
      expect(result.report.sources.map((entry: { source: string }) => entry.source)).toEqual(boards);
      expect(result.observed.map((entry: { source: string }) => entry.source)).toEqual(boards);
      expect(result.code).toBe(0);
      expect(result.command).toBe("jobs scrape");
      expect(result.schedule).toBe("0 6 * * *");
      expect(result.fetchCalls).toBe(0);
      expect(result.spawnCalls).toBe(0);
      if (boards.includes("builtin")) {
        expect(result.observed.find((entry: { source: string }) => entry.source === "builtin"))
          .toEqual({ source: "builtin", needsBrowser: true, hasBrowser: true });
      } else {
        expect(result.observed).toEqual([{ source: "remoteok", needsBrowser: false, hasBrowser: false }]);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
}
