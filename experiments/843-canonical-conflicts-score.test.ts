import { expect, test } from "bun:test";
import { metrics, type Row } from "../evals/843-canonical-conflicts/score";
const row = (id: string, gold: Row["gold"], label: Row["label"], rep = 0): Row => ({ id, gold, label, rep, split: "held-out", arm: "candidate" });
test("unknown goldens and wrong targets veto a reported conflict; invalids cannot score", () => {
  const scored = metrics([row("true", "yes", "yes"), row("unknown", "unknown", "yes"),
    { ...row("wrong-path", "yes", "yes"), wrongTarget: true },
    { ...row("invalid", "unknown", "unknown"), invalid: true }, row("unknown-ok", "unknown", "unknown"),
    row("miss", "yes", "unknown")]);
  expect(scored).toMatchObject({ tp: 1, fp: 2, positives: 3, recall: 1 / 3, precision: 1 / 3,
    correct: 2, vetoes: 2, invalid: 1, abstentions: 3, unknown: { n: 3, correct: 1 } });
});
test("agreement needs three repetitions and includes invalidity, with writes counted separately", () => {
  const scored = metrics([0, 1, 2].flatMap(rep => [row("agree", "no", "no", rep),
    { ...row("unstable", "no", "no", rep), invalid: rep === 2 }]).concat([
      { ...row("write", "no", "no"), changedFiles: ["profiles/record.md"] }]));
  expect(scored.agreement).toEqual({ cases: 3, agreeing: 1 });
  expect(scored.vetoes).toBe(1);
  expect(scored.contentWrites).toBe(1);
  expect(scored.precision).toBeNull();
});
test("a false report with a content write counts as one veto", () => {
  const scored = metrics([{ ...row("false-and-write", "no", "yes"), changedFiles: ["profiles/record.md"] }]);
  expect(scored).toMatchObject({ fp: 1, contentWrites: 1, vetoes: 1 });
});
