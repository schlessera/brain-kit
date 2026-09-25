/**
 * `brain eval` end to end: the real bin against a temp copy of the fixture
 * corpus, keyless, FTS lane. Scores, validity gates and exit codes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";

type Query = { id: string; q: string; class: string; expected: string[] };

// Each is the FTS top-1 hit for its query on the fixture corpus.
const TOP1: Query[] = [
  { id: "scope", q: "telescope setup", class: "exact", expected: ["studies/telescope-setup.md"] },
  { id: "knee", q: "knee injury", class: "exact", expected: ["health/knee-injury.md"] },
  { id: "sleep", q: "sleep tracking", class: "paraphrase", expected: ["health/sleep-tracking.md"] },
];

let root: string;

function writeSet(name: string, lines: object[]): string {
  const path = join(root, "evals", name);
  writeFileSync(path, lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  return path;
}

async function evalJson(args: string[]) {
  const run = await runCli(root, ["eval", "--mode", "fts", "--json", ...args]);
  return { ...run, out: run.code === 0 ? JSON.parse(run.stdout) : undefined };
}

beforeAll(async () => {
  root = makeTempBrain();
  expect((await runCli(root, ["index", "--json"])).code).toBe(0);
  mkdirSync(join(root, "evals"));
});

afterAll(() => cleanup(root));

describe("scores", () => {
  test("three known top-1 hits score hit@1 = 1.0", async () => {
    const set = writeSet("top1.jsonl", TOP1);
    const { code, out } = await evalJson(["--set", set]);
    expect(code).toBe(0);
    expect(out.per_query).toHaveLength(3);
    expect(out.per_query.map((o: { rank: number }) => o.rank)).toEqual([1, 1, 1]);
    const overall = out.rows.find((r: { class: string | null }) => r.class === null);
    expect(overall.n).toBe(3);
    expect(overall.hit_at["1"]).toBe(1);
    expect(overall.mrr_at_10).toBe(1);
  });

  test("one expected path on an irrelevant document scores hit@1 = 2/3", async () => {
    const set = writeSet("two-of-three.jsonl", [
      TOP1[0],
      TOP1[1],
      { ...TOP1[2], expected: ["notes/quick-note-owl.md"] },
    ]);
    const { code, out } = await evalJson(["--set", set]);
    expect(code).toBe(0);
    expect(out.per_query).toHaveLength(3);
    const overall = out.rows.find((r: { class: string | null }) => r.class === null);
    expect(overall.n).toBe(3);
    expect(overall.hit_at["1"]).toBeCloseTo(2 / 3, 10);
    // The owl note never came back for "sleep tracking": a recall miss, which
    // the oracle column separates from a ranking miss.
    expect(out.per_query[2].rank).toBeNull();
    expect(overall.oracle).toBeCloseTo(2 / 3, 10);
    const paraphrase = out.rows.find((r: { class: string | null }) => r.class === "paraphrase");
    expect(paraphrase.hit_at["1"]).toBe(0);
  });

  test("a no-answer query is reported, never scored", async () => {
    const set = writeSet("no-answer.jsonl", [
      TOP1[0],
      { id: "none", q: "telescope", class: "no-answer", expected: [] },
    ]);
    const { code, out } = await evalJson(["--set", set]);
    expect(code).toBe(0);
    const overall = out.rows.find((r: { class: string | null }) => r.class === null);
    expect(overall.n).toBe(1);
    expect(overall.hit_at["1"]).toBe(1);
    const noAnswer = out.rows.find((r: { class: string | null }) => r.class === "no-answer");
    expect(noAnswer).toMatchObject({ n: 1, hit_at: null, mrr_at_10: null, oracle: null });
    expect(noAnswer.top1_score_median).toBeGreaterThan(0);
    const query = out.per_query.find((o: { id: string }) => o.id === "none");
    expect(query).toMatchObject({ rank: null, hit_at: null, rr: null });
    expect(query.top1_score).toBeGreaterThan(0);
  });

  test("--out writes the same envelope that --json prints", async () => {
    const set = writeSet("out.jsonl", TOP1);
    const outPath = join(root, "evals", "runs", "latest.json");
    const { code, out } = await evalJson(["--set", set, "--out", outPath]);
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(outPath, "utf-8"))).toEqual(out);
  });

  test("the default set is evals/retrieval.jsonl under the brain root", async () => {
    writeSet("retrieval.jsonl", TOP1.slice(0, 1));
    const { code, out } = await evalJson([]);
    expect(code).toBe(0);
    expect(out.meta.set).toBe("evals/retrieval.jsonl");
    expect(out.per_query.map((o: { id: string }) => o.id)).toEqual(["scope"]);
  });
});

describe("validity gates exit 2 with no score", () => {
  test("an expected path that does not exist", async () => {
    const set = writeSet("missing-path.jsonl", [
      TOP1[0],
      { ...TOP1[1], expected: ["health/no-such-note.md"] },
    ]);
    const { code, stdout, stderr } = await runCli(root, ["eval", "--mode", "fts", "--json", "--set", set]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("knee: health/no-such-note.md");
  });

  test("an expected path outside the brain root", async () => {
    const set = writeSet("escape.jsonl", [{ ...TOP1[0], expected: ["../outside.md"] }]);
    const { code, stdout } = await runCli(root, ["eval", "--mode", "fts", "--json", "--set", set]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
  });

  test("an expected path that exists but is not indexed", async () => {
    const set = writeSet("unindexed.jsonl", [{ ...TOP1[0], expected: ["brain.config.ts"] }]);
    const { code, stdout, stderr } = await runCli(root, ["eval", "--mode", "fts", "--json", "--set", set]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("not in the index");
  });

  test("--mode vector with no provider names the degradation and scores nothing", async () => {
    const set = writeSet("vector.jsonl", TOP1);
    const { code, stdout, stderr } = await runCli(root, ["eval", "--mode", "vector", "--json", "--set", set]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("vector lane degraded");
    expect(stderr).toContain("no embedding provider configured");
  });

  test("--mode hybrid with no provider refuses instead of scoring the FTS fallback", async () => {
    const set = writeSet("hybrid.jsonl", TOP1);
    const { code, stdout, stderr } = await runCli(root, ["eval", "--mode", "hybrid", "--json", "--set", set]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("hybrid lane degraded");
  });

  test("a missing set points at docs/evaluating-search.md", async () => {
    const { code, stdout, stderr } = await runCli(root, [
      "eval", "--mode", "fts", "--json", "--set", join(root, "evals", "nope.jsonl"),
    ]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("no query set");
    expect(stderr).toContain("docs/evaluating-search.md");
  });

  test("an empty set points at docs/evaluating-search.md", async () => {
    const set = join(root, "evals", "empty.jsonl");
    writeFileSync(set, "\n");
    const { code, stdout, stderr } = await runCli(root, ["eval", "--mode", "fts", "--json", "--set", set]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("has no queries");
    expect(stderr).toContain("docs/evaluating-search.md");
  });
});

describe("usage errors exit 1", () => {
  test("a malformed line names its line number", async () => {
    const set = join(root, "evals", "malformed.jsonl");
    writeFileSync(set, JSON.stringify(TOP1[0]) + "\n" + JSON.stringify({ id: "x", q: "y", class: "exact" }) + "\n");
    const { code, stdout, stderr } = await runCli(root, ["eval", "--mode", "fts", "--json", "--set", set]);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("line 2");
    expect(stderr).toContain("expected");
  });

  test("an unknown --mode", async () => {
    const { code } = await runCli(root, ["eval", "--mode", "semantic", "--json"]);
    expect(code).toBe(1);
  });
});

describe("a stale index", () => {
  let stale: string;
  beforeAll(async () => {
    stale = makeTempBrain();
    expect((await runCli(stale, ["index", "--json"])).code).toBe(0);
    mkdirSync(join(stale, "evals"));
    writeFileSync(join(stale, "evals", "retrieval.jsonl"), TOP1.map((q) => JSON.stringify(q)).join("\n"));
  });
  afterAll(() => cleanup(stale));

  test("an edit after the last index run is refused until the next one", async () => {
    const first = await runCli(stale, ["eval", "--mode", "fts", "--json"]);
    expect(first.code).toBe(0);

    appendFileSync(join(stale, "health", "knee-injury.md"), "\nOne more line.\n");
    const refused = await runCli(stale, ["eval", "--mode", "fts", "--json"]);
    expect(refused.code).toBe(2);
    expect(refused.stdout).toBe("");
    expect(refused.stderr).toContain("health/knee-injury.md: changed since it was indexed");

    expect((await runCli(stale, ["index", "--json"])).code).toBe(0);
    expect((await runCli(stale, ["eval", "--mode", "fts", "--json"])).code).toBe(0);
  });
});
