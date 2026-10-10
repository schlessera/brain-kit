/** Raw type/tag scoring against the provisional labels. Scripted goldens score 1.0 by construction and prove nothing. */
import type { SourceCase } from "./benchmark";
export const REVIEW = "needs-review";
/** The classifier's raw output for one case, before owner protection; `refused` is a thrown provider error or no output. */
export type Prediction = { type: string; tags: string[] } | { refused: string };
export interface SplitScore {
  cases: number; scored: number; abstained: number;
  typeCorrect: number; typeAccuracy: number | null; confusion: Record<string, Record<string, number>>;
  unclearRouted: number; falseCompletions: number;
  tags: { tp: number; fp: number; fn: number; precision: number | null; recall: number | null; f1: number | null };
}
const ratio = (n: number, d: number) => d ? n / d : null;
/** Golden `unclear` means the only acceptable completed output is the review route. */
export const expectedType = (c: SourceCase) => c.type === "unclear" ? REVIEW : c.type;
export function score(cases: SourceCase[], predictions: Record<string, Prediction | undefined>, vocabulary: string[]): Record<"tuning" | "held-out" | "all", SplitScore> {
  const empty = (): SplitScore => ({ cases: 0, scored: 0, abstained: 0, typeCorrect: 0, typeAccuracy: null, confusion: {}, unclearRouted: 0, falseCompletions: 0, tags: { tp: 0, fp: 0, fn: 0, precision: null, recall: null, f1: null } });
  const out = { tuning: empty(), "held-out": empty(), all: empty() };
  for (const c of cases) {
    const p = predictions[c.id];
    for (const s of [out[c.split], out.all]) {
      s.cases++;
      if (!p || "refused" in p) { s.abstained++; continue; }
      s.scored++;
      const golden = expectedType(c);
      ((s.confusion[golden] ??= {})[p.type] ??= 0); s.confusion[golden]![p.type]!++;
      if (p.type === golden) s.typeCorrect++;
      if (c.type === "unclear") { if (p.type === REVIEW) s.unclearRouted++; else s.falseCompletions++; }
      for (const tag of vocabulary) {
        const want = c.tags.includes(tag), got = p.tags.includes(tag);
        if (want && got) s.tags.tp++; else if (got) s.tags.fp++; else if (want) s.tags.fn++;
      }
    }
  }
  for (const s of Object.values(out)) {
    s.typeAccuracy = ratio(s.typeCorrect, s.cases);
    s.tags.precision = ratio(s.tags.tp, s.tags.tp + s.tags.fp); s.tags.recall = ratio(s.tags.tp, s.tags.tp + s.tags.fn);
    s.tags.f1 = s.tags.precision === null || s.tags.recall === null ? null : ratio(2 * s.tags.precision * s.tags.recall, s.tags.precision + s.tags.recall);
  }
  return out;
}
/** Parse a provider's raw JSON reply into a prediction; anything unparseable counts as a refusal, never as a label. */
export function predictionFrom(output: string | null | undefined): Prediction {
  if (!output) return { refused: "no output" };
  try {
    const v = JSON.parse(output);
    if (v && typeof v === "object" && typeof v.type === "string" && Array.isArray(v.tags) && v.tags.every((t: unknown) => typeof t === "string")) return { type: v.type, tags: v.tags };
    return { refused: "malformed classification output" };
  } catch { return { refused: "malformed classification output" }; }
}
