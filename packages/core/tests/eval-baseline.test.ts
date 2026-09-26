/**
 * `brain eval --baseline`: a run compared per query against a stored one,
 * the net-loss and must-pass gate, "not comparable" as its own exit code,
 * `--redact`, and the doctor reminder. The real bin on a temp copy of the
 * fixture corpus, keyless, FTS lane.
 */

import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "fs";
import { join } from "path";

import { BaselineError, compareRuns, parseStoredRun, signTestP } from "../src/lib/eval-baseline";
import type { StoredRun } from "../src/lib/eval-baseline";
import { packageVersion } from "../src/package-version";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

// Four queries, each a known top-1 full-text hit on the fixture.
const SET = [
  { id: "scope", q: "telescope setup", class: "exact", expected: ["studies/telescope-setup.md"] },
  { id: "knee", q: "knee injury", class: "exact", expected: ["health/knee-injury.md"] },
  { id: "sleep", q: "sleep tracking", class: "exact", expected: ["health/sleep-tracking.md"] },
  { id: "dob", q: "the Dobsonian", class: "alias", expected: ["studies/telescope-setup.md"] },
];
// The same IDs, with two queries' answers moved to documents they miss.
const SWAPPED = SET.map((q) =>
  q.id === "knee" ? { ...q, expected: ["notes/quick-note-owl.md"] } : q.id === "sleep" ? { ...q, expected: ["me/identity.md"] } : q
);

let root: string;

function writeSet(name: string, lines: object[]): string {
  writeFileSync(join(root, "evals", name), [{ now: "2026-07-12" }, ...lines].map((l) => JSON.stringify(l)).join("\n") + "\n");
  return `evals/${name}`;
}

async function evalRun(...args: string[]) {
  const run = await runCli(root, ["eval", "--mode", "fts", "--rerank", "heuristic", "--json", ...args]);
  let out;
  try {
    out = JSON.parse(run.stdout);
  } catch {
    out = undefined;
  }
  return { ...run, out };
}

beforeAll(async () => {
  root = makeTempBrain();
  expect((await runCli(root, ["index", "--json"])).code).toBe(0);
  const stored = await evalRun("--set", writeSet("set.jsonl", SET), "--out", "evals/baseline.json");
  expect(stored.code).toBe(0);
  expect(stored.out.rows[0].hit_at["1"]).toBe(1);
});

afterAll(() => cleanup(root));

describe("brain eval --baseline", () => {
  test("the same run against its own baseline passes with nothing lost", async () => {
    const { code, out } = await evalRun("--set", "evals/set.jsonl", "--baseline", "evals/baseline.json");
    expect(code).toBe(0);
    expect(out.baseline.comparable).toBe(true);
    expect(out.baseline.modes).toHaveLength(1);
    expect(out.baseline.modes[0].hit_at["1"]).toMatchObject({ lost: [], gained: [], unchanged: 4, sign_test_p: 1 });
    expect(out.baseline.gate).toMatchObject({ failed: false, reasons: [] });
  });

  test("two queries lost against the baseline fail the gate and are named", async () => {
    const { code, out } = await evalRun(
      "--set", writeSet("swapped.jsonl", SWAPPED), "--baseline", "evals/baseline.json", "--allow-set-change"
    );
    expect(code).toBe(1);
    expect(out.baseline.modes[0].hit_at["1"].lost.sort()).toEqual(["knee", "sleep"]);
    expect(out.baseline.modes[0].hit_at["1"].gained).toEqual([]);
    expect(out.baseline.modes[0].hit_at["1"].sign_test_p).toBe(0.5);
    expect(out.baseline.gate.reasons).toEqual(["fts: net loss of 2 on hit@1 (lost 2, gained 0; limit 2)"]);
  });

  test("a net loss under the limit passes, unless a lost query is in a must-pass class", async () => {
    const set = writeSet("one-lost.jsonl", SET.map((q) => (q.id === "dob" ? { ...q, expected: ["me/identity.md"] } : q)));
    const passes = await evalRun("--set", set, "--baseline", "evals/baseline.json", "--allow-set-change");
    expect(passes.code).toBe(0);
    expect(passes.out.baseline.modes[0].hit_at["1"].lost).toEqual(["dob"]);
    const fails = await evalRun("--set", set, "--baseline", "evals/baseline.json", "--allow-set-change", "--must-pass", "alias");
    expect(fails.code).toBe(1);
    expect(fails.out.baseline.gate.reasons).toEqual(['fts: must-pass class "alias" lost dob on hit@1']);
    const loose = await evalRun("--set", set, "--baseline", "evals/baseline.json", "--allow-set-change", "--max-net-loss", "1");
    expect(loose.code).toBe(1);
  });

  test("a baseline written from a different set is not comparable: exit 3, not a pass", async () => {
    const stored = JSON.parse(readFileSync(join(root, "evals", "baseline.json"), "utf-8"));
    stored.meta.set_sha256 = "0".repeat(64);
    writeFileSync(join(root, "evals", "other-set.json"), JSON.stringify(stored));
    const { code, out } = await evalRun("--set", "evals/set.jsonl", "--baseline", "evals/other-set.json");
    expect(code).toBe(3);
    expect(out.baseline.comparable).toBe(false);
    expect(out.baseline.not_comparable[0]).toContain("set_sha256 differs");
  });

  test("a different mode or k is not comparable either", async () => {
    const stored = JSON.parse(readFileSync(join(root, "evals", "baseline.json"), "utf-8"));
    // A complete hybrid run: its entries are relabelled too, or the baseline
    // would be refused as incomplete before modes are compared.
    const hybrid = { ...stored, meta: { ...stored.meta, modes: ["hybrid"] }, per_query: stored.per_query.map((q: object) => ({ ...q, mode: "hybrid" })) };
    writeFileSync(join(root, "evals", "other-mode.json"), JSON.stringify(hybrid));
    expect((await evalRun("--set", "evals/set.jsonl", "--baseline", "evals/other-mode.json")).code).toBe(3);
    const k = await evalRun("--set", "evals/set.jsonl", "--baseline", "evals/baseline.json", "--k", "1,5");
    expect(k.code).toBe(3);
    expect(k.out.baseline.not_comparable).toEqual(["k differs: baseline 1,3,10, run 1,5"]);
  });

  test("with --allow-set-change, only the queries both runs have are compared", async () => {
    const { code, out } = await evalRun(
      "--set", writeSet("fewer.jsonl", SET.slice(0, 3)), "--baseline", "evals/baseline.json", "--allow-set-change"
    );
    expect(code).toBe(0);
    expect(out.baseline).toMatchObject({ only_in_baseline: ["dob"], only_in_run: [] });
    expect(out.baseline.modes[0].hit_at["1"].unchanged).toBe(3);
  });

  test("a missing baseline is refused before scoring; gate flags need --baseline", async () => {
    const missing = await evalRun("--set", "evals/set.jsonl", "--baseline", "evals/nope.json");
    expect(missing.code).toBe(2);
    expect(missing.stdout).toBe("");
    expect(missing.stderr).toContain("no baseline at evals/nope.json");
    for (const flag of [["--max-net-loss", "3"], ["--must-pass", "exact"], ["--allow-set-change"]]) {
      const run = await evalRun("--set", "evals/set.jsonl", ...flag);
      expect(run.code).toBe(2);
      expect(run.stderr).toContain(`${flag[0]} needs --baseline`);
    }
    const noOne = await evalRun("--set", "evals/set.jsonl", "--baseline", "evals/baseline.json", "--k", "3,10");
    expect(noOne.code).toBe(2);
    expect(noOne.stderr).toContain("--k must include 1");
  });
});

describe("--redact", () => {
  test("leaves out every query text and every path from the set, in the output and in --out", async () => {
    const texts = SET.map((q) => q.q);
    const paths = [...new Set(SET.flatMap((q) => q.expected))];
    expect(texts.every((t) => t.length > 0) && paths.length > 0).toBe(true);

    const { code, stdout, out } = await evalRun(
      "--set", "evals/set.jsonl", "--baseline", "evals/baseline.json", "--redact", "--out", "evals/shared.json"
    );
    expect(code).toBe(0);
    const written = readFileSync(join(root, "evals", "shared.json"), "utf-8");
    for (const text of [stdout, written]) {
      for (const t of texts) expect(text).not.toContain(t);
      for (const p of paths) expect(text).not.toContain(p);
    }
    expect(out.per_query.length).toBe(4);
    for (const q of out.per_query) expect(Object.keys(q)).not.toContain("q");
    expect(out.per_query.map((q: { id: string }) => q.id)).toEqual(["scope", "knee", "sleep", "dob"]);
    expect(out.rows[0].hit_at["1"]).toBe(1);
    expect(out.baseline.file).toBeNull();
  });

  test("a redacted run still works as a baseline", async () => {
    const { code, out } = await evalRun("--set", "evals/set.jsonl", "--baseline", "evals/shared.json");
    expect(code).toBe(0);
    expect(out.baseline.modes[0].hit_at["1"].unchanged).toBe(4);
  });
});

describe("brain doctor", () => {
  async function evalBaselineCheck(version: string) {
    const stored = JSON.parse(readFileSync(join(root, "evals", "baseline.json"), "utf-8"));
    stored.meta.version = version;
    writeFileSync(join(root, "evals", "baseline.json"), JSON.stringify(stored));
    writeFileSync(
      join(root, ".mcp.json"),
      JSON.stringify({ mcpServers: { brain: { command: "bun", args: ["node_modules/.bin/brain", "mcp"] } } })
    );
    const { stdout, code } = await runCli(root, ["doctor", "--json"]);
    expect(code).toBe(0);
    return JSON.parse(stdout).checks.find((c: { id: string }) => c.id === "eval-baseline");
  }

  test("reminds to re-run the baseline when it was recorded on another version, and not otherwise", async () => {
    const other = await evalBaselineCheck("0.0.0");
    expect(other).toMatchObject({ status: "warn", fix: "run `brain eval --baseline evals/baseline.json`" });
    expect(other.detail).toContain("recorded with 0.0.0");
    const same = await evalBaselineCheck(packageVersion());
    expect(same.status).toBe("pass");
    expect(same.fix).toBeUndefined();
  });
});

describe("the comparison", () => {
  test("the exact two-sided sign test", () => {
    expect(signTestP(0, 0)).toBe(1);
    expect(signTestP(2, 0)).toBeCloseTo(0.5, 12);
    expect(signTestP(5, 0)).toBeCloseTo(0.0625, 12);
    expect(signTestP(3, 1)).toBeCloseTo(0.625, 12);
    expect(signTestP(1, 8)).toBeCloseTo(0.0390625, 12);
    expect(signTestP(6, 0)).toBeCloseTo(0.03125, 12);
  });

  // Worked out with BigInt, exactly: 2 × Σ C(n, i) for i ≤ k, over 2^n.
  function reference(lost: number, gained: number): number {
    const n = BigInt(lost + gained);
    const k = BigInt(Math.min(lost, gained));
    let choose = 1n;
    let tail = 0n;
    for (let i = 0n; i <= k; i++) {
      tail += choose;
      choose = (choose * (n - i)) / (i + 1n);
    }
    const scale = 10n ** 30n;
    const p = Number((2n * tail * scale) / 2n ** n) / 1e30;
    return Math.min(1, p);
  }

  test("large, balanced and lopsided sets stay finite and match an exact BigInt reference", () => {
    for (const [lost, gained] of [[512, 512], [1000, 1000], [600, 400], [400, 600], [530, 470], [60, 40]]) {
      const p = signTestP(lost, gained);
      expect(Number.isFinite(p), `${lost}/${gained}`).toBe(true);
      expect(p, `${lost}/${gained}`).toBeCloseTo(reference(lost, gained), 12);
    }
    expect(signTestP(512, 512)).toBe(1);
    expect(signTestP(1000, 1000)).toBe(1);
    expect(signTestP(600, 400)).toBeGreaterThan(0);
  });

  test("no-answer queries are not compared; per class flips are reported", () => {
    const run = (hits: Record<string, boolean | null>): StoredRun => ({
      schema_version: 1,
      meta: { version: "x", set_sha256: "s", embedding_model: null, modes: ["fts"], k: [1] },
      per_query: Object.entries(hits).map(([id, hit]) => ({
        mode: "fts", id, class: id.startsWith("a") ? "alias" : "exact", hit_at: hit === null ? null : { "1": hit },
      })),
    });
    // `moved` became a no-answer query in the new set: nothing to compare.
    const report = compareRuns(
      run({ a1: true, e1: true, e2: false, none: null, moved: true }),
      run({ a1: false, e1: true, e2: true, none: null, moved: null }),
      { maxNetLoss: 2, mustPass: [], allowSetChange: false }
    );
    expect(report.modes[0].hit_at["1"]).toMatchObject({ lost: ["a1"], gained: ["e2"], unchanged: 1 });
    expect(report.modes[0].per_class).toEqual([
      { class: "alias", hit_at: { "1": { lost: ["a1"], gained: [], unchanged: 0 } } },
      { class: "exact", hit_at: { "1": { lost: [], gained: ["e2"], unchanged: 1 } } },
    ]);
    expect(report.gate.failed).toBe(false);
  });
});

describe("an incomplete baseline is refused, never compared", () => {
  const base = (): StoredRun => ({
    schema_version: 1,
    meta: { version: "x", set_sha256: "s", embedding_model: null, modes: ["fts", "hybrid"], k: [1, 10] },
    per_query: ["a", "b"].flatMap((id) =>
      ["fts", "hybrid"].map((mode) => ({ mode, id, class: "exact", hit_at: { "1": true, "10": true } }))
    ),
  });
  const refuse = (run: StoredRun) => expect(() => parseStoredRun(JSON.stringify(run))).toThrow(BaselineError);

  test("a complete run parses", () => {
    expect(parseStoredRun(JSON.stringify(base())).per_query).toHaveLength(4);
  });

  test("a hit_at without every k", () => {
    const run = base();
    run.per_query[0].hit_at = {};
    refuse(run);
    run.per_query[0].hit_at = { "1": true };
    refuse(run);
  });

  test("a mode missing some queries, a duplicate, or a mode meta does not name", () => {
    const missing = base();
    missing.per_query = missing.per_query.filter((q) => !(q.mode === "fts" && q.id === "b"));
    refuse(missing);
    const duplicate = base();
    duplicate.per_query.push({ ...duplicate.per_query[0] });
    refuse(duplicate);
    const stray = base();
    stray.per_query.push({ mode: "vector", id: "a", class: "exact", hit_at: { "1": true, "10": true } });
    refuse(stray);
  });

  test("null hits only for a no-answer query, and a query keeps its class in every mode", () => {
    const answerableNull = base();
    answerableNull.per_query[0].hit_at = null;
    refuse(answerableNull);
    const noAnswerHits = base();
    for (const q of noAnswerHits.per_query) if (q.id === "b") q.class = "no-answer";
    refuse(noAnswerHits);
    const classDrift = base();
    const drifted = classDrift.per_query.find((q) => q.id === "b" && q.mode === "hybrid")!;
    drifted.class = "no-answer";
    drifted.hit_at = null;
    refuse(classDrift);
    // The legitimate shape still parses: a no-answer query, null in every mode.
    const noAnswer = base();
    for (const q of noAnswer.per_query) if (q.id === "b") Object.assign(q, { class: "no-answer", hit_at: null });
    expect(parseStoredRun(JSON.stringify(noAnswer)).per_query).toHaveLength(4);
  });

  test("the CLI refuses answerable null hits with exit 2 instead of skipping them", async () => {
    const stored = JSON.parse(readFileSync(join(root, "evals", "baseline.json"), "utf-8"));
    expect(stored.per_query[0].class).toBe("exact");
    stored.per_query[0].hit_at = null;
    writeFileSync(join(root, "evals", "nulled.json"), JSON.stringify(stored));
    const { code, stdout, stderr } = await evalRun("--set", "evals/set.jsonl", "--baseline", "evals/nulled.json");
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain(`query "scope" in mode fts is answerable but has no hits`);
  });

  test("the CLI refuses such a baseline with exit 2 before scoring", async () => {
    const stored = JSON.parse(readFileSync(join(root, "evals", "baseline.json"), "utf-8"));
    stored.per_query[0].hit_at = {};
    writeFileSync(join(root, "evals", "partial.json"), JSON.stringify(stored));
    const { code, stdout, stderr } = await evalRun("--set", "evals/set.jsonl", "--baseline", "evals/partial.json");
    expect(code).toBe(2);
    expect(stdout).toBe("");
    expect(stderr).toContain("not a complete brain eval run");
  });

  test("a gate flag out of range is a usage error: exit 2, never the gate's 1", async () => {
    const { code, stderr } = await evalRun("--set", "evals/set.jsonl", "--baseline", "evals/baseline.json", "--max-net-loss", "0");
    expect(code).toBe(2);
    expect(stderr).toContain("--max-net-loss takes a positive integer");
  });
});

describe("--redact in the human output", () => {
  // Its own brain: a note that quotes the set's queries, so `warnings` names
  // a document, and a set whose third query misses, so the missed-query
  // line would print the path search returned instead.
  let brain: string;
  const texts = SET.map((q) => q.q);
  const MISSING = { ...SET[2], expected: ["me/identity.md"] };

  beforeAll(async () => {
    brain = makeTempBrain();
    mkdirSync(join(brain, "evals"), { recursive: true });
    writeFileSync(
      join(brain, "notes", "eval-notes.md"),
      `---\ntitle: Eval notes\ntype: note\ncreated: 2026-07-01\nupdated: 2026-07-01\n---\n\n${texts.join(", ")}\n`
    );
    expect((await runCli(brain, ["index", "--json"])).code).toBe(0);
    const set = [SET[0], SET[1], MISSING, SET[3]];
    writeFileSync(join(brain, "evals", "set.jsonl"), [{ now: "2026-07-12" }, ...set].map((l) => JSON.stringify(l)).join("\n"));
    const stored = await runCli(brain, ["eval", "--mode", "fts", "--rerank", "heuristic", "--json", "--set", "evals/set.jsonl", "--out", "evals/baseline.json"]);
    expect(stored.code).toBe(0);
    expect(JSON.parse(stored.stdout).warnings.join(" ")).toContain("notes/eval-notes.md");
  });
  afterAll(() => cleanup(brain));

  test("no query text, set path, document path or baseline file reaches the human output", async () => {
    const args = ["eval", "--mode", "fts", "--rerank", "heuristic", "--set", "evals/set.jsonl", "--baseline", "evals/baseline.json"];
    const plain = await runCli(brain, [...args, "--human"]);
    // Without --redact the leaks are real: the warning and the missed query name paths.
    expect(plain.stdout).toContain("notes/eval-notes.md");
    expect(plain.stdout).toContain("Missed at hit@1");
    expect(plain.stdout).toContain("evals/baseline.json");

    const redacted = await runCli(brain, [...args, "--human", "--redact"]);
    expect(redacted.code).toBe(0);
    expect(redacted.stdout).toContain("Missed at hit@1");
    expect(redacted.stdout).toContain("top: (withheld)");
    for (const leak of [...texts, "notes/eval-notes.md", "me/identity.md", "evals/baseline.json", "evals/set.jsonl"]) {
      expect(redacted.stdout, leak).not.toContain(leak);
    }
    const json = JSON.parse((await runCli(brain, [...args, "--json", "--redact"])).stdout);
    expect(json.meta).toMatchObject({ set: null, source: null });
    expect(json.warnings).toEqual(["1 warning(s) withheld by --redact"]);
  });

  test("the human comparison prints the per-class flips", async () => {
    const swapped = [SET[0], { ...SET[1], expected: ["me/identity.md"] }, MISSING, SET[3]];
    writeFileSync(join(brain, "evals", "swapped.jsonl"), [{ now: "2026-07-12" }, ...swapped].map((l) => JSON.stringify(l)).join("\n"));
    const { stdout } = await runCli(brain, [
      "eval", "--mode", "fts", "--rerank", "heuristic", "--human", "--set", "evals/swapped.jsonl",
      "--baseline", "evals/baseline.json", "--allow-set-change",
    ]);
    // The quoting note already outranks the knee note at hit@1 in this brain,
    // so the loss shows at hit@3, and per class under it.
    expect(stdout).toContain("[fts] hit@3: lost 1 (knee), gained 0 (-), unchanged 3");
    expect(stdout).toContain("[fts] hit@3: lost 1 (knee), gained 0 (-), unchanged 3, sign test p 1.00\n      exact: lost 1 (knee), gained 0 (-), unchanged 2\n      alias: lost 0 (-), gained 0 (-), unchanged 1");
  });
});

describe("--redact on a refused run", () => {
  // A populated failure for each refusal that names documents or quotes the
  // set, run once without --redact to show the leak is real, then with it.
  let brain: string;
  const texts = SET.map((q) => q.q);
  const eval_ = (...args: string[]) => runCli(brain, ["eval", "--mode", "fts", "--rerank", "heuristic", "--json", ...args]);
  const set = (name: string, lines: object[]) => {
    writeFileSync(join(brain, "evals", name), [{ now: "2026-07-12" }, ...lines].map((l) => JSON.stringify(l)).join("\n"));
    return `evals/${name}`;
  };

  /** Refused both ways; `leaks` are in the plain stderr and nowhere in the redacted run. */
  async function refusedBothWays(args: string[], leaks: string[]) {
    const plain = await eval_(...args);
    expect(plain.code).toBe(2);
    for (const leak of leaks) expect(plain.stderr, leak).toContain(leak);
    const redacted = await eval_(...args, "--redact");
    expect(redacted.code).toBe(2);
    expect(redacted.stdout).toBe("");
    for (const leak of leaks) expect(redacted.stderr, leak).not.toContain(leak);
    return redacted.stderr;
  }

  beforeAll(async () => {
    brain = makeTempBrain();
    mkdirSync(join(brain, "evals"), { recursive: true });
    writeFileSync(
      join(brain, "notes", "eval-notes.md"),
      `---\ntitle: Eval notes\ntype: note\ncreated: 2026-07-01\nupdated: 2026-07-01\n---\n\n${texts.join(", ")}\n`
    );
    expect((await runCli(brain, ["index", "--json"])).code).toBe(0);
    set("set.jsonl", SET);
  });
  afterAll(() => cleanup(brain));

  test("an expected path that does not exist: the reason stays, the paths do not", async () => {
    const missing = set("missing.jsonl", [{ ...SET[0], expected: ["notes/withheld-plan.md"] }]);
    const stderr = await refusedBothWays(["--set", missing], ["notes/withheld-plan.md"]);
    expect(stderr).toContain("1 expected path(s) do not exist in the brain");
    expect(stderr).toContain("1 detail(s) withheld by --redact");
  });

  test("a stale index names no document", async () => {
    const extra = join(brain, "notes", "unindexed-draft.md");
    writeFileSync(extra, "---\ntitle: Draft\ntype: note\ncreated: 2026-07-01\nupdated: 2026-07-01\n---\n\nBody.\n");
    try {
      const stderr = await refusedBothWays(["--set", "evals/set.jsonl"], ["notes/unindexed-draft.md"]);
      expect(stderr).toContain("the index is older than the markdown");
    } finally {
      rmSync(extra);
    }
  });

  test("--strict contamination names neither the document nor the query text", async () => {
    const stderr = await refusedBothWays(["--set", "evals/set.jsonl", "--strict"], ["notes/eval-notes.md"]);
    for (const t of texts) expect(stderr, t).not.toContain(t);
    expect(stderr).toContain("contain the set's queries (--strict)");
  });

  test("a malformed set line keeps its file and line, not the parser's quote of it", async () => {
    writeFileSync(join(brain, "evals", "broken.jsonl"), `{"now":"2026-07-12"}\n{"id":"x","q":confidential words}\n`);
    const stderr = await refusedBothWays(["--set", "evals/broken.jsonl"], ["confidential"]);
    expect(stderr).toContain("evals/broken.jsonl: line 2: malformed (withheld by --redact)");
  });

  test("a baseline that is not JSON keeps its file, not the parser's quote of it", async () => {
    writeFileSync(join(brain, "evals", "broken.json"), `{"q": confidential}`);
    const stderr = await refusedBothWays(["--set", "evals/set.jsonl", "--baseline", "evals/broken.json"], ["confidential"]);
    expect(stderr).toContain("evals/broken.json is not valid JSON");
  });

  test("an error about a path given on the command line still repeats it", async () => {
    const set_ = await eval_("--set", "evals/typed-by-hand.jsonl", "--redact");
    expect(set_.code).toBe(2);
    expect(set_.stderr).toContain("evals/typed-by-hand.jsonl");
    const baseline = await eval_("--set", "evals/set.jsonl", "--baseline", "evals/typed-baseline.json", "--redact");
    expect(baseline.code).toBe(2);
    expect(baseline.stderr).toContain("evals/typed-baseline.json");
  });
});
