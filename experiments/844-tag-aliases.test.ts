import { describe, expect, test } from "bun:test";
import { admitted, calibrate, summarize, type Case, type Observation } from "../evals/844-tag-aliases/run";
import type { JevChoiceAnswer } from "../packages/core/src/lib/jev";

const fixture = (id: string, same: boolean | null, split = "held-out") => ({ id, expected: { same }, split } as Case);
const answer = (choice: string, confidence = 0.8): JevChoiceAnswer => ({ type: "choice", choice, confidence,
  probabilities: { same: choice === "same" ? 0.9 : 0.05, different: choice === "different" ? 0.9 : 0.05, uncertain: choice === "uncertain" ? 0.9 : 0.05 } });
const row = (id: string, rep: number, choice: string, confidence = 0.8): Observation => ({ id, rep, arm: "candidate",
  verdict: "uncertain", eligible: true, orientations: [answer(choice, confidence), answer(choice, confidence)] });

describe("lean alias scoring", () => {
  test("one false merge vetoes even when the other repetitions reject it", () => {
    const result = summarize([fixture("trap", false)], [row("trap", 0, "same"), row("trap", 1, "different"), row("trap", 2, "different")], 0.7);
    expect(result.falseMerges).toBe(1);
    expect(result.veto).toBe(true);
    expect(result.unstable).toEqual(["trap"]);
    expect(result.correct).toBe(2);
  });
  test("orientation disagreement and low confidence abstain; ungenerated positives remain misses", () => {
    const r = row("alias", 0, "same");
    r.orientations![1] = answer("different");
    expect(admitted(r, 0)).toBe("uncertain");
    expect(admitted(row("alias", 0, "same", 0.6), 0.7)).toBe("uncertain");
    const filtered = { ...row("alias", 0, "same"), eligible: false };
    expect(summarize([fixture("alias", true)], [filtered], 0).recalled).toBe(0);
    expect(admitted(filtered, 0)).toBe("filtered");
  });
  test("calibration uses tuning only and raises the floor to remove a tuning false merge", () => {
    const cases = [fixture("positive", true, "tuning"), fixture("trap", false, "tuning"), fixture("held", false)];
    const rows = [0, 1, 2].flatMap(rep => [row("positive", rep, "same", 0.9), row("trap", rep, "same", 0.6), row("held", rep, "same", 1)]);
    expect(calibrate(cases, rows).floor).toBe(0.7);
    expect(calibrate(cases, rows.filter(r => r.id !== "held"))).toEqual(calibrate(cases, rows));
  });
  test("report-only content changes veto even a correct proposal", () => {
    const r = { ...row("alias", 0, "same"), changed: ["context/left.md"] };
    const result = summarize([fixture("alias", true)], [r, row("alias", 1, "same"), row("alias", 2, "same")], 0);
    expect(result.falseMerges).toBe(0);
    expect(result.contentWrites).toBe(1);
    expect(result.veto).toBe(true);
  });
  test("no safe tuning floor proposes no aliases; a missing orientation is invalid", () => {
    const tuning = [fixture("trap", false, "tuning")];
    const rows = [0, 1, 2].map(rep => row("trap", rep, "same", 1));
    const floor = calibrate(tuning, rows).floor;
    expect(floor).toBeNull();
    expect(admitted(rows[0], floor ?? 2)).toBe("uncertain");
    expect(admitted({ ...rows[0], orientations: [answer("same")] }, 0)).toBe("invalid");
  });
  test("unknown positives are destructive; malformed answers stay invalid", () => {
    const invalid: Observation = { id: "unknown", arm: "candidate", rep: 1, verdict: "invalid" };
    const result = summarize([fixture("unknown", null)], [row("unknown", 0, "same"), invalid, row("unknown", 2, "uncertain")], 0);
    expect(result.falseMerges).toBe(1);
    expect(result.invalid).toBe(1);
    expect(result.abstentions).toBe(1);
    expect(result.correct).toBe(1);
  });
});
