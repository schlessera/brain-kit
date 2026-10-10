import { expect, test } from "bun:test";
import { benchmark, definitions } from "../scripts/evals/import-enrichment/benchmark";
import { score, predictionFrom, expectedType, REVIEW, type Prediction } from "../scripts/evals/import-enrichment/score";

const vocabulary = Object.keys(definitions.tags);
const golden = () => Object.fromEntries(benchmark.map(c => [c.id, { type: expectedType(c), tags: [...c.tags] } as Prediction]));
const unclear = benchmark.filter(c => c.type === "unclear");

test("golden predictions score perfectly and the benchmark has both unclear cases and every tag to lose", () => {
  const s = score(benchmark, golden(), vocabulary);
  expect(s.all.cases).toBe(18); expect(s.all.scored).toBe(18); expect(s.all.abstained).toBe(0);
  expect(s.all.typeAccuracy).toBe(1); expect(s.all.tags.f1).toBe(1); expect(s.all.falseCompletions).toBe(0);
  // The fields the later mutations lean on must be non-empty here, or those assertions could not move.
  expect(unclear.length).toBeGreaterThanOrEqual(2); expect(s.all.unclearRouted).toBe(unclear.length);
  expect(s.all.tags.tp).toBe(benchmark.reduce((n, c) => n + c.tags.length, 0)); expect(s.all.tags.tp).toBeGreaterThan(20);
  expect(s.tuning.cases).toBe(6); expect(s["held-out"].cases).toBe(12);
});

test("a wrong type, a dropped tag, a spurious tag and a completed unclear case each move exactly their own metric", () => {
  const p = golden();
  const heldLogbook = benchmark.find(c => c.split === "held-out" && c.type === "logbook")!, heldUnclear = unclear.find(c => c.split === "held-out")!;
  const tagged = benchmark.find(c => c.split === "tuning" && c.tags.length >= 2)!, untagged = benchmark.find(c => c.split === "tuning" && c.tags.length <= 1)!;
  p[heldLogbook.id] = { type: "ruling", tags: [...heldLogbook.tags] };
  p[heldUnclear.id] = { type: "note", tags: [...heldUnclear.tags] };
  p[tagged.id] = { type: tagged.type, tags: tagged.tags.slice(1) };
  p[untagged.id] = { type: expectedType(untagged), tags: [...untagged.tags, vocabulary.find(t => !untagged.tags.includes(t))!] };
  const s = score(benchmark, p, vocabulary), reference = score(benchmark, golden(), vocabulary);
  expect(s["held-out"].typeCorrect).toBe(10); expect(s["held-out"].typeAccuracy).toBeCloseTo(10 / 12, 10);
  expect(s["held-out"].confusion.logbook!.ruling).toBe(1); expect(s["held-out"].confusion[REVIEW]!.note).toBe(1);
  expect(s["held-out"].falseCompletions).toBe(1); expect(s["held-out"].unclearRouted).toBe(reference["held-out"].unclearRouted - 1);
  expect(s.tuning.typeAccuracy).toBe(1);
  expect(s.tuning.tags.fn).toBe(1); expect(s.tuning.tags.fp).toBe(1); expect(s.tuning.tags.tp).toBe(reference.tuning.tags.tp - 1);
  expect(s.tuning.tags.recall).toBeLessThan(1); expect(s.tuning.tags.precision).toBeLessThan(1);
  expect(s.all.tags.f1).toBeLessThan(1);
});

test("a refused or missing prediction is an abstention, counted against accuracy but never as a wrong label", () => {
  const p = golden(), refused = benchmark[0]!, missing = benchmark[1]!;
  p[refused.id] = { refused: "Uncertain controlled tags; no completed write" }; delete p[missing.id];
  const s = score(benchmark, p, vocabulary);
  expect(s.all.abstained).toBe(2); expect(s.all.scored).toBe(16); expect(s.all.typeCorrect).toBe(16);
  expect(s.all.typeAccuracy).toBeCloseTo(16 / 18, 10);
  expect(Object.values(s.all.confusion).flatMap(row => Object.values(row)).reduce((a, b) => a + b, 0)).toBe(16);
  expect(s.all.tags.fn).toBe(0); expect(s.all.tags.fp).toBe(0);
});

test("raw provider replies parse into predictions and anything else is a refusal", () => {
  expect(predictionFrom(JSON.stringify({ type: "logbook", tags: ["navigation"], summary: "ignored" }))).toEqual({ type: "logbook", tags: ["navigation"] });
  expect(predictionFrom(JSON.stringify({ type: REVIEW, tags: [] }))).toEqual({ type: REVIEW, tags: [] });
  for (const bad of [null, "", "not json", JSON.stringify({ tags: ["navigation"] }), JSON.stringify({ type: "note", tags: "navigation" })]) expect(predictionFrom(bad)).toHaveProperty("refused");
});
