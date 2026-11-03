// Release check: every `file:line` citation under docs/ holds or is explained.
//
// A line number does not fail loudly when code moves under it; it comes to
// name the neighbouring code. `voice-permission.md` was written with 36 exact
// citations and eleven days later 16 had drifted. One PR that inserted a log
// block above `case "tool_denial"` turned a citation of the denial arm into one
// of the approval arm, the opposite of the claim.
//
// Merges do not fail on drift (maintainer ruling, 2026-11-03): any PR that moves
// lines in a cited file drifts some other PR's citations, and failing the
// merge queue on it turned main red for documentation alone. The experiment
// tier runs this file before every publish, so a release never ships a drifted
// record. Repair drift with the report: `bun scripts/check-citations.ts`. The
// checker's own rules are tested in tests/decision-citations.test.ts.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  checkRecords,
  describe as describeReport,
  exceptionMismatches,
  failing,
  ROOT,
} from "../scripts/check-citations.ts";

describe("all documentation at release", () => {
  const reports = checkRecords();

  test("every citation names its anchor, or is a listed exception", () => {
    expect(reports.filter(failing).map(describeReport)).toEqual([]);
  });

  test("every listed exception covers exactly the citations it declares", () => {
    // Stale (the citation was anchored or reworded) or borrowed (a second
    // identical citation inherits a reason written for the first) both fail.
    expect(exceptionMismatches(reports)).toEqual([]);
  });

  test("the convention's own example is a citation that holds", () => {
    // The example was written right and went stale within a day, when #230
    // inserted a line above `enforcementHook`. It is checked like any other.
    for (const file of ["AGENTS.md", "docs/decisions/README.md", "scripts/check-citations.ts"]) {
      const text = readFileSync(join(ROOT, file), "utf8");
      const example = text.match(/\(`enforcementHook`, `[^`]+`\)/)?.[0];
      expect({ file, found: Boolean(example) }).toEqual({ file, found: true });
      const [report] = checkRecords([{ doc: file, body: example! }], undefined, {});
      expect({ file, verdict: report.verdict.kind }).toEqual({ file, verdict: "anchored" });
    }
  });

  test("the check reads the records at all", () => {
    expect(reports.filter((report) => report.verdict.kind === "anchored").length).toBeGreaterThan(100);
  });
});
