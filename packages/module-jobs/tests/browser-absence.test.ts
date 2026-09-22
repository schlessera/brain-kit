/**
 * What a run reports when the host has no Chrome.
 *
 * One of the four cross-cutting claims #33 had to re-measure: PR #2 reported
 * that a missing browser was indistinguishable from an empty browser result.
 * It is distinguishable today — but NOT by the mechanism the epic credits.
 * `createBrowserSession` launches lazily and never throws at construction, so
 * the try/catch around it in `src/scrape.ts` can never fire and the string
 * "Browser boards unavailable" is unreachable. The failure surfaces one error
 * per URL from inside the adapter instead.
 *
 * Keyless and offline: Chrome is never found, so nothing is ever navigated.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { runScrape } from "../src/scrape";

// Three variables decide where a browser comes from, and two of them WIN over
// the executable path: `runScrape` prefers an already-running Chrome at
// SCRAPE_CHROME_URL, falling back to the legacy CHROME_CDP_URL. Leaving either
// set on a developer's machine would have this test attach to a real browser
// and scrape BuiltIn for real, which the keyless rule forbids outright.
const BROWSER_VARS = ["SCRAPE_CHROME_PATH", "SCRAPE_CHROME_URL", "CHROME_CDP_URL"] as const;
const previous = Object.fromEntries(BROWSER_VARS.map((name) => [name, process.env[name]]));

afterEach(() => {
  for (const name of BROWSER_VARS) {
    const value = previous[name];
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
});

describe("a browser board on a host without Chrome", () => {
  test("reports an error naming the missing executable, not an empty result", async () => {
    delete process.env.SCRAPE_CHROME_URL;
    delete process.env.CHROME_CDP_URL;
    process.env.SCRAPE_CHROME_PATH = join(tmpdir(), "no-such-chrome-for-tests");
    const dir = mkdtempSync(join(tmpdir(), "brain-jobs-nochrome-"));
    try {
      const report = await runScrape({
        dbPath: join(dir, "jobs.db"),
        sources: ["builtin"],
        incremental: false,
        dryRun: true,
      });

      const board = report.sources[0];
      expect(board.source).toBe("builtin");
      expect(board.jobs_found).toBe(0);
      // Three pages, three errors: the board cannot be mistaken for one that
      // simply had no jobs today.
      expect(board.errors).toHaveLength(3);
      for (const error of board.errors) {
        expect(error).toContain("Chrome executable not found");
      }
      // ... and the path the epic credits with reporting this is dead code.
      expect(report.total_errors.join("\n")).not.toContain("Browser boards unavailable");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
