/**
 * API surface snapshot.
 *
 * The checked-in reports under api-report/ are the reviewable artifact of each
 * package's public surface. This test regenerates them from the sources
 * (statically — nothing is imported) and fails on any drift, in either
 * direction: an export added or removed without regenerating the report, or a
 * report left behind for a package that is gone.
 *
 * On failure: review the change ON PURPOSE, then `bun run api-report`.
 */

import { describe, expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "fs";
import { join, resolve } from "path";
import { generateReports } from "../scripts/api-report";

const ROOT = resolve(import.meta.dir, "..");
const REPORT_DIR = join(ROOT, "api-report");

const reports = generateReports();

describe("api surface reports", () => {
  for (const [file, content] of reports) {
    test(`api-report/${file} matches the current exports`, () => {
      expect(
        existsSync(join(REPORT_DIR, file)),
        `api-report/${file} is missing — run \`bun run api-report\` and commit it`
      ).toBe(true);
      expect(readFileSync(join(REPORT_DIR, file), "utf8")).toBe(content);
    });
  }

  test("no report survives its package", () => {
    const stale = readdirSync(REPORT_DIR)
      .filter((f) => f.endsWith(".txt"))
      .filter((f) => !reports.has(f));
    expect(stale).toEqual([]);
  });
});
