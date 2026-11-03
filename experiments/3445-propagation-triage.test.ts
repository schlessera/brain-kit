import { expect, test } from "bun:test";
import { calibrate, gate, metrics, type Row } from "../evals/3445-propagation-triage/score";
import { mechanics, preserved, type Case } from "../evals/3445-propagation-triage/mechanics";
import cases from "../evals/3445-propagation-triage/cases.json";
import { sourceChanges } from "../evals/3445-propagation-triage/changes";

const row = (gold: Row["gold"], label: Row["label"], extra: Partial<Row> = {}): Row => ({
  id: "case", arm: "candidate", split: "tuning", rep: 0, gold, label, invalid: false, fallback: false, confidence: 0.9, ...extra,
});
test("an acknowledgement on unknown is a veto; invalid answers cannot earn correctness or acceptance", () => {
  expect(metrics([row("uncertain", "still_current"), row("still_current", "still_current"),
    row("uncertain", "uncertain", { invalid: true, fallback: true })])).toMatchObject({
    n: 3, correct: 1, accepted: 2, falseAcknowledgements: 1, safePrecision: 0.5, forwardingRecall: 0.5, invalid: 1,
  });
});
test("calibration prioritizes zero false acknowledgements and never accepts held-out rows", () => {
  const rows = [row("needs_update", "still_current", { confidence: 0.7 }), row("still_current", "still_current", { confidence: 0.9 })];
  expect(calibrate(rows).floor).toBe(0.8);
  expect(gate(rows[0]!, 0.8)).toMatchObject({ label: "uncertain", fallback: true });
  expect(() => calibrate([{ ...rows[0]!, split: "held-out" }])).toThrow("tuning");
});
test("agreement requires three distinct repetitions and includes fallback/validity", () => {
  expect(metrics([0, 1, 2].map(rep => row("still_current", "still_current", { rep }))).agreement.agreeing).toBe(1);
  expect(metrics([0, 0, 2].map(rep => row("still_current", "still_current", { rep }))).agreement.agreeing).toBe(0);
  expect(metrics([0, 1, 2].map(rep => row("still_current", "still_current", { rep, invalid: rep === 2 }))).agreement.agreeing).toBe(0);
});
test("a date-only edit clears the real warning even on a semantically stale document", async () => {
  const c = cases.cases.find(c => c.id === "h-role-swapped") as Case;
  const result = await mechanics(c, cases.day);
  expect(result.propagationBefore).toBeGreaterThan(0);
  expect(result.propagationAfter).toBe(0);
  expect(result.changedPaths).toEqual([c.derivative.path]);
  expect(result.changedFields).toEqual(["updated"]);
  expect(result.bodyAndOtherBytesPreserved).toBe(true);
  expect(result.otherFieldsPreserved).toBe(true);
});
test("preservation refuses a changed created date or body alongside updated", () => {
  const before = "---\ncreated: 2026-07-01\nupdated: 2026-07-05\n---\nOdysseus commands.\n";
  const after = before.replace("updated: 2026-07-05", "updated: 2026-07-12");
  expect(preserved(before, after, "2026-07-12")).toBe(true);
  expect(preserved(before, after.replace("created: 2026-07-01", "created: 2026-07-12"), "2026-07-12")).toBe(false);
  expect(preserved(before, after.replace("Odysseus", "Eurylochus"), "2026-07-12")).toBe(false);
});
test("reference diffs contain both sides of a real source change and missing history stays unavailable", () => {
  const changed = cases.cases.find(c => c.id === "h-role-swapped") as Case;
  const result = sourceChanges(changed)[0]!;
  expect(result.referenceDate).toBe("2026-07-05");
  expect(result.unifiedDiff).toContain("-Odysseus is pilot. Eurylochus is lookout.");
  expect(result.unifiedDiff).toContain("+Odysseus is lookout. Eurylochus is pilot.");
  expect(result.unifiedDiff).not.toContain("/tmp/");
  const missing = cases.cases.find(c => c.id === "h-missing-history-but-complete") as Case;
  expect(sourceChanges(missing)[0]).toMatchObject({ available: false, unifiedDiff: null });
});
