/**
 * `brain eval` end to end: the real bin against a temp copy of the fixture
 * corpus, keyless, FTS lane. Scores, validity gates and exit codes.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { Database } from "bun:sqlite";
import { basename, join } from "path";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";

type Query = { id: string; q: string; class: string; expected: string[] };

// Each is the FTS top-1 hit for its query on the fixture corpus.
const TOP1: Query[] = [
  { id: "scope", q: "telescope setup", class: "exact", expected: ["studies/telescope-setup.md"] },
  { id: "knee", q: "knee injury", class: "exact", expected: ["health/knee-injury.md"] },
  { id: "sleep", q: "sleep tracking", class: "paraphrase", expected: ["health/sleep-tracking.md"] },
];

let root: string;
// A directory beside the brain, holding real files a path could escape to.
let outside: string;

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
  outside = mkdtempSync(join(tmpdir(), "brain-eval-outside-"));
  writeFileSync(join(outside, "outside.md"), "---\ntitle: Outside\ntype: note\n---\n\nknee injury\n");
});

afterAll(() => {
  cleanup(root);
  cleanup(outside);
});

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

  test("a relative --out is relative to the brain root", async () => {
    const set = writeSet("rel.jsonl", TOP1);
    const { code, out } = await evalJson(["--set", set, "--out", "evals/runs/relative.json"]);
    expect(code).toBe(0);
    expect(JSON.parse(readFileSync(join(root, "evals", "runs", "relative.json"), "utf-8"))).toEqual(out);
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
    // The not-indexed gate would also refuse this path, so the assertion is
    // on the missing-on-disk diagnostic itself.
    expect(stderr).toContain("1 expected path(s) do not exist in the brain");
    expect(stderr).toContain("knee: health/no-such-note.md");
  });

  // Assets are indexed only on an embedding run, so the rows are staged
  // directly; the freshness gate checks markdown only, so nothing else
  // would notice an asset that is now a directory.
  test("an indexed expected asset that is now a directory, or a link to one", async () => {
    const db = new Database(join(root, "brain.db"));
    try {
      for (const path of ["studies/star-chart.pdf", "studies/star-link.pdf"]) {
        db.run(
          "INSERT INTO documents(path,title,type,status,created,updated,content,asset_type,indexed_at) VALUES (?,?,?,?,?,?,?,?,?)",
          [path, "Star chart", "study", "active", "2026-07-01", "2026-07-01", "", "application/pdf", "2026-07-01"]
        );
      }
    } finally {
      db.close();
    }
    // The fixture's real PDF, replaced by a directory of the same name.
    rmSync(join(root, "studies", "star-chart.pdf"));
    mkdirSync(join(root, "studies", "star-chart.pdf"));
    symlinkSync(join(root, "studies", "astronomy"), join(root, "studies", "star-link.pdf"));

    for (const path of ["studies/star-chart.pdf", "studies/star-link.pdf"]) {
      const set = writeSet("not-a-file.jsonl", [TOP1[0], { ...TOP1[1], expected: [path] }]);
      const { code, stdout, stderr } = await runCli(root, ["eval", "--mode", "fts", "--json", "--set", set]);
      expect(stderr).toContain("are not regular files");
      expect(stderr).toContain(`knee: ${path}`);
      expect(code).toBe(2);
      expect(stdout).toBe("");
    }
  });

  // The outside file is real, so without containment the path would exist
  // and a later gate (not indexed) would refuse with another message.
  test("an expected path that escapes the brain root by ..", async () => {
    const escape = `../${basename(outside)}/outside.md`;
    expect(existsSync(join(root, escape))).toBe(true);
    const set = writeSet("escape.jsonl", [TOP1[0], { ...TOP1[1], expected: [escape] }]);
    const { code, stdout, stderr } = await runCli(root, ["eval", "--mode", "fts", "--json", "--set", set]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("resolve outside the brain root");
    expect(stderr).toContain(`knee: ${escape}`);
  });

  test("an expected path that escapes the brain root through a symlink", async () => {
    symlinkSync(join(outside, "outside.md"), join(root, "notes", "linked-out.md"));
    const set = writeSet("escape-link.jsonl", [TOP1[0], { ...TOP1[1], expected: ["notes/linked-out.md"] }]);
    const { code, stdout, stderr } = await runCli(root, ["eval", "--mode", "fts", "--json", "--set", set]);
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("resolve outside the brain root");
    expect(stderr).toContain("knee: notes/linked-out.md");
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

describe("--out stays inside the brain", () => {
  const refusedOut = async (out: string) => {
    const set = writeSet("out-escape.jsonl", TOP1);
    return runCli(root, ["eval", "--mode", "fts", "--json", "--set", set, "--out", out]);
  };

  test("an absolute path outside the brain is refused before anything is written", async () => {
    const target = join(outside, "abs.json");
    const { code, stdout, stderr } = await refusedOut(target);
    expect(code).toBe(1);
    expect(stdout).toBe("");
    expect(stderr).toContain("Output path is not inside the brain");
    expect(existsSync(target)).toBe(false);
  });

  // --mode vector with no provider would refuse (exit 2) after searching;
  // the out-path check answers first, before any search runs.
  test("the out path is checked before the run, not only at the write", async () => {
    const set = writeSet("out-first.jsonl", TOP1);
    const { code, stderr } = await runCli(root, [
      "eval", "--mode", "vector", "--json", "--set", set, "--out", join(outside, "first.json"),
    ]);
    expect(stderr).toContain("Output path is not inside the brain");
    expect(code).toBe(1);
  });

  test("a .. traversal out of the brain is refused", async () => {
    const { code, stderr } = await refusedOut(`../${basename(outside)}/traversal.json`);
    expect(code).toBe(1);
    expect(stderr).toContain("Output path is not inside the brain");
    expect(existsSync(join(outside, "traversal.json"))).toBe(false);
  });

  test("a symlinked directory inside the brain does not redirect the write", async () => {
    symlinkSync(outside, join(root, "evals", "linked-dir"));
    const { code, stderr } = await refusedOut("evals/linked-dir/through-dir.json");
    expect(code).toBe(1);
    expect(stderr).toContain("Output path is not inside the brain");
    expect(existsSync(join(outside, "through-dir.json"))).toBe(false);
  });

  test("a symlinked file inside the brain does not redirect the write", async () => {
    const target = join(outside, "through-file.json");
    writeFileSync(target, "untouched");
    symlinkSync(target, join(root, "evals", "linked-file.json"));
    const { code, stderr } = await refusedOut("evals/linked-file.json");
    expect(code).toBe(1);
    expect(stderr).toContain("Output path is not inside the brain");
    expect(readFileSync(target, "utf-8")).toBe("untouched");
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

  test("an unknown --mode, including an inherited property name", async () => {
    for (const mode of ["semantic", "toString", "constructor", "__proto__"]) {
      const { code, stderr } = await runCli(root, ["eval", "--mode", mode, "--json"]);
      expect(code).toBe(1);
      expect(stderr).toContain("--mode must be one of");
    }
  });

  test("a value option given no value is refused, not defaulted", async () => {
    const set = writeSet("bare.jsonl", TOP1);
    for (const flag of ["--k", "--mode", "--rerank", "--out", "--set"]) {
      const { code, stdout, stderr } = await runCli(root, ["eval", "--set", set, "--mode", "fts", flag, "--json"]);
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain(`${flag} requires a value`);
    }
  });

  test("a cutoff past the supported bound is refused before searching", async () => {
    const set = writeSet("big-k.jsonl", TOP1);
    for (const k of ["1001", "9007199254740993", "9".repeat(400)]) {
      const { code, stdout, stderr } = await runCli(root, ["eval", "--set", set, "--mode", "fts", "--k", k, "--json"]);
      expect(code).toBe(1);
      expect(stdout).toBe("");
      expect(stderr).toContain("--k cutoffs go up to 1000");
    }
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

  // Root reads through any mode, so the file cannot be made unreadable there.
  test.skipIf(process.getuid?.() === 0)("an indexed file that cannot be read is refused, naming it", async () => {
    const path = join(stale, "health", "sleep-tracking.md");
    chmodSync(path, 0o000);
    try {
      const refused = await runCli(stale, ["eval", "--mode", "fts", "--json"]);
      expect(refused.code).toBe(2);
      expect(refused.stdout).toBe("");
      expect(refused.stderr).toContain("health/sleep-tracking.md: cannot be read to check it against the index");
    } finally {
      chmodSync(path, 0o644);
    }
  });
});
