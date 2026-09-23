// The decision records' `file:line` citations still point at their anchors.
//
// A line number does not fail loudly when code moves under it — it comes to
// name the neighbouring code. `voice-permission.md` was written with 36 exact
// citations and eleven days later 16 had drifted; a single PR that inserted a
// log block above `case "tool_denial"` turned a citation of the denial arm into
// one of the approval arm, the opposite of the claim. This test is what makes
// that a red build instead of a confidently wrong record. The convention it
// enforces is in `docs/decisions/README.md`; the checker is
// `scripts/check-citations.ts`, which also runs on its own as a report.

import { describe, expect, test } from "bun:test";
import { readFileSync } from "fs";
import { join } from "path";
import {
  checkRecords,
  describe as describeReport,
  exceptionMismatches,
  parseCitations,
  ROOT,
  type Tree,
} from "../scripts/check-citations.ts";

/** An in-memory tree, so the rules are exercised without touching real files. */
function tree(files: Record<string, string>): Tree {
  return { files: Object.keys(files), lines: (file) => files[file].split("\n") };
}

const SOURCE = [
  "// header",
  "export function enforcementHook() {",
  '  return "ask";',
  "}",
  "",
  "export function mutatingHook() {}",
].join("\n");

function check(record: string, files: Record<string, string> = { "src/hooks.ts": SOURCE }) {
  return checkRecords([{ doc: "docs/decisions/x.md", body: record }], tree(files), {});
}

describe("the decision records", () => {
  const reports = checkRecords();

  test("every citation names its anchor, or is a listed exception", () => {
    const failing = reports
      .filter((report) => report.verdict.kind !== "anchored" && !report.exception)
      .map(describeReport);
    expect(failing).toEqual([]);
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
    // A parser that found nothing would pass the first test trivially.
    expect(reports.filter((report) => report.verdict.kind === "anchored").length).toBeGreaterThan(
      100,
    );
  });
});

describe("an anchored citation", () => {
  test("passes while its range starts on the anchor", () => {
    const [report] = check("(`enforcementHook`, `src/hooks.ts:2-4`)");
    expect(report.verdict.kind).toBe("anchored");
  });

  test("goes red when a blank line is inserted above the cited symbol", () => {
    const shifted = SOURCE.replace("export function enforcementHook", "\nexport function enforcementHook");
    const [report] = check("(`enforcementHook`, `src/hooks.ts:2-4`)", { "src/hooks.ts": shifted });
    expect(report.verdict).toEqual({
      kind: "drifted",
      file: "src/hooks.ts",
      range: "2-4",
      found: [3],
    });
    // The message says where the anchor went, which is the whole point of
    // naming it.
    expect(describeReport(report)).toContain("it is at line 3");
  });

  test("goes red when the range starts inside the symbol rather than on it", () => {
    const [report] = check("(`enforcementHook`, `src/hooks.ts:3-4`)");
    expect(report.verdict.kind).toBe("drifted");
  });

  test("checks every range of a list against the same anchor", () => {
    const [report] = check("(`export function`, `src/hooks.ts:2,6`)");
    expect(report.verdict.kind).toBe("anchored");
    const [broken] = check("(`export function`, `src/hooks.ts:2,5`)");
    expect(broken.verdict.kind).toBe("drifted");
  });

  test("a bare `:line` continues the file cited before it", () => {
    const reports = check("(`enforcementHook`, `src/hooks.ts:2`) and (`mutatingHook`, `:6`)");
    expect(reports.map((report) => report.verdict.kind)).toEqual(["anchored", "anchored"]);
  });

  test("a span wrapped onto the next line is still one span", () => {
    // The newline is INSIDE the citation span, as markdown allows.
    const [report] = check("(`export function`, `src/hooks.ts:2,\n6`)");
    expect(report.citation.ranges).toEqual([
      { start: 2, end: 2 },
      { start: 6, end: 6 },
    ]);
    expect(report.verdict.kind).toBe("anchored");
  });

  test("a shortened path resolves when one file ends with it", () => {
    const [report] = check("(`enforcementHook`, `hooks.ts:2`)");
    expect(report.verdict).toEqual({ kind: "anchored", file: "src/hooks.ts" });
  });

  test("an ambiguous short path resolves through the full path the record names", () => {
    const files = { "a/hooks.ts": SOURCE, "b/hooks.ts": "" };
    const [ambiguous] = check("(`enforcementHook`, `hooks.ts:2`)", files);
    expect(ambiguous.verdict.kind).toBe("unresolved");
    const reports = check("See `a/hooks.ts`. (`enforcementHook`, `hooks.ts:2`)", files);
    expect(reports[0].verdict).toEqual({ kind: "anchored", file: "a/hooks.ts" });
  });
});

describe("what the check cannot verify is reported, not skipped", () => {
  test("a citation into a file that does not exist", () => {
    const [report] = check("(`enforcementHook`, `src/missing.ts:2`)");
    expect(report.verdict.kind).toBe("unresolved");
  });

  test("a citation with no anchor", () => {
    const [report] = check("See `src/hooks.ts:2-4`.");
    expect(report.verdict.kind).toBe("unanchored");
  });

  test("an anchor too short to tell one line from another", () => {
    const [report] = check("(`}`, `src/hooks.ts:4`)");
    expect(report.verdict.kind).toBe("unanchored");
  });

  test("a citation written outside a code span", () => {
    const [report] = check("It lives at src/hooks.ts:2 today.");
    expect(report.verdict.kind).toBe("unanchored");
  });

  test("a citation into another repository", () => {
    const [report] = check("(`entrypoint`, `[brain-ui] scripts/entrypoint.sh:59-85`)");
    expect(report.verdict.kind).toBe("unresolved");
  });

  test("a citation of an extensionless file", () => {
    const [report] = check("(`FROM oven/bun`, `Dockerfile:1`)", { Dockerfile: "FROM oven/bun\n" });
    expect(report.verdict.kind).toBe("anchored");
    const [external] = check("(`FROM`, `[brain-ui] Dockerfile:217-231`)");
    expect(external.verdict.kind).toBe("unresolved");
  });

  test("a markdown or HTML link to a line", () => {
    const [report] = check("See [the hook](../../src/hooks.ts#L2).");
    expect(report.verdict.kind).toBe("unanchored");
    const [html] = check('See <a href="../../src/hooks.ts#L2">the hook</a>.');
    expect(html.verdict.kind).toBe("unanchored");
  });

  test("a line-and-column or #L citation in a span", () => {
    for (const span of ["`src/hooks.ts:2:3`", "`src/hooks.ts#L2`", "`src/hooks.ts#L2-L4`"]) {
      const reports = check(`(\`enforcementHook\`, ${span})`);
      expect({ span, kinds: reports.map((r) => r.verdict.kind) }).toEqual({
        span,
        kinds: ["unresolved"],
      });
    }
  });

  test("an exception covers only the occurrences it declares", () => {
    const body = "See `src/missing.ts:2`. Again `src/missing.ts:2`.";
    const reports = checkRecords([{ doc: "docs/decisions/x.md", body }], tree({}), {
      "docs/decisions/x.md|src/missing.ts:2": "removed upstream",
    });
    expect(
      exceptionMismatches(reports, { "docs/decisions/x.md|src/missing.ts:2": "removed upstream" }),
    ).toEqual([{ key: "docs/decisions/x.md|src/missing.ts:2", expected: 1, actual: 2 }]);
    expect(
      exceptionMismatches(reports, {
        "docs/decisions/x.md|src/missing.ts:2": { reason: "removed upstream", occurrences: 2 },
      }),
    ).toEqual([]);
  });

  test("a ratio or a port is not a citation", () => {
    expect(check("Contrast is 4.5:1 in prose, `localhost:6006/mcp` and `width:100%` in code.")).toEqual(
      [],
    );
  });

  test("a listed exception is carried with its reason, not turned into a pass", () => {
    const [report] = checkRecords(
      [{ doc: "docs/decisions/x.md", body: "See `src/missing.ts:2`." }],
      tree({}),
      { "docs/decisions/x.md|src/missing.ts:2": "removed upstream" },
    );
    expect(report.verdict.kind).toBe("unresolved");
    expect(report.exception).toBe("removed upstream");
  });
});

describe("parseCitations", () => {
  test("ignores a citation inside a fenced block", () => {
    expect(parseCitations("x.md", "```\nsrc/hooks.ts:2\n`src/hooks.ts:3`\n```\n")).toEqual([]);
  });

  test("does not take a citation for an anchor", () => {
    const [, second] = parseCitations("x.md", "`src/a.ts:1`, `src/b.ts:2`");
    expect(second.anchor).toBeUndefined();
  });

  test("does not take a span joined by anything but a comma for an anchor", () => {
    const [citation] = parseCitations("x.md", "`enforcementHook` in `src/hooks.ts:2`");
    expect(citation.anchor).toBeUndefined();
  });
});
