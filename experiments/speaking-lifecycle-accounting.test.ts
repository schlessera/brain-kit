import { expect, test } from "bun:test";
import { corpus, candidates } from "../scripts/evals/speaking-lifecycle/corpus";
import { prepareCase } from "../scripts/evals/speaking-lifecycle/corpus";
import { observedClient } from "../scripts/evals/speaking-lifecycle/jev-observer";
import { digest, request, proposal, confirm } from "../scripts/evals/speaking-lifecycle/source-admission";
import { capture, plan } from "../scripts/evals/speaking-lifecycle/prototype";
import { captureGuard, guardedApply, observe } from "../scripts/evals/speaking-lifecycle/full-observer";
import type { JevChoiceAnswer } from "../packages/core/src/lib/jev";

const c = corpus[0];
function responseBody() {
  const q = request(c.source, candidates(c));
  return { model: "jev-1.13.0", answers: Object.fromEntries(Object.entries(q.questions).map(([key, question]) => {
    if (question.type !== "choice") throw Error("choice expected");
    const selected = key === "conference" ? c.assembly : key === "submission" ? c.submission : "accepted";
    return [key, { type: "choice", choice: selected, confidence: 1, probabilities: Object.fromEntries(Object.keys(question.criteria).map(k => [k, Number(k === selected)])) }];
  })), usage: { input_tokens: 321, output_tokens: 19 } };
}
test("actual core client retains literal whole request/response and nonzero output usage", async () => {
  let asked: unknown;
  const raw = JSON.stringify(responseBody());
  const observer = observedClient(async (_url, init) => { asked = JSON.parse(String(init.body)); return new Response(raw); });
  let result: Awaited<ReturnType<typeof observer.judge>> | undefined, failure: unknown;
  try { result = await observer.judge(c.source, candidates(c)); } catch (error) { failure = error; }
  const call = observer.calls[0];
  expect(call.responseBytes).toBe(Buffer.from(raw).toString("base64"));
  expect(call.responseSha).toBe(digest(raw));
  expect(failure).toBeUndefined();
  expect(result!.result.outcome).toBe("answered");
  expect(result!.answers).not.toBeNull();
  expect(asked).toHaveProperty("state.untrustedSource", c.source);
  expect(observer.calls).toHaveLength(1);
  expect(call.inputTokens).toBe(321); expect(call.outputTokens).toBe(19);
  expect(call.cacheReadTokens).toBeNull(); expect(call.cacheWriteTokens).toBeNull(); expect(call.actualBilledUsd).toBeNull();
  expect(call.responseEof).toBe(true); expect(call.responseClosed).toBe(true);
  expect(call.priceDerivedUsd).toBe(321 * .042 / 1e6);
});
test.each(["binary-error", "missing-usage", "wrong-model"])("%s keeps original bytes and stops before a second physical dispatch", async mode => {
  let dispatches = 0;
  const bytes = mode === "binary-error" ? Buffer.from([255, 0, 128]) : Buffer.from(JSON.stringify(mode === "missing-usage" ? { ...responseBody(), usage: undefined } : { ...responseBody(), model: "jev-latest" }));
  const observer = observedClient(async () => { dispatches++; return new Response(bytes, { status: mode === "binary-error" ? 500 : 200 }); });
  const failures: unknown[] = [];
  for (let i = 0; i < 2; i++) { try { await observer.judge(c.source, candidates(c)); } catch (error) { failures.push(error); } }
  expect(dispatches).toBe(1);
  expect(observer.calls).toHaveLength(1);
  expect(observer.calls[0].responseBytes).toBe(bytes.toString("base64"));
  expect(observer.calls[0].responseSha).toBe(digest(bytes));
  expect(observer.calls[0].actualBilledUsd).toBeNull();
  expect(failures).toHaveLength(2);
  expect(failures.every(error => String(error).includes("unknown usage/model"))).toBe(true);
});
test("malformed answer retains known physical usage without an accepted result", async () => {
  const body = { ...responseBody(), answers: {} };
  const observer = observedClient(async () => Response.json(body));
  const result = await observer.judge(c.source, candidates(c));
  expect(result.result.outcome).toBe("bad_response"); expect(result.answers).toBeNull();
  expect(observer.calls[0].outputTokens).toBe(19);
  expect(observer.calls[0].inputTokens).toBe(321);
  expect(observer.stopped).toBe(false);
});

test("real core parsed low selected probability cannot reach an actual write", async () => {
  const env = await prepareCase(c);
  try {
    const before = observe(env.root), raw = responseBody();
    raw.answers.outcome.probabilities = { accepted: 0.1, rejected: 0.9, waitlisted: 0, backup: 0, unclear: 0 };
    const observer = observedClient(async () => Response.json(raw));
    const received = await observer.judge(c.source, candidates(c));
    expect(received.result.outcome).toBe("answered");
    const answers = received.answers as Record<string, JevChoiceAnswer>;
    expect(answers.outcome.probabilities.accepted).toBe(0.1);
    const selected = proposal(c.source, candidates(c), answers, 0.9);
    const accepted = selected ? confirm(selected, { accepted: true, payloadSha: digest(JSON.stringify(selected)) }) : null;
    const p = await plan(capture(env.root, env.brain.taxonomy), env.brain.taxonomy, accepted, env.paths, "2026-07-12");
    guardedApply(env.root, p, captureGuard(env.root));
    expect(observe(env.root)).toEqual(before);
    expect(p.edits).toEqual([]);
  } finally { env.close(); }
});
