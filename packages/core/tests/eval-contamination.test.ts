/**
 * Eval material is never indexed, and `brain eval` flags an indexed document
 * that quotes the set's queries: a note that repeats the questions becomes
 * their best answer, so the eval would grade itself.
 */

import { afterEach, expect, test } from "bun:test";
import { chmodSync, mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const temps: string[] = [];
afterEach(() => {
  while (temps.length) cleanup(temps.pop()!);
});

// The default set path. The tests write their own set there: three short
// queries, each a known top-1 hit (the fixture's committed set is the
// goldens' and quotes its own targets by design).
const SET = "evals/retrieval.jsonl";
const THREE = [
  { id: "telescope-setup", q: "telescope setup", class: "exact", expected: ["studies/telescope-setup.md"] },
  { id: "knee-injury", q: "knee injury", class: "exact", expected: ["health/knee-injury.md"] },
  { id: "sleep-tracking", q: "sleep tracking", class: "exact", expected: ["health/sleep-tracking.md"] },
];

function note(body: string): string {
  return `---\ntitle: Eval notes\ntype: note\ncreated: 2026-07-01\nupdated: 2026-07-01\n---\n\n${body}\n`;
}

/** A temp fixture brain with `files` added, then indexed. */
async function brainWith(files: Record<string, string>): Promise<string> {
  const root = makeTempBrain();
  temps.push(root);
  writeFileSync(join(root, SET), THREE.map((q) => JSON.stringify(q)).join("\n"));
  for (const [rel, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, rel)), { recursive: true });
    writeFileSync(join(root, rel), content);
  }
  expect((await runCli(root, ["index", "--json"])).code).toBe(0);
  return root;
}

async function evalRun(root: string, ...flags: string[]) {
  const run = await runCli(root, ["eval", "--mode", "fts", "--json", ...flags]);
  return { ...run, out: run.code === 0 ? JSON.parse(run.stdout) : undefined };
}

const QUOTING = note("Queries I test search with:\n\n- Telescope  setup\n- knee injury\n- SLEEP tracking\n");

test("the three-query set scores with no contamination warning", async () => {
  const { code, out } = await evalRun(await brainWith({}));
  expect(code).toBe(0);
  expect(out.per_query).toHaveLength(3);
  expect(out.warnings).toEqual([]);
});

test("a note quoting three of the set's queries is named in warnings", async () => {
  const { code, out } = await evalRun(await brainWith({ "notes/eval-notes.md": QUOTING }));
  expect(code).toBe(0);
  expect(out.warnings).toEqual([
    "contamination: notes/eval-notes.md contains the text of 3 of the set's queries (telescope-setup, knee-injury, sleep-tracking)",
  ]);
});

test("--strict refuses the same run with exit 2 and no score", async () => {
  const { code, stdout, stderr } = await evalRun(await brainWith({ "notes/eval-notes.md": QUOTING }), "--strict");
  expect(code).toBe(2);
  expect(stdout).toBe("");
  expect(stderr).toContain("notes/eval-notes.md contains the text of 3 of the set's queries");
});

test("one quoted query of four or more words is enough; two short ones are not", async () => {
  const set = [
    { id: "long", q: "how is the telescope set up", class: "question", expected: ["studies/telescope-setup.md"] },
    { id: "knee", q: "knee injury", class: "exact", expected: ["health/knee-injury.md"] },
    { id: "sleep", q: "sleep tracking", class: "exact", expected: ["health/sleep-tracking.md"] },
  ];
  const root = await brainWith({
    [SET]: set.map((q) => JSON.stringify(q)).join("\n"),
    "notes/long.md": note("Someone asked: How is the\ntelescope set up?"),
    "notes/short.md": note("Two of them: knee injury and sleep tracking."),
  });
  const { code, out } = await evalRun(root);
  expect(code).toBe(0);
  expect(out.warnings).toEqual(["contamination: notes/long.md contains the text of 1 of the set's queries (long)"]);
});

test("the same note inside evals/ is not indexed, so it cannot contaminate", async () => {
  const root = await brainWith({ "evals/eval-notes.md": QUOTING });
  const search = await runCli(root, ["search", "knee injury", "--mode", "fts", "--json"]);
  expect(JSON.parse(search.stdout).results.map((r: { path: string }) => r.path)).not.toContain("evals/eval-notes.md");
  const { code, out } = await evalRun(root);
  expect(code).toBe(0);
  expect(out.warnings).toEqual([]);
});

// The scan reads the same bytes as the freshness check, so a document it
// cannot read refuses the run by name instead of dropping out of the scan.
test.skipIf(process.getuid?.() === 0)("an indexed note that cannot be read refuses the run, even without --strict", async () => {
  const root = await brainWith({ "notes/eval-notes.md": QUOTING });
  const path = join(root, "notes", "eval-notes.md");
  chmodSync(path, 0o000);
  try {
    for (const flags of [[], ["--strict"]]) {
      const { code, stdout, stderr } = await evalRun(root, ...flags);
      expect(stderr).toContain("notes/eval-notes.md: cannot be read to check it against the index");
      expect(code).toBe(2);
      expect(stdout).toBe("");
    }
  } finally {
    chmodSync(path, 0o644);
  }
});

// Exact-title and alias queries quote their own target by construction; the
// check is about notes that teach search the eval, not about answers.
test("title and alias queries do not flag the document they expect", async () => {
  const root = await brainWith({
    [SET]: [
      { id: "title", q: "Telescope Setup & Collimation", class: "exact", expected: ["studies/telescope-setup.md"] },
      { id: "dob", q: "the Dobsonian", class: "alias", expected: ["studies/telescope-setup.md"] },
      { id: "scope", q: "my scope", class: "alias", expected: ["studies/telescope-setup.md"] },
    ].map((q) => JSON.stringify(q)).join("\n"),
  });
  const { code, out } = await evalRun(root);
  expect(code).toBe(0);
  expect(out.per_query).toHaveLength(3);
  expect(out.warnings).toEqual([]);
});
