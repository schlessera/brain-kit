/**
 * The canonical-document policy checks in `brain audit`: `budget` (a
 * canonical document over `taxonomy.canonicalPolicy.<key>.maxTokens`),
 * `review-overdue` (a passed `next_review`, or a lapsed `reviewDays` cadence)
 * and `past-date` (a line naming a day before today in a canonical document
 * with a policy). Every clock is pinned.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { audit, findPastDates } from "../src/lib/auditor";
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

  test("currentFocus.maxTokens: 100 yields a budget issue for the focus document", async () => {
    const issues = await auditJson(corpusWithPolicy("{ currentFocus: { maxTokens: 100 } }"));
    expect(issues.filter((i) => i.category === "budget").map((i) => i.path)).toEqual([FOCUS]);
  });

  test("an unset budget yields none, and a past date names its line in the file", async () => {
    const root = corpusWithPolicy("{ currentFocus: { maxTokens: null } }");
    const focus = join(root, FOCUS);
    const lines = readFileSync(focus, "utf8").split("\n");
    lines.push("- 2020-01-01 submit report");
    writeFileSync(focus, lines.join("\n") + "\n");
    const issues = await auditJson(root);
    expect(issues.filter((i) => i.category === "budget")).toEqual([]);
    const past = issues.filter((i) => i.category === "past-date" && i.message.includes("2020-01-01"));
    expect(past.map((i) => i.message.split(" names ")[0])).toEqual([`Line ${lines.length}`]);
  });
});
