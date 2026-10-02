import { afterAll, beforeAll, expect, test } from "bun:test";

import { createBrainAccess } from "../src/brain-access";
import { makeIndexedBrain, type TempBrain } from "./helpers";

// Same brain as core's rerank-half-lives.test.ts: the note wins on BM25, and
// the logbook wins only when its configured half-life reaches the reranker.
const LOGBOOK = "logbook/lantern.md";
const NOTE = "notes/lantern.md";

let brain: TempBrain;

beforeAll(async () => {
  brain = await makeIndexedBrain({
    "brain.config.ts": `export default { taxonomy: { types: { logbook: { dir: "logbook", halfLifeDays: 100000 } } } };\n`,
    [LOGBOOK]: `---\ntype: logbook\ntitle: "Sailor lantern"\nupdated: 2020-01-01\nrelevance: secondary\n---\n\nChecked the lantern at the cave on Ogygia after the storm.\n`,
    [NOTE]: `---\ntype: note\ntitle: "Sailor lantern"\nupdated: 2020-01-01\nrelevance: secondary\n---\n\nThe lantern wick.\n`,
  });
});

afterAll(() => brain.cleanup());

test("the note leads on the full-text score alone", async () => {
  const { results } = await createBrainAccess(brain.root).search({ query: "lantern", mode: "fts", rerank: "none" });
  expect(results.map((r) => r.path)).toEqual([NOTE, LOGBOOK]);
});

test("search passes the brain's taxonomy to the reranker", async () => {
  const { results } = await createBrainAccess(brain.root).search({ query: "lantern", mode: "fts" });
  expect(results.map((r) => r.path)).toEqual([LOGBOOK, NOTE]);
});

test("context passes the brain's taxonomy to the reranker", async () => {
  const text = await createBrainAccess(brain.root).context("lantern");
  expect(text.indexOf(`(${LOGBOOK})`)).toBeGreaterThanOrEqual(0);
  expect(text.indexOf(`(${LOGBOOK})`)).toBeLessThan(text.indexOf(`(${NOTE})`));
});
