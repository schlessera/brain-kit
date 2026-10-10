import { expect, test } from "bun:test";
import { benchmark, benchmarkInput } from "../scripts/evals/job-fit/benchmark";
import { observedClient } from "../scripts/evals/job-fit/jev-observer";
import { hash, semanticRequest } from "../scripts/evals/job-fit/semantic";
const input = benchmarkInput(benchmark[0]);
function body() {
  return { model: "jev-1.13.0", answers: {
    passage: { type: "choice", choice: "met", confidence: 1, probabilities: { met: 1, not_met: 0, unclear: 0 } },
    relocation: { type: "choice", choice: "not_met", confidence: 1, probabilities: { met: 0, not_met: 1, unclear: 0 } },
  }, usage: { input_tokens: 321, output_tokens: 19 } };
}
test("actual Choice client retains literal physical input/output before interpretation", async () => {
  const raw = JSON.stringify(body()); let asked: unknown, result: unknown, failure: unknown;
  const observer = observedClient(async (_url, init) => { asked = JSON.parse(String(init.body)); return new Response(raw); });
  try { result = await observer.judge(input); } catch (error) { failure = error; }
  const call = observer.calls[0];
  expect(call.responseBytes).toBe(Buffer.from(raw).toString("base64"));
  expect(call.responseSha).toBe(hash(raw)); expect(failure).toBeUndefined();
  expect(result).toHaveProperty("result.outcome", "answered"); expect(asked).toEqual(semanticRequest(input));
  expect(observer.calls).toHaveLength(1); expect(call.inputTokens).toBe(321); expect(call.outputTokens).toBe(19);
  expect(call.cacheReadTokens).toBeNull(); expect(call.cacheWriteTokens).toBeNull(); expect(call.actualBilledUsd).toBeNull();
  expect(call.priceDerivedUsd).toBe(321 * .042 / 1e6); expect(call.responseEof).toBe(true); expect(call.responseClosed).toBe(true);
});
test.each(["binary-error", "missing-usage", "wrong-model"])("%s preserves bytes and prevents another physical request", async mode => {
  let dispatches = 0;
  const bytes = mode === "binary-error" ? Buffer.from([255, 0, 128]) : Buffer.from(JSON.stringify(mode === "missing-usage" ? { ...body(), usage: undefined } : { ...body(), model: "jev-latest" }));
  const observer = observedClient(async () => { dispatches++; return new Response(bytes, { status: mode === "binary-error" ? 500 : 200 }); });
  const failures: unknown[] = [];
  for (let i = 0; i < 2; i++) try { await observer.judge(input); } catch (error) { failures.push(error); }
  expect(dispatches).toBe(1); expect(observer.calls).toHaveLength(1);
  expect(observer.calls[0].responseBytes).toBe(bytes.toString("base64")); expect(observer.calls[0].responseSha).toBe(hash(bytes));
  expect(observer.calls[0].actualBilledUsd).toBeNull(); expect(failures).toHaveLength(2);
  expect(failures.every(error => String(error).includes("unknown usage/model"))).toBe(true);
});
test("invalid answer preserves known usage without claiming a classification", async () => {
  const observer = observedClient(async () => Response.json({ ...body(), answers: {} }));
  const result = await observer.judge(input);
  expect(result.result.outcome).toBe("bad_response"); expect(result.answers).toBeNull();
  expect(observer.calls[0].outputTokens).toBe(19); expect(observer.calls[0].inputTokens).toBe(321); expect(observer.stopped).toBe(false);
});
