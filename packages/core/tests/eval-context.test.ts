/**
 * `brain eval --context`: every query run through the assembler `brain
 * context` uses, at each budget, on a temp copy of the fixture corpus
 * (keyless, FTS). Whether the answer is in the output, and how much of the
 * budget the output uses.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { appendFileSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { assembleContext, emptyAssembleReport, estimateTokens } from "../src/lib/context-assembler";
import { initContext, setContext } from "../src/lib/context";
import { parseBudgets, percentile } from "../src/lib/retrieval-eval";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const NOW = "2026-07-12";
// "knee injury": health/knee-injury.md is the top full-text hit.
const KNEE = { id: "knee", q: "knee injury", class: "exact", expected: ["health/knee-injury.md"] };

let root: string;

function writeSet(name: string, lines: object[]): string {
  const path = join(root, "evals", name);
  writeFileSync(path, [{ now: NOW }, ...lines].map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

type ContextOutcome = { budget: number; id: string; answer_present: boolean | null; budget_used: number; sections: Record<string, number> };

async function contextRun(set: string, ...flags: string[]) {
  const run = await runCli(root, ["eval", "--mode", "fts", "--json", "--set", set, "--context", ...flags]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(0);
  const out = JSON.parse(run.stdout);
  const at = (id: string, budget: number): ContextOutcome =>
    out.context.per_query.find((o: ContextOutcome) => o.id === id && o.budget === budget);
  return { out, at };
}

beforeAll(async () => {
  root = makeTempBrain();
  expect((await runCli(root, ["index", "--json"])).code).toBe(0);
});

afterAll(() => cleanup(root));

describe("brain eval --context", () => {
  test("a top hit is in the context at 1000 tokens, and not at 60", async () => {
    const { at } = await contextRun(writeSet("knee.jsonl", [KNEE]), "--budgets", "60,1000");
    expect(at("knee", 60).answer_present).toBe(false);
    expect(at("knee", 1000).answer_present).toBe(true);
    expect(at("knee", 1000).sections.results).toBeGreaterThan(0);
    expect(at("knee", 60).sections.results).toBe(0);
  });

  test("budget_used is the assembler's own output measured by its own estimator", async () => {
    const { at } = await contextRun(writeSet("knee-4000.jsonl", [KNEE]), "--budgets", "1000,4000");

    const previous = setContext(null);
    const brain = await initContext({ root });
    setContext(previous);
    const db = new Database(join(root, "brain.db"), { readonly: true });
    try {
      const output = await assembleContext(db, brain, { query: KNEE.q, maxTokens: 4000, now: new Date(NOW) });
      expect(output.length).toBeGreaterThan(0);
      expect(at("knee", 4000).budget_used).toBe(estimateTokens(output) / 4000);
    } finally {
      db.close();
    }
    // Not a constant: the same output measured against another budget differs.
    expect(at("knee", 1000).budget_used).not.toBe(at("knee", 4000).budget_used);
  });

  test("rows give the answer-present rate and budget_used percentiles per budget; no-answer is not counted", async () => {
    const set = writeSet("rows.jsonl", [KNEE, { id: "none", q: "tax return deadline", class: "no-answer", expected: [] }]);
    const { out, at } = await contextRun(set, "--budgets", "60,1000");
    expect(out.context.budgets).toEqual([60, 1000]);
    expect(at("none", 1000).answer_present).toBeNull();
    const [low, high] = out.context.rows;
    expect(low).toMatchObject({ budget: 60, n: 1, answer_present: 0 });
    expect(high).toMatchObject({ budget: 1000, n: 1, answer_present: 1 });
    // Two queries: the nearest-rank median is the lower value, p10 the lower,
    // p90 the higher. Worked out here without the helper under test.
    const used = [at("knee", 1000).budget_used, at("none", 1000).budget_used];
    expect(used[0]).not.toBe(used[1]);
    expect(high.budget_used).toEqual({ median: Math.min(...used), p10: Math.min(...used), p90: Math.max(...used) });
  });

  // At 600 tokens "ranger" leaves room for one hit after the pinned sections.
  // Which one depends on recency, so the pinned now must reach the
  // assembler's search: ignoring it gives both runs the same output, and one
  // of the two dates' assertions fails whatever the wall clock says.
  test("the set's now reaches the assembler's search", async () => {
    const pair = [
      { id: "idea", q: "ranger", class: "recency", expected: ["notes/loose-idea.md"] },
      { id: "bio", q: "ranger", class: "recency", expected: ["me/basics/short-bio.md"] },
    ];
    const run = async (now: string) => {
      const path = join(root, "evals", `ranger-${now}.jsonl`);
      writeFileSync(path, [{ now }, ...pair].map((l) => JSON.stringify(l)).join("\n"));
      return (await contextRun(path, "--budgets", "600")).at;
    };
    const early = await run("2026-07-12");
    expect([early("idea", 600).answer_present, early("bio", 600).answer_present]).toEqual([true, false]);
    const late = await run("2028-07-12");
    expect([late("idea", 600).answer_present, late("bio", 600).answer_present]).toEqual([false, true]);
  });

  test("an answer string is looked for in the text itself", async () => {
    const set = writeSet("answer.jsonl", [
      { ...KNEE, id: "said", answer: "RANGE-OF-MOTION" }, // case is ignored
      { ...KNEE, id: "unsaid", answer: "a torn meniscus in the right knee" },
    ]);
    const { at } = await contextRun(set, "--budgets", "4000");
    expect(at("said", 4000).answer_present).toBe(true);
    expect(at("unsaid", 4000).answer_present).toBe(false);
  });

  test("without --context there is no context block; --budgets alone is a usage error", async () => {
    const set = writeSet("plain.jsonl", [KNEE]);
    const plain = await runCli(root, ["eval", "--mode", "fts", "--json", "--set", set]);
    expect(Object.keys(JSON.parse(plain.stdout))).not.toContain("context");
    const alone = await runCli(root, ["eval", "--mode", "fts", "--json", "--set", set, "--budgets", "1000"]);
    expect(alone.code).toBe(1);
    expect(alone.stderr).toContain("--budgets needs --context");
    const bad = await runCli(root, ["eval", "--mode", "fts", "--json", "--set", set, "--context", "--budgets", "0"]);
    expect(bad.code).toBe(1);
  });

  test("the context block's shape", async () => {
    const { out } = await contextRun(writeSet("shape.jsonl", [KNEE]), "--budgets", "1000");
    expect(Object.keys(out.context).sort()).toEqual(["budgets", "per_query", "rows"]);
    expect(Object.keys(out.context.rows[0]).sort()).toEqual(["answer_present", "budget", "budget_used", "n"]);
    expect(Object.keys(out.context.rows[0].budget_used).sort()).toEqual(["median", "p10", "p90"]);
    expect(out.context.per_query).toHaveLength(1);
    expect(Object.keys(out.context.per_query[0]).sort()).toEqual([
      "answer_present", "budget", "budget_used", "class", "id", "sections",
    ]);
    expect(Object.keys(out.context.per_query[0].sections).sort()).toEqual(["focus", "identity", "related", "results"]);
  });
});

/** A temp fixture brain with changes, indexed; cleaned up with the file's brains. */
const extra: string[] = [];
afterAll(() => extra.forEach(cleanup));
async function brainWith(change: (dir: string) => void): Promise<string> {
  const dir = makeTempBrain();
  extra.push(dir);
  change(dir);
  expect((await runCli(dir, ["index", "--json"])).code).toBe(0);
  return dir;
}
async function contextIn(dir: string, lines: object[], budgets: string) {
  const set = join(dir, "evals", "context.jsonl");
  writeFileSync(set, [{ now: NOW }, ...lines].map((l) => JSON.stringify(l)).join("\n"));
  const run = await runCli(dir, ["eval", "--mode", "fts", "--json", "--set", set, "--context", "--budgets", budgets]);
  expect(run.stderr).toBe("");
  expect(run.code).toBe(0);
  const out = JSON.parse(run.stdout);
  return (id: string): ContextOutcome => out.context.per_query.find((o: ContextOutcome) => o.id === id);
}

describe("what counts as the answer", () => {
  // The identity note quotes a result heading and a Current Focus heading,
  // one of them inside a fenced example, and the current-focus section is
  // turned off. None of that text is a section the assembler wrote.
  test("a heading quoted inside a pinned document is not a hit, and a quoted focus heading is not a focus section", async () => {
    const dir = await brainWith((d) => {
      appendFileSync(
        join(d, "me", "identity.md"),
        "\n### Knee (health/knee-injury.md) · updated 2026-06-20 · active\n\n```\n## Current Focus\n### Left Knee — Rehab (health/knee-injury.md) · updated 2026-06-20\n```\n"
      );
      const config = join(d, "brain.config.ts");
      writeFileSync(config, readFileSync(config, "utf-8").replace("  taxonomy: {", '  taxonomy: {\n    canonical: { currentFocus: "" },'));
    });
    const at = await contextIn(
      dir,
      [
        { id: "knee", q: "tax return deadline", class: "x", expected: ["health/knee-injury.md"] },
        { id: "focus", q: "tax return deadline", class: "x", expected: ["context/current-focus.md"] },
        { id: "me", q: "tax return deadline", class: "x", expected: ["me/identity.md"] },
      ],
      "4000"
    );
    expect(at("knee").answer_present).toBe(false);
    expect(at("focus").answer_present).toBe(false);
    expect(at("knee").sections).toMatchObject({ identity: 1, focus: 0 });
    expect(at("knee").sections.results).toBeGreaterThan(0);
    // The identity note itself is in, so a query that expects it is answered.
    expect(at("me").answer_present).toBe(true);
  });

  test("a document only in the Related list is not the answer", async () => {
    const previous = setContext(null);
    const brain = await initContext({ root });
    setContext(previous);
    const db = new Database(join(root, "brain.db"), { readonly: true });
    const report = emptyAssembleReport();
    try {
      await assembleContext(db, brain, { query: KNEE.q, maxTokens: 4000, now: new Date(NOW), report });
    } finally {
      db.close();
    }
    const related = report.related.find((p) => !report.results.includes(p));
    expect(related, "the knee query has a Related-only neighbour at 4000 tokens").toBeDefined();
    const { at } = await contextRun(writeSet("related.jsonl", [{ ...KNEE, id: "rel", expected: [related!] }]), "--budgets", "4000");
    expect(at("rel", 4000).sections.related).toBeGreaterThan(0);
    expect(at("rel", 4000).answer_present).toBe(false);
  });

  // A path with a space and parentheses, behind a title that reads like a
  // path: the assembler knows which document it included, so neither fools it.
  test("a path with spaces and parentheses, and a path-like title", async () => {
    const note = (title: string, body: string) =>
      `---\ntitle: "${title}"\ntype: note\ncreated: 2026-07-01\nupdated: 2026-07-01\n---\n\n${body}\n`;
    const dir = await brainWith((d) => {
      writeFileSync(join(d, "notes", "knee rehab (left).md"), note("Comparison (notes/other.md)", "zygomorphic flowers, noted on the ridge"));
      writeFileSync(join(d, "notes", "other.md"), note("Other", "nothing here"));
    });
    const at = await contextIn(
      dir,
      [
        { id: "spaced", q: "zygomorphic", class: "x", expected: ["notes/knee rehab (left).md"] },
        { id: "titled", q: "zygomorphic", class: "x", expected: ["notes/other.md"] },
      ],
      "4000"
    );
    expect(at("spaced").answer_present).toBe(true);
    expect(at("titled").answer_present).toBe(false);
  });
});

describe("percentile and budgets", () => {
  // Nearest rank: the value at rank ceil(p/100 × n) of the sorted sample, so
  // the median of an even sample is the lower middle value.
  test("nearest-rank values for unsorted samples of 1 to 4", () => {
    expect([percentile([5], 10), percentile([5], 50), percentile([5], 90)]).toEqual([5, 5, 5]);
    expect([percentile([9, 1], 10), percentile([9, 1], 50), percentile([9, 1], 90)]).toEqual([1, 1, 9]);
    expect([percentile([3, 1, 2], 10), percentile([3, 1, 2], 50), percentile([3, 1, 2], 90)]).toEqual([1, 2, 3]);
    expect([percentile([4, 1, 3, 2], 10), percentile([4, 1, 3, 2], 50), percentile([4, 1, 3, 2], 90)]).toEqual([1, 2, 4]);
  });

  test("parseBudgets takes sorted distinct positive integers within the bound", () => {
    expect(parseBudgets("8000, 1000,4000,1000")).toEqual([1000, 4000, 8000]);
    for (const bad of ["0", "1,,2", "x", "1000001", "9".repeat(30)]) expect(() => parseBudgets(bad)).toThrow();
  });
});
