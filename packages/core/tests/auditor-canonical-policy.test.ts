/**
 * The canonical-document policy checks in `brain audit`: `budget` (a
 * canonical document over `taxonomy.canonicalPolicy.<key>.maxTokens`),
 * `review-overdue` (a passed `next_review`, or a lapsed `reviewDays` cadence)
 * and `past-date` (a line naming a day before today in a canonical document
 * with a policy). Every date assertion pins `now`. The two CLI tests check only
 * wiring that the calendar cannot change: whether a budget is reported, and
 * that the command hands the audit the brain root. The line number that root
 * produces is asserted in process, with `now` pinned.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { audit, auditWithModules, findPastDates } from "../src/lib/auditor";
import { brainConfigSchema as schema } from "../src/lib/config";
import { initContext } from "../src/lib/context";
import { estimateTokens } from "../src/lib/context-assembler";
import { openDatabase } from "../src/lib/db";
import { buildTaxonomy } from "../src/lib/taxonomy";
import { brainConfigSchema } from "../src/lib/config";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const NOW = new Date("2026-07-01T12:00:00Z");
const TODAY = "2026-07-01";
const FOCUS = "context/current-focus.md";

function taxonomyWith(taxonomy: Record<string, unknown> = {}) {
  return buildTaxonomy({ user: brainConfigSchema.parse({ taxonomy }) });
}

function db(docs: { path: string; content?: string; updated?: string; next_review?: string | null; status?: string }[]): Database {
  const d = openDatabase(":memory:");
  for (const doc of docs) {
    d.run(
      `INSERT INTO documents
         (path, title, type, status, relevance, summary, created, updated, content, content_hash, asset_type, next_review, indexed_at)
       VALUES (?, ?, 'note', ?, 'primary', NULL, '2026-01-01', ?, ?, ?, 'markdown', ?, '2026-01-01')`,
      [doc.path, doc.path, doc.status ?? "active", doc.updated ?? "2026-06-30", doc.content ?? "", "h-" + doc.path, doc.next_review ?? null]
    );
  }
  return d;
}

const of = (issues: ReturnType<typeof audit>, category: string) => issues.filter((i) => i.category === category);

describe("budget", () => {
  const long = "word ".repeat(1000); // 5000 characters, ~1250 tokens

  test("the default 1000-token budget flags a long focus document", () => {
    const issues = of(audit(db([{ path: FOCUS, content: long }]), taxonomyWith(), { now: NOW }), "budget");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: FOCUS, severity: "warning" });
    expect(issues[0].message).toBe(`~${estimateTokens(long)} tokens, over the 1000-token budget for canonical "currentFocus"`);
  });

  test("a document within budget is not flagged", () => {
    expect(of(audit(db([{ path: FOCUS, content: "word ".repeat(100) }]), taxonomyWith(), { now: NOW }), "budget")).toEqual([]);
  });

  test("maxTokens: null unsets the default budget", () => {
    const tax = taxonomyWith({ canonicalPolicy: { currentFocus: { maxTokens: null } } });
    expect(tax.canonicalPolicy.currentFocus).toEqual({});
    expect(of(audit(db([{ path: FOCUS, content: long }]), tax, { now: NOW }), "budget")).toEqual([]);
  });

  test("a policy for another key applies to its canonical document; setting reviewDays keeps the default budget", () => {
    const tax = taxonomyWith({ canonicalPolicy: { identity: { maxTokens: 10 }, currentFocus: { reviewDays: 14 } } });
    expect(tax.canonicalPolicy.currentFocus).toEqual({ maxTokens: 1000, reviewDays: 14 });
    const issues = of(audit(db([{ path: "me/identity.md", content: "word ".repeat(20) }]), tax, { now: NOW }), "budget");
    expect(issues.map((i) => i.path)).toEqual(["me/identity.md"]);
  });
});

describe("review-overdue", () => {
  test("a passed next_review yields exactly one issue; a future one yields none", () => {
    const issues = of(
      audit(
        db([
          { path: "notes/past.md", next_review: "2026-06-30" },
          { path: "notes/future.md", next_review: "2026-07-02" },
          { path: "notes/today.md", next_review: TODAY },
          { path: "notes/archived.md", next_review: "2026-01-01", status: "archived" },
        ]),
        taxonomyWith(),
        { now: NOW }
      ),
      "review-overdue"
    );
    expect(issues.map((i) => [i.path, i.message])).toEqual([["notes/past.md", "next_review 2026-06-30 has passed"]]);
  });

  test("a lapsed reviewDays cadence flags the canonical document once, unless a future next_review is set", () => {
    const tax = taxonomyWith({ canonicalPolicy: { currentFocus: { reviewDays: 14 } } });
    const lapsed = of(audit(db([{ path: FOCUS, updated: "2026-06-01" }]), tax, { now: NOW }), "review-overdue");
    expect(lapsed.map((i) => i.message)).toEqual(["Review was due 2026-06-15 (reviewDays cadence; last updated 2026-06-01)"]);

    const both = of(audit(db([{ path: FOCUS, updated: "2026-06-01", next_review: "2026-06-20" }]), tax, { now: NOW }), "review-overdue");
    expect(both.map((i) => i.message)).toEqual(["next_review 2026-06-20 has passed"]);

    const scheduled = of(audit(db([{ path: FOCUS, updated: "2026-06-01", next_review: "2026-07-10" }]), tax, { now: NOW }), "review-overdue");
    expect(scheduled).toEqual([]);

    const fresh = of(audit(db([{ path: FOCUS, updated: "2026-06-20" }]), tax, { now: NOW }), "review-overdue");
    expect(fresh).toEqual([]);
  });
});

describe("reviewDays bounds", () => {
  test("the schema accepts 3650 days and refuses 3651", () => {
    const policy = (reviewDays: number) =>
      schema.safeParse({ taxonomy: { canonicalPolicy: { currentFocus: { reviewDays } } } }).success;
    expect(policy(3650)).toBe(true);
    expect(policy(3651)).toBe(false);
  });

  test("the largest cadence neither crashes nor reads as overdue", () => {
    const tax = taxonomyWith({ canonicalPolicy: { currentFocus: { reviewDays: 3650 } } });
    expect(of(audit(db([{ path: FOCUS, updated: "2026-06-01" }]), tax, { now: NOW }), "review-overdue")).toEqual([]);
  });

  test("a cadence due today is not overdue; due yesterday is", () => {
    const tax = taxonomyWith({ canonicalPolicy: { currentFocus: { reviewDays: 30 } } });
    expect(of(audit(db([{ path: FOCUS, updated: "2026-06-01" }]), tax, { now: NOW }), "review-overdue")).toEqual([]);
    expect(
      of(audit(db([{ path: FOCUS, updated: "2026-05-31" }]), tax, { now: NOW }), "review-overdue").map((i) => i.message)
    ).toEqual(["Review was due 2026-06-30 (reviewDays cadence; last updated 2026-05-31)"]);
  });
});

describe("past-date", () => {
  test("a focus line naming a past day warns with its line; today's date does not", () => {
    const content = ["## Now", "", "- 2020-01-01 submit report", `- ${TODAY} standup`, "- 2026-07-02 ship"].join("\n");
    const issues = of(audit(db([{ path: FOCUS, content }]), taxonomyWith(), { now: NOW }), "past-date");
    expect(issues).toHaveLength(1);
    expect(issues[0]).toMatchObject({ path: FOCUS, severity: "warning" });
    expect(issues[0].message).toBe(`Body line 3 names 2020-01-01, before today (${TODAY}): - 2020-01-01 submit report`);
  });

  test("only canonical documents with a policy are scanned", () => {
    const content = "- 2020-01-01 submit report";
    const issues = of(
      audit(db([{ path: "notes/old.md", content }, { path: "me/identity.md", content }]), taxonomyWith(), { now: NOW }),
      "past-date"
    );
    expect(issues).toEqual([]);
  });

  // Review round 1: code is whatever a GFM parser says it is.
  test("a line after a one-line inline span of triple backticks is still scanned", () => {
    const text = ["```2020-01-01```", "", "- 2020-01-02 submit report"].join("\n");
    expect(findPastDates(text, TODAY)).toEqual([{ line: 3, date: "2020-01-02", text: "- 2020-01-02 submit report" }]);
  });

  test("a fence inside a blockquote or a list item, and an indented block, are code", () => {
    const text = [
      "> ```",
      "> 2020-01-01 in quoted code",
      "> ```",
      "",
      "Some prose.",
      "",
      "    2020-01-03 indented code",
      "",
      "- item",
      "",
      "  ```",
      "  2020-01-02 in listed code",
      "  ```",
      "",
      "> 2020-01-04 quoted prose",
    ].join("\n");
    expect(findPastDates(text, TODAY).map((p) => p.date)).toEqual(["2020-01-04"]);
  });

  test("findPastDates skips fenced code and impossible dates, and reports a line's earliest date", () => {
    const text = ["```", "2020-01-01 in code", "```", "- 2026-02-30 is not a date", "- 2026-08-01 then 2019-05-05"].join("\n");
    expect(findPastDates(text, TODAY)).toEqual([{ line: 5, date: "2019-05-05", text: "- 2026-08-01 then 2019-05-05" }]);
  });
});

describe("brain audit --json on a copy of the fixture corpus", () => {
  const temps: string[] = [];
  afterEach(() => {
    while (temps.length) cleanup(temps.pop()!);
  });

  function corpusWithPolicy(policy: string): string {
    const root = makeTempBrain();
    temps.push(root);
    const config = join(root, "brain.config.ts");
    const text = readFileSync(config, "utf8");
    expect(text).toContain("  taxonomy: {\n");
    writeFileSync(config, text.replace("  taxonomy: {\n", `  taxonomy: {\n    canonicalPolicy: ${policy},\n`));
    return root;
  }

  async function auditJson(root: string) {
    const index = await runCli(root, ["index", "--json"]);
    expect(index.code).toBe(0);
    const { stdout, code } = await runCli(root, ["audit", "--json"]);
    expect(code).toBe(0);
    return JSON.parse(stdout).issues as { path: string; category: string; message: string }[];
  }

  /** The fixture's focus document, grown past the 1,000-token default with a past-dated task at its end. */
  function growFocus(root: string): number {
    const focus = join(root, FOCUS);
    const lines = readFileSync(focus, "utf8").split("\n");
    lines.push("", ...Array.from({ length: 60 }, (_, i) => `- Reference note ${i}: ${"detail ".repeat(12)}`));
    lines.push("- 2020-01-01 submit report");
    writeFileSync(focus, lines.join("\n") + "\n");
    return lines.length;
  }

  test("currentFocus.maxTokens: 100 yields a budget issue for the focus document", async () => {
    const issues = await auditJson(corpusWithPolicy("{ currentFocus: { maxTokens: 100 } }"));
    expect(issues.filter((i) => i.category === "budget").map((i) => i.path)).toEqual([FOCUS]);
  });

  test("a focus document over 1,000 tokens warns under the default and not with maxTokens: null", async () => {
    const byDefault = corpusWithPolicy("{}");
    growFocus(byDefault);
    const warned = (await auditJson(byDefault)).filter((i) => i.category === "budget");
    expect(warned.map((i) => i.path)).toEqual([FOCUS]);
    expect(warned[0].message).toMatch(/over the 1000-token budget/);

    const unset = corpusWithPolicy("{ currentFocus: { maxTokens: null } }");
    growFocus(unset);
    expect((await auditJson(unset)).filter((i) => i.category === "budget")).toEqual([]);
  });

  test("brain audit hands the audit the brain root, so a past date names its file line", async () => {
    const root = corpusWithPolicy("{}");
    growFocus(root);
    const past = (await auditJson(root)).filter((i) => i.category === "past-date" && i.message.includes("2020-01-01"));
    expect(past).toHaveLength(1);
    expect(past[0].message.startsWith("Line ")).toBe(true);
  });

  test("with the root and a pinned clock, the line is the file's", async () => {
    const root = corpusWithPolicy("{}");
    const fileLines = growFocus(root);
    expect((await runCli(root, ["index", "--json"])).code).toBe(0);
    const brain = await initContext({ root });
    const database = openDatabase(brain.dbPath, { readonly: true });
    try {
      const past = (await auditWithModules(database, brain, { now: NOW })).filter(
        (i) => i.category === "past-date" && i.message.includes("2020-01-01")
      );
      expect(past.map((i) => i.message)).toEqual([
        `Line ${fileLines} names 2020-01-01, before today (${TODAY}): - 2020-01-01 submit report`,
      ]);
    } finally {
      database.close();
    }
  });
});
