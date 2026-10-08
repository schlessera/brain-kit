import { test, expect } from "bun:test";
import { observedClient } from "../scripts/evals/tag-aliases/jev";
import { candidates } from "../scripts/evals/tag-aliases/prototype";
import { fixtures, prepare } from "../scripts/evals/tag-aliases/fixtures";
import { calibrate, metrics, type Row } from "../scripts/evals/tag-aliases/metrics";
import { keyless } from "../scripts/evals/tag-aliases/keyless";

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

test("scripted full-corpus report retains candidate misses and lexical false merges", async () => {
  const result = await keyless();
  expect(result.rows).toHaveLength(126);
  const lexical = metrics(result.rows.filter(r => r.split === "held-out" && r.arm === "lexical"));
  expect(lexical.falseMerges, "related spelling is not semantic synonymy").toBe(3);
  const scripted = metrics(result.rows.filter(r => r.split === "held-out" && r.arm === "hybrid"));
  expect(scripted.candidateRecall).toBe(.8);
  expect(scripted.recall).toBe(.8);
  expect(scripted.measuredModelQuality).toBe(false);
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
