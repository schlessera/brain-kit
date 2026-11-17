/**
 * The #4090 requalification harness (`evals/3434-extraction-classifier/requalify.ts`):
 * its report arithmetic, the keyless stub run through the production judge,
 * the live judge's spend cap and model record, and the replay of a recorded
 * live run. Every assertion is about the harness; the product claim (the set
 * reaches the production band) is `packages/ui-server/tests/extraction-band-requalification.test.ts`.
 */
import { describe, expect, test } from "bun:test";
import { join } from "node:path";
import {
  bandReport, evaluate, FLOOR, liveJudge, loadRequalify, main, recordedJudges, stubAnswer, stubbedJudge,
  type Ledger, type Recorded, type Row,
} from "../evals/3434-extraction-classifier/requalify";
import { EXTRACTION_JUDGE_MODEL, judgeState } from "../packages/ui-server/src/governance/extraction-judge";

const EVAL = join(import.meta.dir, "../evals/3434-extraction-classifier");
const { cases, files } = await loadRequalify();

const row = (call: string, gold: Row["gold"], final: Row["final"], answer?: { choice: "benign" | "suspicious" | "extraction"; confidence: number }): Row => ({
  session: "s", split: "held-out", call, family: "f", gold, goldBand: gold === "benign" ? "allow" : "ask", score: 0.25, ambiguous: true, heuristicBand: "ask", final,
  ...(answer ? { judged: { band: final === "admit" ? "allow" : final === "ask" ? "ask" : "block", outcome: "answered", answer } } : {}),
});

describe("report", () => {
  test("a benign answer to an extraction call at the floor clears it, and the margins say by how much", () => {
    const r = bandReport([
      row("e1", "extraction", "admit", { choice: "benign", confidence: 0.92 }),
      row("e2", "extraction", "ask", { choice: "benign", confidence: 0.85 }),
      row("e3", "extraction", "refuse", { choice: "extraction", confidence: 0.95 }),
      row("b1", "benign", "admit", { choice: "benign", confidence: 0.97 }),
      row("b2", "benign", "ask", { choice: "suspicious", confidence: 0.7 }),
    ], 0.9);
    expect(r.band).toEqual({ calls: 5, extraction: 3, benign: 2 });
    expect(r.leaked).toEqual(["e1"]);
    expect(r.clearedFloor).toEqual(["e1"]);
    expect(r.floorMargin).toBe(-0.02);
    expect(r.benignHeadroom).toBe(0.07);
    expect(r.separation).toBe(0.05);
    expect(r.detection).toEqual({ caught: 3, precision: 0.667, recall: 0.667 });
    expect(r.bands.allow).toMatchObject({ predicted: 2, gold: 2, correct: 1, precision: 0.5, recall: 0.5 });
    expect(r.benignCards).toBe(1);
  });
  test("with every benign answer to extraction below the floor, nothing clears and the margin is positive", () => {
    const r = bandReport([row("e", "extraction", "ask", { choice: "benign", confidence: 0.88 }), row("b", "benign", "admit", { choice: "benign", confidence: 0.91 })], 0.9);
    expect([r.clearedFloor, r.floorMargin, r.separation]).toEqual([[], 0.02, 0.03]);
  });
});

describe("keyless run", () => {
  test("the stub through the production judge reproduces the recorded offline report", async () => {
    const recorded = await Bun.file(join(EVAL, "results-4090-offline-2026-11-17.json")).json() as { report: unknown };
    const { report } = await evaluate(cases, files, [stubbedJudge(stubAnswer)]);
    expect(report).toEqual(recorded.report as typeof report);
    expect(report.floor).toBe(0.9);
    // Without a judge the band asks on every call; with the stub every band call is judged and answered.
    expect(report.heuristics.heldOut.detection.recall).toBe(1);
    expect(report.reps[0]!.heldOut.outcomes).toEqual({ answered: report.reps[0]!.heldOut.band.calls });
  });
  test("an answer from another model, or none, leaves the call on the card", async () => {
    const state = judgeState({ surface: "web_fetch", tool: "WebFetch", toolClass: "read", route: "network", method: "GET", hosts: ["x.example"], urls: [], body: "", pathRefs: [], bytes: { query: 0, body: 0 } }, { overlap: { matched: 0, containment: 0, pathRef: false, files: [] } }, "WebFetch y.example");
    const other = await stubbedJudge(() => ({ model: "jev-1.14.0", answer: { choice: "benign", confidence: 1 } }))("a", state);
    expect(other).toEqual({ band: "ask", outcome: "wrong_model", answer: null });
    const none = await stubbedJudge(() => null)("a", state);
    expect(none.band).toBe("ask");
  });
});

describe("live judge", () => {
  const state = judgeState({ surface: "web_fetch", tool: "WebFetch", toolClass: "read", route: "network", method: "GET", hosts: ["x.example"], urls: [], body: "", pathRefs: [], bytes: { query: 0, body: 0 } }, { overlap: { matched: 0, containment: 0, pathRef: false, files: [] } }, "WebFetch y.example");
  const ledger = (maxUsd: number): Ledger => ({ maxUsd, calls: 0, inputTokens: 0, reservedUsd: 0, spendUsd: 0, models: [], latencyMs: [] });
  const reply = (model: string, sent: string[]) => async (_url: string, init: RequestInit) => {
    sent.push(String(init.body));
    return Response.json({ model, usage: { input_tokens: 500, output_tokens: 0 }, answers: { verdict: { type: "choice", choice: "benign", confidence: 0.95, probabilities: {} } } });
  };
  test("records the answering model, tokens and spend from the response, and sends the pinned model", async () => {
    const sent: string[] = [], record: Recorded["answers"] = {}, l = ledger(10);
    const result = await liveJudge("test-key", l, record, 1, reply(EXTRACTION_JUDGE_MODEL, sent))("a", state);
    expect(result).toEqual({ band: "allow", outcome: "answered", answer: { choice: "benign", confidence: 0.95 } });
    expect(JSON.parse(sent[0]!)).toMatchObject({ model: EXTRACTION_JUDGE_MODEL, state });
    expect(record["a#1"]).toEqual({ model: EXTRACTION_JUDGE_MODEL, answer: { choice: "benign", confidence: 0.95 }, outcome: "answered" });
    expect(l).toMatchObject({ calls: 1, inputTokens: 500, models: [EXTRACTION_JUDGE_MODEL], reservedUsd: 0 });
    const wrong: Recorded["answers"] = {};
    await liveJudge("test-key", ledger(10), wrong, 0, reply("jev-1.14.0", []))("a", state);
    expect(wrong["a#0"]).toEqual({ model: "jev-1.14.0", answer: null, outcome: "wrong_model" });
  });
  test("the spend cap stops the run before the request that would cross it is sent", async () => {
    const sent: string[] = [];
    await expect(liveJudge("test-key", ledger(1e-9), {}, 0, reply(EXTRACTION_JUDGE_MODEL, sent))("a", state)).rejects.toThrow("spend cap");
    expect(sent).toHaveLength(0);
  });
  test("the live mode refuses a cap above the authorized $10 and a run without a key", async () => {
    const env = { ...process.env };
    try {
      delete process.env.CI;
      process.env.TYPESAFE_API_KEY = "test-key";
      await expect(main(["--run", "--max-usd", "20", "--out", "/dev/null"])).rejects.toThrow("at most the authorized 10");
      process.env.CI = "true";
      await expect(main(["--run", "--max-usd", "10", "--out", "/dev/null"])).rejects.toThrow("outside CI");
      delete process.env.TYPESAFE_API_KEY;
      await expect(main(["--run", "--max-usd", "10", "--out", "/dev/null"])).rejects.toThrow("TYPESAFE_API_KEY");
    } finally {
      for (const key of ["CI", "TYPESAFE_API_KEY"]) if (env[key] === undefined) delete process.env[key]; else process.env[key] = env[key];
    }
  });
});

const LIVE = join(EVAL, "results-4090-2026-11-17.json");
describe("recorded live run", () => {
  test("replaying every repetition's recorded answers through the production judge reproduces its report", async () => {
    const recorded = await Bun.file(LIVE).json() as Recorded;
    expect(recorded.jev.requestedModel).toBe(EXTRACTION_JUDGE_MODEL);
    expect(recorded.jev.spendUsd).toBeLessThan(recorded.jev.maxUsd);
    expect(recorded.jev.maxUsd).toBeLessThanOrEqual(10);
    expect(recorded.floor).toBe(FLOOR);
    const { report } = await evaluate(cases, files, recordedJudges(recorded, recorded.report.reps.length));
    expect(report).toEqual(recorded.report);
  });
});
