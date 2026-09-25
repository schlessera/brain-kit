/**
 * `brain eval --context`: every query run through the assembler `brain
 * context` uses, at each budget, on a temp copy of the fixture corpus
 * (keyless, FTS). Whether the answer is in the output, and how much of the
 * budget the output uses.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { writeFileSync } from "fs";
import { join } from "path";

import { assembleContext, estimateTokens } from "../src/lib/context-assembler";
import { initContext, setContext } from "../src/lib/context";
import { answerPresent, contextSections, parseBudgets, percentile, resultPaths } from "../src/lib/retrieval-eval";
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
    const used = [at("knee", 1000).budget_used, at("none", 1000).budget_used];
    expect(high.budget_used).toEqual({ median: percentile(used, 50), p10: percentile(used, 10), p90: percentile(used, 90) });
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

describe("reading the assembled output", () => {
  const indexed = new Set(["health/knee-injury.md", "me/identity.md", "context/current-focus.md"]);
  const OUTPUT = [
    "## Identity",
    "Ranger.",
    "",
    "## Current Focus",
    "### Health",
    "Knee rehab (see notes).",
    "",
    "### Left Knee — Rehab (health/knee-injury.md) · updated 2026-06-20 · active — Rehab log",
    "Range of motion.",
    "",
    "### Related",
    "- Checkup Log (health/checkup-log.md) — visits",
  ].join("\n");
  const canonical = { identity: "me/identity.md", focus: "context/current-focus.md" };

  test("a ### heading inside a pinned section is not a search hit", () => {
    expect(resultPaths(OUTPUT, indexed)).toEqual(["health/knee-injury.md"]);
    expect(contextSections(OUTPUT, indexed)).toEqual({ identity: 1, focus: 1, results: 1, related: 1 });
  });

  test("an answer is a hit heading or a pinned section's source, never a Related line", () => {
    expect(answerPresent(OUTPUT, { expected: ["health/knee-injury.md"] }, canonical, indexed)).toBe(true);
    expect(answerPresent(OUTPUT, { expected: ["context/current-focus.md"] }, canonical, indexed)).toBe(true);
    expect(answerPresent(OUTPUT, { expected: ["health/checkup-log.md"] }, canonical, indexed)).toBe(false);
  });

  test("parseBudgets takes sorted distinct positive integers within the bound", () => {
    expect(parseBudgets("8000, 1000,4000,1000")).toEqual([1000, 4000, 8000]);
    for (const bad of ["0", "1,,2", "x", "1000001", "9".repeat(30)]) expect(() => parseBudgets(bad)).toThrow();
  });
});
