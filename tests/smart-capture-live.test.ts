import { expect, test } from "bun:test";
import { classify, Spend } from "../scripts/evals/smart-capture/live";
import { atReferenceDate, fixtures, prepare, scripted } from "../scripts/evals/smart-capture/pipeline";
import { summarize } from "../scripts/evals/smart-capture/metrics";

test("actual core Jev transport keeps physical usage, output count and complete bounded questions", async () => {
  const f = fixtures.find(f => f.id === "t-custom")!, p = await prepare(f);
  let dispatches = 0, saves = 0;
  try {
    const spend = new Spend(15), expected = scripted(f, p.root);
    const result = await classify(f, p.root, spend, async (_url, init) => {
      const body = JSON.parse(String(init.body));
      expect(body.model).toBe("jev-1.13.0"); expect(Object.keys(body.questions)).toHaveLength(8); expect(body.questions.target).toBeUndefined();
      expect(body.state.capture).toBe(f.content); dispatches++;
      return Response.json({ model: "jev-1.13.0", answers: expected.answers, usage: { input_tokens: 300, output_tokens: 24 } });
    }, "offline-key", () => saves++);
    expect(result.result.outcome).toBe("answered"); expect(dispatches).toBe(1); expect(saves).toBe(1);
    expect(result.calls[0]!.inputTokens).toBe(300); expect(result.calls[0]!.outputTokens).toBe(24);
    expect(result.calls[0]!.observedAdditionalBilledUsd).toBeCloseTo(0.0000126, 10);
    expect(spend.usd).toBeCloseTo(0.0000126, 10);
  } finally { p.close(); }
});
test("missing usage preserves raw attempt and refuses paid retry or subsequent fetch", async () => {
  const f = fixtures.find(f => f.id === "t-custom")!, p = await prepare(f); let dispatches = 0;
  try {
    const spend = new Spend(15);
    const fetch = async () => { dispatches++; return Response.json({ error: "Rate limit" }, { status: 429, headers: { "retry-after": "0" } }); };
    const result = await classify(f, p.root, spend, fetch, "offline-key", () => {});
    expect(dispatches).toBe(1); expect(result.calls).toHaveLength(1);
    expect(result.calls[0]!.status).toBe(429); expect(result.calls[0]!.observedAdditionalBilledUsd).toBeNull();
    expect(spend.uncertain).toBe(true);
    await classify(f, p.root, spend, fetch, "offline-key", () => {});
    expect(dispatches).toBe(1);
  } finally { p.close(); }
});
test("a model mismatch does not invent a priced charge from an unrelated usage receipt", async () => {
  const f = fixtures.find(f => f.id === "t-custom")!, p = await prepare(f);
  try {
    const spend = new Spend(15), result = await classify(f, p.root, spend, async () => Response.json({ model: "jev-other", answers: scripted(f, p.root).answers, usage: { input_tokens: 300, output_tokens: 20 } }), "offline-key", () => {});
    expect(result.calls[0]!.outcome).toBe("model_or_usage_mismatch"); expect(spend.uncertain).toBe(true);
    expect(result.calls[0]!.apiEquivalentUpperUsd).toBeNull();
  } finally { p.close(); }
});
test("budget prevents physical dispatch and held-out report retains unknown costs", async () => {
  const spend = new Spend(0.000001); expect(() => spend.reserve(0.000002)).toThrow("reservation");
  const row = { arm: "hybrid", split: "held-out", fixture: "fixture", repetition: 0, correctType: true, wrongTargetAppend: false, contentLoss: false, unintendedCreates: 0,
    correctAppendTarget: true, correctReviewTarget: true, appendTarget: null, reviewTarget: null, abstained: true, truePositiveTags: 0, predictedTags: 0, expectedTags: 0,
    inventedTags: [], durationMs: 10, generationRequested: false, calls: [{ inputTokens: null, outputTokens: null, cacheReadTokens: null, cacheWriteTokens: null, apiEquivalentLowerUsd: null, apiEquivalentUpperUsd: null, observedAdditionalBilledUsd: null }] };
  const summary = summarize([row]).find(r => r.arm === "hybrid" && r.split === "held-out")!;
  expect(summary.observations).toBe(1); expect(summary.calls).toBe(1);
  expect(summary.callsWithUnknownUsage).toBe(1); expect(summary.apiEquivalentUpperUsd).toBeNull(); expect(summary.observedAdditionalBilledUsd).toBeNull();
});
test("over-budget classification cannot reach the physical request transport", async () => {
  const f = fixtures.find(f => f.id === "t-custom")!, p = await prepare(f); let dispatches = 0;
  try {
    const spend = new Spend(0.000000001);
    const result = await classify(f, p.root, spend, async () => { dispatches++; return Response.json({ model: "jev-1.13.0", answers: scripted(f, p.root).answers, usage: { input_tokens: 0, output_tokens: 0 } }); }, "offline-key", () => {});
    expect(dispatches).toBe(0); expect(result.calls).toHaveLength(0); expect(result.result.outcome).toBe("network_error");
  } finally { p.close(); }
});
test("document reference clock leaves provider deadline clock intact and restores construction", async () => {
  const original = Date, now = Date.now;
  Date.now = () => 123456789;
  try {
    await atReferenceDate(async () => {
      expect(new Date().toISOString()).toBe("2026-07-12T04:40:00.000Z");
      expect(Date.now()).toBe(123456789);
    });
    expect(Date).toBe(original); expect(Date.now()).toBe(123456789);
  } finally { Date.now = now; }
});


test("inferred-tag reporting excludes metadata, explicit flags and reserved generation", () => {
  const common = { arm: "hybrid", split: "held-out", fixture: "fixture", repetition: 0, correctType: true, wrongTargetAppend: false, contentLoss: false, unintendedCreates: 0,
    correctAppendTarget: true, correctReviewTarget: true, appendTarget: null, reviewTarget: null, abstained: true, inventedTags: [], durationMs: 10, generationRequested: false, calls: [] };
  const summary = summarize([
    { ...common, classificationEligible: false, truePositiveTags: 10, predictedTags: 10, expectedTags: 10 },
    { ...common, classificationEligible: true, truePositiveTags: 1, predictedTags: 2, expectedTags: 4 },
  ]).find(r => r.arm === "hybrid" && r.split === "held-out")!;
  expect(summary.classificationEligibleTagMetrics).toEqual({ observations: 1, correct: 1, predicted: 2, expected: 4, precision: .5, recall: .25 });
  expect(summary.tagPrecision).toBeCloseTo(11 / 12);
});
