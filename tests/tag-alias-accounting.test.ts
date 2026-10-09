import { test, expect } from "bun:test";
import { observedClient } from "../scripts/evals/tag-aliases/jev";
import { candidates } from "../scripts/evals/tag-aliases/prototype";
import { fixtures, prepare } from "../scripts/evals/tag-aliases/fixtures";
import { calibrate, metrics, perCase, type Row } from "../scripts/evals/tag-aliases/metrics";
import { keyless } from "../scripts/evals/tag-aliases/keyless";
import { DEFAULT_CALL_BOUND } from "../scripts/evals/tag-aliases/jev";

test("real core Choice transport receives populated question and retains physical raw usage", async () => {
  const env = prepare(fixtures[1]);
  try {
    const pair = (await candidates(env.root)).pairs[0];
    const observer = observedClient(async (_, init) => {
      const request = JSON.parse(String(init.body));
      expect(request.model).toBe("jev-1.13.0");
      expect(request.questions.sameConcept.criteria).toEqual({ same: expect.any(String), different: expect.any(String), uncertain: expect.any(String) });
      expect(Object.keys(request.state.contexts)).toHaveLength(2);
      return Response.json({ model: "jev-1.13.0", answers: { sameConcept: { type: "choice", choice: "same", confidence: .98,
        probabilities: { same: .98, different: .01, uncertain: .01 } } }, usage: { input_tokens: 400, output_tokens: 21 } });
    });
    const judged = await observer.judge(pair);
    expect(judged.answer!.choice).toBe("same");
    expect(observer.calls).toHaveLength(1);
    expect(observer.calls[0]).toMatchObject({ inputTokens: 400, outputTokens: 21, cacheReadTokens: null, cacheWriteTokens: null,
      actualBilledUsd: null, servedModel: "jev-1.13.0", outcome: "received" });
    expect(JSON.parse(Buffer.from(observer.calls[0].responseBytes!, "base64").toString()).usage.input_tokens).toBe(400);
  } finally { env.close(); }
});

test("invalid UTF8 failure is retained before decode and stops the next physical dispatch", async () => {
  const env = prepare(fixtures[1]);
  try {
    const pair = (await candidates(env.root)).pairs[0], bytes = new Uint8Array([0xff, 0, 7]);
    let dispatched = 0;
    const observer = observedClient(async () => { dispatched++; return new Response(bytes, { status: 503 }); });
    let error: unknown;
    try { await observer.judge(pair); } catch (caught) { error = caught; }
    expect(observer.calls[0].responseBytes, "invalid response bytes must survive decoding failure").toBe(Buffer.from(bytes).toString("base64"));
    expect(observer.calls[0].inputTokens).toBeNull();
    try { await observer.judge(pair); } catch { /* retained initial unknown refuses dispatch */ }
    expect(dispatched, "unknown failure cannot dispatch a second physical request").toBe(1);
    expect(String(error)).toContain("unknown usage/model");
  } finally { env.close(); }
});

test("missing usage and wrong served model retain uncertainty and stop admission", async () => {
  const env = prepare(fixtures[1]);
  try {
    const pair = (await candidates(env.root)).pairs[0];
    for (const raw of [{ model: "jev-1.13.0", answers: {} }, { model: "jev-latest", answers: {}, usage: { input_tokens: 20, output_tokens: 4 } }]) {
      const observer = observedClient(async () => Response.json(raw));
      await expect(observer.judge(pair)).rejects.toThrow("unknown usage/model");
      expect(observer.stopped).toBe(true);
      expect(observer.calls[0].priceDerivedUsd).toBeNull();
    }
  } finally { env.close(); }
});

test("real core malformed Choice stays unknown despite complete priced usage", async () => {
  const env = prepare(fixtures[1]);
  try {
    const pair = (await candidates(env.root)).pairs[0];
    const observer = observedClient(async () => Response.json({ model: "jev-1.13.0", answers: { sameConcept: {
      type: "choice", choice: "same", confidence: .99, probabilities: { same: .99 } } }, usage: { input_tokens: 20, output_tokens: 4 } }));
    const judged = await observer.judge(pair);
    expect(judged.result.outcome).toBe("bad_response");
    expect(judged.answer).toBeNull();
    expect(observer.calls[0].inputTokens).toBe(20);
  } finally { env.close(); }
});

test("calibration excludes held-out data and incomplete tuning denominators", () => {
  const row: Row & { threshold: number } = { id: "a", split: "tuning", same: true, arm: "hybrid", repetition: 0, retrieved: true,
    proposed: true, abstained: false, failure: null, durationMs: 1, modelQuality: false, threshold: .7 };
  expect(calibrate([row], ["a", "b"])).toBeNull();
  expect(() => calibrate([{ ...row, split: "held-out" }], ["a"])).toThrow("Held-out");
  expect(calibrate([row, { ...row, id: "b", same: false, proposed: true }], ["a", "b"])).toBeNull();
  expect(calibrate([row, { ...row, id: "b", same: false, proposed: false }], ["a", "b"])).toBe(.7);
});

test("repetitions of one pair vote per case instead of multiplying the denominators", () => {
  const row: Row = { id: "pylos-synonym", split: "held-out", same: true, arm: "hybrid", repetition: 0, retrieved: true,
    proposed: true, abstained: false, failure: null, durationMs: 1, modelQuality: false };
  const rows = [row, { ...row, repetition: 1 }, { ...row, repetition: 2, proposed: false, abstained: true },
    { ...row, id: "pylos-related", same: false, proposed: false, abstained: true }, { ...row, id: "pylos-related", same: false, repetition: 1, proposed: false, abstained: true }];
  const summary = metrics(rows);
  expect(summary.positives, "one positive pair, not three repetitions of it").toBe(1);
  expect(summary.observations).toBe(5);
  expect(summary.trueProposals).toBe(1);
  expect(summary.unstableCases).toEqual(["pylos-synonym"]);
  expect(summary.abstention).toBe(.5);
  expect(perCase(rows).find(c => c.id === "pylos-synonym")).toMatchObject({ proposed: true, unstable: true, abstained: false });
});

test("keyless report measures the lexical baseline and the candidate stage, never a model arm", async () => {
  const result = await keyless();
  expect([...new Set(result.rows.map(r => r.arm))], "a keyless report cannot carry a model arm").toEqual(["lexical"]);
  expect(result.rows).toHaveLength(23);
  const held = result.summary["held-out/lexical"]!;
  expect(held.falseMergeIds, "related spelling is not semantic synonymy").toEqual(["sparta-lexical-trap"]);
  expect(held.trueProposals).toBe(1);
  expect(held.recall).toBe(.2);
  expect(held.candidateRecall).toBe(.8);
  expect(held.missedPositives, "the disjoint-context synonym is the known candidate miss").toEqual(["ithaca-disjoint-context"]);
  expect(result.summary["tuning/lexical"]!.falseMergeIds).toEqual(["ogygia-lexical-trap"]);
  expect(result.byCategory.synonym).toMatchObject({ cases: 4, retrieved: 4, lexicalProposals: 0 });
  const floor = result.floors["held-out"]!;
  expect(floor.proposeAllCandidates.recall, "accepting every candidate recovers every retrieved positive").toBe(.8);
  expect(floor.proposeAllCandidates.falseMerges, "and merges every retrieved negative").toBeGreaterThanOrEqual(5);
  expect(floor.proposeNothing).toMatchObject({ trueProposals: 0, falseMerges: 0, recall: 0, precision: null });
  expect(result.corpus.pairs).toBeGreaterThan(0);
  expect(result.corpus.pairs).toBeLessThanOrEqual(128);
  expect(result.corpus.pairs + result.corpus.omitted).toBeGreaterThan(result.corpus.pairs);
  expect(result.corpus.byRule.lexical + result.corpus.byRule.cooccurring + result.corpus.byRule.overlapOnly).toBe(result.corpus.pairs);
  expect(result.corpus.jevCallsPerRun).toBe(result.corpus.pairs * 2 * result.protocol.repetitions);
  expect(result.corpus.jevCallsPerRun).toBeLessThanOrEqual(DEFAULT_CALL_BOUND);
});


test("Jev physical stream failure retains literal prefix before EOF refusal", async () => {
  const env = prepare(fixtures[1]);
  try {
    const pair = (await candidates(env.root)).pairs[0], prefix = new TextEncoder().encode("{partial Odysseus reply");
    const observer = observedClient(async () => new Response(new ReadableStream({ start(c) { c.enqueue(prefix); }, pull(c) { c.error(Error("controlled upstream close")); } })));
    await expect(observer.judge(pair)).rejects.toThrow("unknown usage/model");
    expect(observer.calls).toHaveLength(1);
    const call = observer.calls[0];
    expect(Buffer.from(call.responseBytes!, "base64")).toEqual(Buffer.from(prefix));
    expect(call.responseEof).toBe(false); expect(call.responseClosed).toBe(true); expect(call.failure).toContain("controlled upstream close");
    expect(call.actualBilledUsd).toBeNull(); expect(call.priceDerivedUsd).toBeNull();
  } finally { env.close(); }
});
