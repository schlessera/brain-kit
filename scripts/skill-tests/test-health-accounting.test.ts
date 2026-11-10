import { describe, expect, test } from "bun:test";
import { declaredFor, reportsCases, runtimeAccounting, staticAccounting, type CaseSummary, type Declared } from "../test-health/accounting";
import type { Finding } from "../test-health/worksheet";

const OARS = "packages/ithaca/tests/oars.test.ts";
const none: Declared = { removes: [], renames: [], removedCases: 0 };
const pass = (name: string, assertions = 1): CaseSummary => ({ name, state: "passed", assertions });

describe("declarations that disappear", () => {
  test("nothing gone, nothing to account for, and added tests are free", () => {
    expect(staticAccounting(["rows", "sails"], ["rows", "sails", "lands"], none)).toEqual({ before: 2, after: 3, gone: [], problems: [] });
  });

  test("each missing title needs its own declaration, even when two share a name", () => {
    const twice = staticAccounting(["rows", "rows", "sails"], ["sails"], { ...none, removes: ["rows"] });
    expect([twice.gone, twice.problems]).toEqual([["rows", "rows"], ['1 test(s) disappeared without being declared: "rows"']]);
    expect(staticAccounting(["rows", "rows", "sails"], ["sails"], { ...none, removes: ["rows", "rows"] }).problems).toEqual([]);
  });

  test("replacing one test with another is a removal unless it is declared as a rename", () => {
    expect(staticAccounting(["works"], ["counts the oars"], none).problems).toEqual(['1 test(s) disappeared without being declared: "works"']);
    expect(staticAccounting(["works"], ["counts the oars"], { ...none, renames: [{ from: "works", to: "counts the oars" }] }).problems).toEqual([]);
  });

  test("a declaration must match what happened", () => {
    expect(staticAccounting(["rows"], ["rows"], { ...none, removes: ["rows"] }).problems).toEqual(['declared as removed or renamed but still present: "rows"']);
    expect(staticAccounting(["works"], ["rows"], { ...none, renames: [{ from: "works", to: "sails" }] }).problems)
      .toEqual(['renamed to a title that does not exist after the change: "sails"']);
  });
});

describe("executed cases that disappear", () => {
  test("the same cases with the same assertions pass, and the totals are kept", () => {
    expect(runtimeAccounting([pass("rows", 2), pass("sails")], [pass("rows", 3), pass("sails")], 0))
      .toEqual({ casesBefore: 2, casesAfter: 2, assertionsBefore: 3, assertionsAfter: 4, problems: [] });
  });

  test("a shortened table loses cases the source never shows, and only the declared number may go", () => {
    const before = [pass("leg 1"), pass("leg 2"), pass("leg 3")];
    expect(runtimeAccounting(before, [pass("leg 1")], 1).problems).toEqual(["2 executed case(s) fewer than before, and the findings declare 1"]);
    expect(runtimeAccounting(before, [pass("leg 1")], 2).problems).toEqual([]);
  });

  test("a case that stops passing counts as lost", () => {
    expect(runtimeAccounting([pass("rows")], [{ name: "rows", state: "failed", assertions: 1 }], 0).problems).toEqual(["1 executed case(s) fewer than before, and the findings declare 0"]);
  });

  test("a case that now passes without asserting, or is now skipped, is refused even when the count holds", () => {
    expect(runtimeAccounting([pass("rows", 2)], [pass("rows", 0)], 0).problems).toEqual(['now pass without executing an assertion: "rows"']);
    expect(runtimeAccounting([pass("rows"), pass("sails")], [pass("rows"), { name: "sails", state: "skipped", assertions: 0 }, pass("lands")], 0).problems)
      .toEqual(['ran before and are skipped now: "sails"']);
    // A case that never asserted is the cannot-fail lens's business, not a loss.
    expect(runtimeAccounting([pass("rows", 0)], [pass("rows", 0)], 0).problems).toEqual([]);
  });
});

describe("what the findings declare", () => {
  const finding = (overrides: Partial<Finding>): Finding =>
    ({ id: "F1", file: OARS, lens: "overlap", smell: "duplicate-case", action: "remove", status: "fixed", note: "duplicate", ...overrides });

  test("only fixed reducing findings on the file declare removals; the executed count defaults to the named tests", () => {
    expect(declaredFor(OARS, [
      finding({ evidence: { removes: ["rows", "sails"] } }),
      finding({ id: "F2", action: "move-tier", evidence: { removes: ["leg %d"], removedCases: 3 } }),
      finding({ id: "F3", status: "deferred", evidence: { removes: ["lands"] } }),
      finding({ id: "F4", file: "packages/ithaca/tests/sails.test.ts", evidence: { removes: ["reefs"] } }),
      finding({ id: "F5", lens: "hygiene", smell: "unclear-name", action: "cleanup", evidence: { renames: [{ from: "works", to: "counts" }] } }),
    ])).toEqual({ removes: ["rows", "sails", "leg %d"], renames: [{ from: "works", to: "counts" }], removedCases: 5 });
  });

  test("Bun test files report their cases; browser files do not", () => {
    expect([OARS, "tests/ship.spec.tsx", "packages/ithaca/tests/browser/harbour.layout.tsx", "packages/ithaca/stories/Oar.stories.tsx"].map(reportsCases)).toEqual([true, true, false, false]);
  });
});
