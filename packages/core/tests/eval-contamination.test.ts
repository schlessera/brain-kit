/**
 * Eval material is never indexed, and `brain eval` flags an indexed document
 * that quotes the set's queries: a note that repeats the questions becomes
 * their best answer, so the eval would grade itself.
 */

import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { dirname, join } from "path";

import { cleanup, makeTempBrain, runCli } from "./cli-harness";

const temps: string[] = [];
afterEach(() => {
  while (temps.length) cleanup(temps.pop()!);
});

// The fixture's own set: three short queries, each a known top-1 hit.
const SET = "evals/retrieval.jsonl";

function note(body: string): string {
  return `---\ntitle: Eval notes\ntype: note\ncreated: 2026-07-01\nupdated: 2026-07-01\n---\n\n${body}\n`;
}

/** A temp fixture brain with `files` added, then indexed. */
async function brainWith(files: Record<string, string>): Promise<string> {
  const root = makeTempBrain();
  temps.push(root);
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

test("the fixture set scores with no contamination warning", async () => {
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
