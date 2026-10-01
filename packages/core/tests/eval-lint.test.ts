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

const PATH = "studies/star-bearings.md";

async function lint(lines: unknown[]) {
  writeFileSync(join(root, "evals/lint.jsonl"), lines.map((l) => (typeof l === "string" ? l : JSON.stringify(l))).join("\n") + "\n");
  const res = await runCli(root, ["eval", "--lint", "--set", "evals/lint.jsonl", "--json"]);
  return { ...res, out: res.code === 0 ? JSON.parse(res.stdout) : null };
}

test("the premise: the brain has no index for --lint to open", () => {
  expect(existsSync(join(root, "brain.db"))).toBe(false);
});

test("a paraphrase query sharing a word with its answer's title is reported, naming the word and the path", async () => {
  const { code, out } = await lint([{ id: "q1", q: "how do I keep the star guide aligned", class: "paraphrase", expected: [PATH] }]);
  expect(code).toBe(0);
  expect(out.warnings).toEqual([`q1: shares "star guide" with the title of ${PATH}`]);
  expect(existsSync(join(root, "brain.db"))).toBe(false);
});

test("the same query with the word replaced is not", async () => {
  const { code, out } = await lint([{ id: "q1", q: "how do I keep the scope aligned", class: "paraphrase", expected: [PATH] }]);
  expect(code).toBe(0);
  expect(out.warnings).toEqual([]);
  expect(out.meta.queries).toBe(1);
});

test("function words and letter case do not count as leakage", async () => {
  // The title is "Barred eagle on the north loop": "on" and "the" are stopwords.
  const { out } = await lint([{ id: "q1", q: "What did I see on the route at dusk", class: "paraphrase", expected: ["notes/quick-note-eagle.md"] }]);
  expect(out.warnings).toEqual([]);
  const { out: cased } = await lint([{ id: "q2", q: "that EAGLE I saw", class: "paraphrase", expected: ["notes/quick-note-eagle.md"] }]);
  expect(cased.warnings).toEqual(['q2: shares "eagle" with the title of notes/quick-note-eagle.md']);
});

test("a query of another class may share title words", async () => {
  const { out } = await lint([{ id: "q1", q: "star guide setup", class: "keyword", expected: [PATH] }]);
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

// Accented words (#506 review): the lint predicts what FTS matches, and the
// index's unicode61 tokenizer strips diacritics. So words are compared whole,
// with their marks stripped, and the stopword check runs after stripping. The
// warning names the query's word as written. Escapes keep the forms visible.
const leaks = (q: string, title: string) =>
  titleLeaks([{ id: "q1", q, class: PARAPHRASE_CLASS, expected: ["t.md"] }], () => title);

test("an accented word shared with the title is reported whole, in either Unicode form", () => {
  const precomposed = "r\u00e9sum\u00e9";
  const decomposed = "re\u0301sume\u0301";
  expect(leaks(`where is my ${precomposed}`, "R\u00c9SUM\u00c9 draft")).toEqual([`q1: shares "${precomposed}" with the title of t.md`]);
  expect(leaks(`where is my ${decomposed}`, `${precomposed} draft`)).toEqual([`q1: shares "${precomposed}" with the title of t.md`]);
});

test("a word that differs from the title's only by accents is reported, since FTS matches it", () => {
  expect(leaks("where is my resume", "R\u00e9sum\u00e9 draft")).toEqual(['q1: shares "resume" with the title of t.md']);
  expect(leaks("where is my r\u00e9sum\u00e9", "Resume draft")).toEqual(['q1: shares "r\u00e9sum\u00e9" with the title of t.md']);
});

test("the stopword check runs after stripping: th\u00e9 folds to the and is dropped", () => {
  expect(leaks("a cup of th\u00e9", "Th\u00e9 at noon")).toEqual([]);
  expect(leaks("a cup of th\u00e9 at dusk", "Dusk th\u00e9")).toEqual(['q1: shares "dusk" with the title of t.md']);
});

test("--redact keeps the findings' count, not the titles, query words, paths or the parser's quote", async () => {
  const leaky = { id: "q1", q: "how do I keep the star guide aligned", class: "paraphrase", expected: [PATH] };
  const plain = await lint([leaky]);
  expect(plain.out.warnings.join(" ")).toContain(PATH);
  const args = ["eval", "--lint", "--set", "evals/lint.jsonl", "--redact"];
  const json = await runCli(root, [...args, "--json"]);
  expect(json.code).toBe(0);
  const human = await runCli(root, [...args, "--human"]);
  expect(human.code).toBe(0);
  for (const out of [json.stdout, human.stdout]) {
    for (const leak of [PATH, "star guide", "evals/lint.jsonl"]) expect(out, leak).not.toContain(leak);
  }
  expect(JSON.parse(json.stdout)).toMatchObject({ meta: { set: null, queries: 1 }, warnings: ["1 warning(s) withheld by --redact"] });

  // With no findings, the human line that names the set names it only as "The set".
  await lint([{ ...leaky, q: "how do I keep the scope aligned" }]);
  const clean = await runCli(root, [...args, "--human"]);
  expect(clean.stdout).toBe("The set: 1 queries, no lint findings.\n");

  writeFileSync(join(root, "evals/lint.jsonl"), `{"id":"q1","q":confidential words}\n`);
  const broken = await runCli(root, [...args, "--json"]);
  expect(broken.code).toBe(2);
  expect(broken.stderr).not.toContain("confidential");
  expect(broken.stderr).toContain("evals/lint.jsonl: line 1: malformed (withheld by --redact)");
});
