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

const previous = process.env.SCRAPE_CHROME_PATH;

afterEach(() => {
  if (previous === undefined) delete process.env.SCRAPE_CHROME_PATH;
  else process.env.SCRAPE_CHROME_PATH = previous;
});

describe("a browser board on a host without Chrome", () => {
  test("reports an error naming the missing executable, not an empty result", async () => {
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
