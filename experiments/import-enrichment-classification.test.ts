import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { benchmark, prepare, execute } from "../scripts/evals/import-enrichment/benchmark";
import { classifier, requestFor, type Payload } from "../scripts/evals/import-enrichment/classification";
import { observedClient } from "../scripts/evals/import-enrichment/jev-observer";
import { receipts, hash } from "../scripts/evals/import-enrichment/prototype";
function answers(choiceP = 1) {
  const a = (choice: string, options: string[]) => ({ type: "choice", choice, confidence: 1, probabilities: Object.fromEntries(options.map(o => [o, o === choice ? choiceP : (1 - choiceP) / (options.length - 1)])) });
  return { documentType: a("logbook", ["note", "logbook", "ruling", "unclear"]), tag0: a("yes", ["yes", "no", "unclear"]), tag1: a("no", ["yes", "no", "unclear"]), tag2: a("no", ["yes", "no", "unclear"]) };
}
for (const probability of [1, 0.01]) test(`actual full-source Choice provider ${probability}: paired gate reaches writer or refuses completion`, async () => {
  const env = prepare(benchmark[0]!, "classification"), bodies: any[] = [], observer = observedClient(async (_url, init) => { bodies.push(JSON.parse(String(init.body))); return Response.json({ model: "jev-1.13.0", answers: answers(probability), usage: { input_tokens: 321, output_tokens: 19 } }); });
  try { const r = await execute(env, { classifier: classifier(observer, .9) }); expect(observer.calls).toHaveLength(1); expect(bodies[0].state.untrusted_note).toBe(env.files[env.path]); expect(Object.keys(bodies[0].questions)).toHaveLength(4); expect(bodies[0].questions.documentType.criteria.logbook.length).toBeGreaterThan(70); expect(JSON.stringify(bodies[0])).not.toContain(benchmark[0]!.id);
    expect(observer.calls[0]!.outputTokens).toBe(19); expect(observer.calls[0]!.priceDerivedUsd).toBeNull(); expect(observer.calls[0]!.actualBilledUsd).toBeNull();
    if (probability === 1) { expect(readFileSync(join(env.root, env.path), "utf8")).toBe(env.expected[env.path]); expect(r.failed).toEqual([]); }
    else { expect(readFileSync(join(env.root, env.path), "utf8")).toBe(env.files[env.path]); expect(receipts(env.root).filter(r => r.status === "complete")).toEqual([]); }
  } finally { env.close(); }
});
test("uncalibrated gate dispatches no classifier or source/cache/manifest write", async () => {
  const env = prepare(benchmark[0]!, "classification"), observer = observedClient(async () => { throw Error("Must not dispatch"); });
  try { await execute(env, { classifier: classifier(observer, null) }); expect(observer.calls).toEqual([]); expect(readFileSync(join(env.root, env.path), "utf8")).toBe(env.files[env.path]); expect(receipts(env.root)).toEqual([]); }
  finally { env.close(); }
});
test.each(["binary-error", "missing-usage", "wrong-model"])("%s physical request retains literal bytes and prevents a second attempt", async mode => {
  const env = prepare(benchmark[0]!, "classification"); let calls = 0;
  const raw = mode === "binary-error" ? Buffer.from([255, 0, 128]) : Buffer.from(JSON.stringify({ model: mode === "wrong-model" ? "jev-latest" : "jev-1.13.0", answers: answers(), ...(mode === "missing-usage" ? {} : { usage: { input_tokens: 321, output_tokens: 19 } }) }));
  const observer = observedClient(async () => { calls++; return new Response(raw, { status: mode === "binary-error" ? 529 : 200 }); });
  try { const provider = classifier(observer, .9); await execute(env, { classifier: provider }); await execute(env, { classifier: provider }); expect(calls).toBe(1); expect(observer.calls[0]!.responseBytes).toBe(raw.toString("base64")); expect(observer.calls[0]!.responseSha).toBe(hash(raw)); expect(observer.calls[0]!.actualBilledUsd).toBeNull(); expect(receipts(env.root)).toEqual([]); }
  finally { env.close(); }
});
test("missing explicit definitions refuse a nonempty request before inference", () => {
  const p: Payload = { untrusted_note: "A substantial imported source requires semantic meaning.", types: ["note"], tags: ["council"], typeDefinitions: {}, tagDefinitions: {}, fields: ["type", "tags"] };
  expect(() => requestFor(p)).toThrow("explicit type/tag definitions");
});
