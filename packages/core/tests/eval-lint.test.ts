/**
 * `brain eval --lint` (#380): validates a query set and reports title
 * leakage in its `paraphrase` queries, without scoring and without the
 * index. The temp brain is a copy of the fixture corpus that is never
 * indexed, so there is no brain.db for the command to open.
 */

import { afterAll, beforeAll, expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "fs";
import { join } from "path";

import { PARAPHRASE_CLASS, titleLeaks } from "../src/lib/retrieval-eval";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";

let root: string;
beforeAll(() => {
  root = makeTempBrain();
  mkdirSync(join(root, "evals"), { recursive: true });
});
afterAll(() => cleanup(root));

const PATH = "studies/telescope-setup.md";

async function lint(lines: unknown[]) {
  writeFileSync(join(root, "evals/lint.jsonl"), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  const res = await runCli(root, ["eval", "--lint", "--set", "evals/lint.jsonl", "--json"]);
  return { ...res, out: res.code === 0 ? JSON.parse(res.stdout) : null };
}

test("the premise: the brain has no index for --lint to open", () => {
  expect(existsSync(join(root, "brain.db"))).toBe(false);
});

test("a paraphrase query sharing a word with its answer's title is reported, naming the word and the path", async () => {
  const { code, out } = await lint([{ id: "q1", q: "how do I keep the telescope aligned", class: "paraphrase", expected: [PATH] }]);
  expect(code).toBe(0);
  expect(out.warnings).toEqual([`q1: shares "telescope" with the title of ${PATH}`]);
  expect(existsSync(join(root, "brain.db"))).toBe(false);
});

test("the same query with the word replaced is not", async () => {
  const { code, out } = await lint([{ id: "q1", q: "how do I keep the scope aligned", class: "paraphrase", expected: [PATH] }]);
  expect(code).toBe(0);
  expect(out.warnings).toEqual([]);
  expect(out.meta.queries).toBe(1);
});

test("function words and letter case do not count as leakage", async () => {
  // The title is "Barred owl on the north loop": "on" and "the" are stopwords.
  const { out } = await lint([{ id: "q1", q: "What did I see on the trail at dusk", class: "paraphrase", expected: ["notes/quick-note-owl.md"] }]);
  expect(out.warnings).toEqual([]);
  const { out: cased } = await lint([{ id: "q2", q: "that OWL I saw", class: "paraphrase", expected: ["notes/quick-note-owl.md"] }]);
  expect(cased.warnings).toEqual(['q2: shares "owl" with the title of notes/quick-note-owl.md']);
});

test("a query of another class may share title words", async () => {
  const { out } = await lint([{ id: "q1", q: "telescope setup", class: "keyword", expected: [PATH] }]);
  expect(out.warnings).toEqual([]);
});

test("a malformed line exits 2 naming the line, without an index", async () => {
  const { code, stderr } = await lint([{ id: "q1", q: "fine", class: "paraphrase", expected: [PATH] }, "{not json"]);
  expect(code).toBe(2);
  expect(stderr).toContain("line 2");
  expect(existsSync(join(root, "brain.db"))).toBe(false);
});

test("a candidate valid on its own is refused when linted with the set it joins (the brain-eval skill's check)", async () => {
  const candidate = { id: "q1", q: "where is the scope guide", class: "paraphrase", expected: [PATH] };
  expect((await lint([candidate])).code).toBe(0);
  const { code, stderr } = await lint([{ id: "q1", q: "fine", class: "keyword", expected: [PATH] }, candidate]);
  expect(code).toBe(2);
  expect(stderr).toContain("line 2");
});

// Accented words (#506 review): caseFold decomposes, so a word must keep its
// combining marks to be compared whole. Escapes keep the decomposed form visible.
const leaks = (q: string, title: string) =>
  titleLeaks([{ id: "q1", q, class: PARAPHRASE_CLASS, expected: ["t.md"] }], () => title);

test("an accented word shared with the title is reported whole, in either Unicode form", () => {
  const precomposed = "résumé";
  const decomposed = "résumé";
  expect(leaks(`where is my ${precomposed}`, `RÉSUMÉ draft`)).toEqual([`q1: shares "${precomposed}" with the title of t.md`]);
  expect(leaks(`where is my ${decomposed}`, `${precomposed} draft`)).toEqual([`q1: shares "${precomposed}" with the title of t.md`]);
});

test("an accent is part of the word: thé is not the stopword the", () => {
  expect(leaks("a cup of thé", "Thé at noon")).toEqual(['q1: shares "thé" with the title of t.md']);
  expect(leaks("a cup of thé", "The noon break")).toEqual([]);
});
