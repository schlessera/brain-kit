/**
 * API surface snapshot.
 *
 * The checked-in reports under api-report/ are the reviewable artifact of each
 * package's public surface. This test regenerates them from the sources
 * (statically — nothing is imported) and fails on any drift, in either
 * direction: an export added or removed without regenerating the report, a
 * seam declaration (or a type it is made of) whose signature changed, or a
 * report left behind for a package that is gone.
 *
 * On failure: review the change ON PURPOSE, then `bun run api-report`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { generateReports, SIGNATURES_HEADING } from "../scripts/api-report";

const ROOT = resolve(import.meta.dir, "..");
const REPORT_DIR = join(ROOT, "api-report");

const reports = generateReports();

/** A report's export names and its signature section, apart. */
function sections(report: string): { names: string; signatures: string } {
  const at = report.indexOf(`\n${SIGNATURES_HEADING}\n`);
  return at === -1
    ? { names: report, signatures: "" }
    : { names: report.slice(0, at), signatures: report.slice(at) };
}

describe("api surface reports", () => {
  for (const [file, content] of reports) {
    const expected = sections(content);
    const checkedIn = () => {
      expect(
        existsSync(join(REPORT_DIR, file)),
        `api-report/${file} is missing — run \`bun run api-report\` and commit it`
      ).toBe(true);
      return sections(readFileSync(join(REPORT_DIR, file), "utf8"));
    };

    test(`api-report/${file} matches the current exports`, () => {
      expect(checkedIn().names).toBe(expected.names);
    });

    if (expected.signatures) {
      test(`api-report/${file} matches the current seam signatures`, () => {
        expect(checkedIn().signatures).toBe(expected.signatures);
      });
    }
  }

  test("the frozen set is recorded where it is expected", () => {
    // A signature section that silently came out empty would pass the test
    // above for every retype.
    const withSignatures = [...reports]
      .filter(([, content]) => sections(content).signatures !== "")
      .map(([file]) => file)
      .sort();
    expect(withSignatures).toEqual(["core.txt", "scrape.txt", "ui-sdk.txt"]);
    expect(sections(reports.get("scrape.txt")!).signatures).toContain(
      "scrape(ctx: ScrapeContext, options: AdapterRunOptions): Promise<AdapterResult<T>>;"
    );
  });

  test("no report survives its package", () => {
    const stale = readdirSync(REPORT_DIR)
      .filter((f) => f.endsWith(".txt"))
      .filter((f) => !reports.has(f));
    expect(stale).toEqual([]);
  });
});
