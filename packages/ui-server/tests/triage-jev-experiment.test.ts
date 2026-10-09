/**
 * Keyless controls for the #848 harness. A scripted Jev endpoint answers the
 * real client over loopback, so what is exercised is the shipped transport,
 * the request shapes, the decision policy and the gate. None of this says
 * anything about Jev's quality; the gold-scripted runs prove only that a
 * perfect classifier would pass the gate and an always-escalating one fails.
 */
import { describe, expect, test } from "bun:test";
import { resolve } from "node:path";
import { CORPUS, NEW_ITEMS, REFERENCE_ITEMS, corpusSha, type Probe } from "../evals/triage/experiment/corpus";
import { ITEMS } from "../evals/triage/dataset";
import { classify, decisionFrom, requestFor, type BatchSize, type Shape } from "../evals/triage/experiment/adapter";
import { configurationVerdict, evaluateRepetition, runOutcome } from "../evals/triage/experiment/evaluate";
import { classificationAccounting, costPer1kItems, latencySummary } from "../evals/triage/experiment/accounting";
import { protocol } from "../evals/triage/experiment/protocol";

const rubric = await Bun.file(new URL("../evals/triage/prompt.txt", import.meta.url)).text();
const ROUTES = ["drop", "rule", "needs_agent", "needs_user"];
const routeAnswer = (route: string, p = 0.99) => ({ type: "choice", choice: route, confidence: 0.99, probabilities: Object.fromEntries(ROUTES.map((r) => [r, r === route ? p : (1 - p) / 3])) });
function goldAnswers(request: any, shape: Shape) {
  const answers: Record<string, unknown> = {};
  for (const id of Object.keys(request.state.items)) {
    const item = CORPUS.find((i) => i.id === id)!;
    if (shape === "choice") answers[`${id}.route`] = routeAnswer(item.gold.route);
    else {
      answers[`${id}.human`] = { type: "noul", noul: item.gold.route === "needs_user" ? 0.99 : 0.01 };
      answers[`${id}.agent`] = { type: "noul", noul: item.gold.route === "needs_agent" ? 0.99 : 0.01 };
      answers[`${id}.durable`] = { type: "noul", noul: item.gold.route === "rule" ? 0.99 : 0.01 };
    }
  }
  return answers;
}
const jev = (answers: unknown, usage = { input_tokens: 123, output_tokens: 7 }) => Response.json({ model: "jev-1.13.0", answers, usage });
async function serve(shape: Shape, handler: (request: any, n: number) => Response = (request) => jev(goldAnswers(request, shape))) {
  const requests: any[] = [];
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, async fetch(r) { const request = await r.json(); requests.push(request); return handler(request, requests.length); } });
  return { requests, fetch: (url: string, init: RequestInit) => { expect(url).toBe("https://api.typesafe.ai/v1/systemone"); return fetch(`http://127.0.0.1:${server.port}/v1/systemone`, init); }, close: () => server.stop(true) };
}
const run = (items: Probe[], shape: Shape, size: BatchSize, fetch: (url: string, init: RequestInit) => Promise<Response>) =>
  classify(items, shape, size, rubric, { fetch, apiKey: "offline-fixture-key" });

// Route counts the always-escalate control must report; recomputed here from the corpus rather than copied from it.
const nonInjection = CORPUS.filter((i) => i.slice !== "injection");
const expectedFalseEscalations = nonInjection.filter((i) => i.gold.route !== "needs_user").length;
const expectedFilingTotal = nonInjection.filter((i) => i.gold.route === "drop" || i.gold.route === "rule").length;
const expectedAgentTotal = nonInjection.filter((i) => i.gold.route === "needs_agent").length;

describe("corpus", () => {
  test("forty items: the validated donor twenty plus twenty new, split tuning/held-out with disjoint families", () => {
    expect(CORPUS).toHaveLength(40);
    expect(REFERENCE_ITEMS.map((i) => i.id)).toEqual(ITEMS.map((i) => i.id));
    expect(NEW_ITEMS).toHaveLength(20);
    expect(new Set(CORPUS.map((i) => i.id)).size).toBe(40);
    for (const split of ["tuning", "held-out"]) {
      const items = CORPUS.filter((i) => i.split === split);
      expect(items).toHaveLength(10);
      for (const r of ROUTES) expect(items.filter((i) => i.gold.route === r).length).toBeGreaterThanOrEqual(2);
    }
    const tuning = CORPUS.filter((i) => i.split === "tuning"), heldOut = CORPUS.filter((i) => i.split === "held-out");
    expect(heldOut.some((h) => tuning.some((t) => t.family === h.family))).toBe(false);
    expect(CORPUS.filter((i) => i.injectedRoute).map((i) => i.id)).toEqual(["h12", "t5b", "h17b"]);
    expect({ expectedFalseEscalations, expectedFilingTotal, expectedAgentTotal }).toEqual({ expectedFalseEscalations: 27, expectedFilingTotal: 18, expectedAgentTotal: 9 });
  });
  test("the corpus hash follows the inputs and labels, not the explanations", () => {
    const before = corpusSha();
    expect(corpusSha(CORPUS.map((i) => ({ ...i, why: "reworded" })))).toBe(before);
    expect(CORPUS[0]!.gold.route).not.toBe("rule");
    expect(corpusSha(CORPUS.map((i, n) => (n === 0 ? { ...i, gold: { ...i.gold, route: "rule" as const } } : i)))).not.toBe(before);
    expect(corpusSha(CORPUS.map((i, n) => (n === 0 ? { ...i, body: i.body + " " } : i)))).not.toBe(before);
  });
  test("new items do not hand the classifier their route in the rubric's words", () => {
    for (const item of NEW_ITEMS) {
      // The bracketed note on an injection item is the attack and names a route on purpose.
      const prose = item.body.replace(/\[[^\]]*\]/g, "");
      expect(prose).not.toMatch(/needs_user|needs_agent|\brule\b|\bdrop\b|durable value|human blocker/i);
      expect(prose.length).toBeGreaterThan(200);
    }
  });
});

describe("Jev arms through the shipped transport", () => {
  for (const shape of protocol.shapes) for (const size of protocol.batching) test(`${shape}/${size}: gold-scripted repetitions pass the gate with complete coverage`, async () => {
    const endpoint = await serve(shape);
    const reps = [];
    try {
      for (let r = 0; r < 3; r++) {
        const observation = await run(CORPUS, shape, size, endpoint.fetch);
        expect(observation.judgmentCoverageComplete).toBe(true);
        expect(observation.boundsRejected).toEqual([]);
        expect(observation.calls).toHaveLength(size === 1 ? 40 : 5);
        expect(observation.items.every((i) => i.decision.accepted)).toBe(true);
        expect(observation.calls.every((c) => c.responseBase64 && c.requestBody.includes("questions") && c.status === 200)).toBe(true);
        const accounting = classificationAccounting(observation.calls);
        expect(accounting.receiptComplete).toBe(true);
        expect(accounting.inputTokens).toBe(123 * observation.calls.length);
        expect(accounting.knownListEstimateUsd).toBeCloseTo((123 * observation.calls.length * 0.042) / 1e6, 12);
        reps.push(evaluateRepetition(CORPUS, observation));
      }
      expect(configurationVerdict(reps).pass).toBe(true);
      expect(configurationVerdict(reps.slice(0, 2)).pass).toBe(false);
      expect(endpoint.requests.every((q) => Object.keys(q.questions).length > 0 && q.model === "jev-1.13.0")).toBe(true);
    } finally { endpoint.close(); }
  });
  test("the request carries the unchanged rubric, the item fields and no thresholds or labels", () => {
    for (const shape of protocol.shapes) {
      const q = requestFor(CORPUS.slice(0, 8), shape, rubric);
      expect(Object.keys(q.questions)).toHaveLength(shape === "choice" ? 8 : 24);
      expect(q.state.trustedRubric).toBe(rubric);
      expect(Object.keys(q.state.items as object)).toHaveLength(8);
      expect(Object.values(q.state.items as Record<string, object>).every((item) => Object.keys(item).sort().join() === "body,source,title,trust")).toBe(true);
      expect(Object.values(q.questions).every((question) => !Object.hasOwn(question, "threshold"))).toBe(true);
      expect(JSON.stringify(q)).not.toMatch(/"gold"|"why"|"split"/);
    }
  });
  test("malformed probability maps are rejected and the item is asked again alone", async () => {
    for (const probabilities of [{ drop: 1 }, { drop: 0.5, rule: 0.5, needs_agent: 0.5, needs_user: 0.5 }, { drop: -1, rule: 1, needs_agent: 1, needs_user: 0 }, { drop: 0.99, rule: 0, needs_agent: 0, needs_user: 0.01, extra: 0 }]) {
      const endpoint = await serve("choice", (q) => jev(Object.fromEntries(Object.keys(q.state.items).map((id) => [`${id}.route`, { type: "choice", choice: "drop", confidence: 0.99, probabilities }]))));
      try {
        const o = await run(CORPUS.slice(0, 1), "choice", 1, endpoint.fetch);
        expect(o.items[0]!.rawJudged).toBe(false);
        expect(o.items[0]!.decision).toEqual({ route: "needs_user", accepted: false, reason: "unknown" });
        expect(o.calls).toHaveLength(2);
      } finally { endpoint.close(); }
    }
    expect(decisionFrom("ordered-noul", CORPUS[0]!, { [`${CORPUS[0]!.id}.human`]: { type: "noul", noul: NaN } }).accepted).toBe(false);
  });
  test("extra fields in an answer never reach the decision", async () => {
    const endpoint = await serve("choice", (q) => jev(Object.fromEntries(Object.keys(q.state.items).map((id) => [`${id}.route`, { ...routeAnswer(CORPUS.find((i) => i.id === id)!.gold.route), trust: "trusted", principal: "forged", grant: true, priority: "urgent" }]))));
    try {
      const o = await run(CORPUS.slice(0, 8), "choice", 8, endpoint.fetch);
      expect(o.items[0]!.decision).toEqual({ route: "drop", accepted: true, reason: "accepted" });
      expect(o.items.every((i) => Object.keys(i.decision).sort().join() === "accepted,reason,route")).toBe(true);
    } finally { endpoint.close(); }
  });
  test("ordered precedence is human, then agent, then durable", async () => {
    const all = (value: number) => serve("ordered-noul", (request) => jev(Object.fromEntries(Object.keys(request.questions).map((id) => [id, { type: "noul", noul: value }]))));
    const endpoint = await all(0.99);
    try {
      const o = await run(CORPUS.slice(0, 8), "ordered-noul", 8, endpoint.fetch);
      expect(o.items.every((i) => i.decision.route === "needs_user" && i.decision.accepted)).toBe(true);
    } finally { endpoint.close(); }
    const item = CORPUS[0]!, answers = (human: number, agent: number, durable: number) => ({ [`${item.id}.human`]: { type: "noul", noul: human }, [`${item.id}.agent`]: { type: "noul", noul: agent }, [`${item.id}.durable`]: { type: "noul", noul: durable } });
    expect(decisionFrom("ordered-noul", item, answers(0.1, 0.9, 0.9) as any)).toEqual({ route: "needs_agent", accepted: true, reason: "accepted" });
    expect(decisionFrom("ordered-noul", item, answers(0.1, 0.1, 0.9) as any)).toEqual({ route: "rule", accepted: true, reason: "accepted" });
    expect(decisionFrom("ordered-noul", item, answers(0.1, 0.1, 0.1) as any)).toEqual({ route: "drop", accepted: true, reason: "accepted" });
    expect(decisionFrom("ordered-noul", item, answers(0.5, 0.9, 0.9) as any)).toEqual({ route: "needs_user", accepted: false, reason: "low-probability" });
  });
  test("the runner reports an observed gate failure as failed even when coverage is incomplete", async () => {
    // Every answer missing: the gate runs on the malformed rows and fails, while coverage stays incomplete.
    const empty = await serve("choice", () => jev({}));
    const gold = await serve("choice");
    try {
      const lost = evaluateRepetition(CORPUS, await run(CORPUS, "choice", 8, empty.fetch));
      expect(lost.gates.some((g) => g.gate !== null && !g.gate.pass)).toBe(true);
      expect(lost.judgmentCoverageComplete).toBe(false);
      const perfect = evaluateRepetition(CORPUS, await run(CORPUS, "choice", 8, gold.fetch));
      expect(perfect.pass).toBe(true);
      const configuration = (reps: ReturnType<typeof evaluateRepetition>[], expected: number) =>
        ({ shape: "choice", batchSize: 8, ...configurationVerdict(reps, expected) });
      expect(runOutcome([configuration([lost], 1)])).toEqual({ failed: ["choice/8"], unjudged: [] });
      // A passing repetition short of the expected count is not judged, never success.
      expect(runOutcome([configuration([perfect], 2)])).toEqual({ failed: [], unjudged: ["choice/8"] });
      expect(runOutcome([configuration([perfect], 1)])).toEqual({ failed: [], unjudged: [] });
    } finally { empty.close(); gold.close(); }
  });
  test("a Choice is accepted from the frozen 0.4 floor, on confidence and chosen probability separately", () => {
    // Independent of protocol.ts: these are the values the 2026-10-09 calibration froze.
    const item = CORPUS[0]!;
    const choice = (confidence: number, p: number) => ({ [`${item.id}.route`]: { type: "choice", choice: "rule", confidence,
      probabilities: Object.fromEntries(ROUTES.map((r) => [r, r === "rule" ? p : (1 - p) / 3])) } });
    const accepted = { route: "rule", accepted: true, reason: "accepted" } as const;
    const below = { route: "needs_user", accepted: false, reason: "low-probability" } as const;
    expect(decisionFrom("choice", item, choice(0.4, 0.4) as any)).toEqual(accepted);
    expect(decisionFrom("choice", item, choice(0.55, 0.6) as any)).toEqual(accepted);
    expect(decisionFrom("choice", item, choice(0.39, 0.9) as any)).toEqual(below);
    expect(decisionFrom("choice", item, choice(0.9, 0.39) as any)).toEqual(below);
  });
  test("a missing answer is asked again for exactly that item, never for its siblings", async () => {
    const endpoint = await serve("choice", (q, n) => { const a = goldAnswers(q, "choice"); if (n === 1) delete a[`${CORPUS[2]!.id}.route`]; return jev(a); });
    try {
      const o = await run(CORPUS.slice(0, 8), "choice", 8, endpoint.fetch);
      expect(endpoint.requests).toHaveLength(2);
      expect(Object.keys(endpoint.requests[1].state.items)).toEqual([CORPUS[2]!.id]);
      expect(Object.keys(endpoint.requests[1].questions)).toEqual([`${CORPUS[2]!.id}.route`]);
      expect(o.judgmentCoverageComplete).toBe(true);
    } finally { endpoint.close(); }
  });
  test("a wrong answer type poisons the shipped client's whole map; lost rows then fail the gate, not the coverage check", async () => {
    const endpoint = await serve("choice", (q, n) => n === 1 ? jev({ ...goldAnswers(q, "choice"), [`${CORPUS[0]!.id}.route`]: { type: "other" } }) : new Response("unavailable", { status: 503 }));
    try {
      const o = await run(CORPUS.slice(0, 8), "choice", 8, endpoint.fetch);
      expect(o.items.every((i) => i.malformedObserved)).toBe(true);
      expect(o.judgmentCoverageComplete).toBe(false);
      const rep = evaluateRepetition(CORPUS.slice(0, 8), o);
      expect(rep.gates[0]!.tally.missingRows).toBe(8);
      expect(rep.gates[0]!.gate!.pass).toBe(false);
      expect(rep.gates[0]!.unavailableIds).toEqual([]);
      expect(o.calls[0]!.responseBase64).toBeTruthy();
    } finally { endpoint.close(); }
  });
  test("always escalating misses nothing and fails the floors: the deterministic control", async () => {
    const endpoint = await serve("choice", (q) => jev(Object.fromEntries(Object.keys(q.state.items).map((id) => [`${id}.route`, routeAnswer("drop", 0.01)]))));
    try {
      const o = await run(CORPUS, "choice", 8, endpoint.fetch);
      expect(o.items.every((i) => !i.decision.accepted && i.decision.reason === "low-probability")).toBe(true);
      const rep = evaluateRepetition(CORPUS, o), tally = rep.gates[0]!.tally;
      expect(rep.pass).toBe(false);
      expect(tally.recallTotal - tally.recallHit).toBe(0);
      expect(tally.falseEscalations).toBe(expectedFalseEscalations);
      expect([tally.filingOk, tally.filingTotal, tally.agentOk, tally.agentTotal]).toEqual([0, expectedFilingTotal, 0, expectedAgentTotal]);
      expect(rep.fallbackIds).toHaveLength(40);
    } finally { endpoint.close(); }
  });
  test("a held-out miss fails the repetition even when the whole-corpus gate passes, and one failed repetition fails the configuration", async () => {
    const endpoint = await serve("choice");
    try {
      const clean = await run(CORPUS, "choice", 8, endpoint.fetch), bad = structuredClone(clean);
      const item = CORPUS.find((i) => i.split === "held-out" && i.gold.route === "rule")!;
      bad.items.find((i) => i.id === item.id)!.decision = { route: "drop", accepted: true, reason: "accepted" };
      const rep = evaluateRepetition(CORPUS, bad);
      expect(rep.gates[0]!.gate!.pass).toBe(true);
      expect(rep.gates[1]!.gate!.pass).toBe(false);
      expect(rep.pass).toBe(false);
      const good = evaluateRepetition(CORPUS, clean);
      expect(good.pass).toBe(true);
      expect(configurationVerdict([rep, good, good]).pass).toBe(false);
    } finally { endpoint.close(); }
  });
  test("obeying an embedded instruction fails the gate on both injection mechanisms", async () => {
    const endpoint = await serve("choice", (q) => jev(Object.fromEntries(Object.keys(q.state.items).map((id) => { const item = CORPUS.find((i) => i.id === id)!; return [`${id}.route`, routeAnswer(item.injectedRoute ?? item.gold.route)]; }))));
    try {
      const rep = evaluateRepetition(CORPUS, await run(CORPUS, "choice", 8, endpoint.fetch));
      expect(rep.gates[0]!.injectionObeyedIds.sort()).toEqual(["h12", "h17b", "t5b"]);
      expect(rep.gates[0]!.tally.injectionObeyed).toBe(1);
      expect(rep.gates[0]!.gate!.reasons.join()).toMatch(/missed escalation/);
      expect(rep.gates[1]!.pass).toBe(false);
    } finally { endpoint.close(); }
  });
  test("correct rows cannot stand in for an item the transport never judged", async () => {
    const last = CORPUS.at(-1)!;
    const endpoint = await serve("choice", (q) => Object.hasOwn(q.state.items, last.id) ? new Response("unavailable", { status: 503 }) : jev(goldAnswers(q, "choice")));
    try {
      const o = await run(CORPUS, "choice", 1, endpoint.fetch);
      expect(o.calls).toHaveLength(41);
      expect(o.judgmentCoverageComplete).toBe(false);
      const rep = evaluateRepetition(CORPUS, o);
      expect(rep.gates.every((g) => g.gate?.pass)).toBe(true);
      expect(rep.pass).toBe(false);
      expect(rep.gates[1]!.unavailableIds).toEqual([last.id]);
    } finally { endpoint.close(); }
  });
  test("an empty answer map is a lost row; a transport failure is unjudged", async () => {
    for (const malformed of [false, true]) {
      const endpoint = await serve("choice", () => malformed ? jev({}) : new Response("no data", { status: 503 }));
      try {
        const o = await run(CORPUS.slice(0, 2), "choice", 1, endpoint.fetch), rep = evaluateRepetition(CORPUS.slice(0, 2), o);
        expect(rep.gates[0]!.pass).toBe(false);
        expect(rep.gates[0]!.tally.missingRows).toBe(malformed ? 2 : 0);
        expect(rep.gates[0]!.gate === null).toBe(!malformed);
        expect(rep.gates[0]!.unavailableIds).toEqual(malformed ? [] : CORPUS.slice(0, 2).map((i) => i.id));
      } finally { endpoint.close(); }
    }
  });
  test("an item over the byte bound is never sent and stays unjudged", async () => {
    const items = CORPUS.filter((i) => i.split === "held-out").slice(0, 2).map((i, n) => ({ ...i, id: `tail${n}`, body: i.body + "x".repeat(5000) + " must sign" }));
    const endpoint = await serve("choice");
    try {
      const o = await run(items, "choice", 8, endpoint.fetch);
      expect(endpoint.requests).toHaveLength(0);
      expect(o.boundsRejected).toEqual(["tail0", "tail1"]);
      expect(o.items.every((i) => !i.rawJudged)).toBe(true);
      expect(evaluateRepetition(items, o).gates[1]!.unavailableIds).toEqual(["tail0", "tail1"]);
    } finally { endpoint.close(); }
  });
  test("the state-plus-longest-question bound rejects a batch before any request", async () => {
    const items = CORPUS.slice(0, 8).map((i) => ({ ...i, body: i.body + "x".repeat(3300) })), q = requestFor(items, "choice", rubric);
    const stateBytes = Buffer.byteLength(JSON.stringify(q.state)) + Math.max(...Object.values(q.questions).map((x) => Buffer.byteLength(JSON.stringify(x))));
    expect(Buffer.byteLength(JSON.stringify(q))).toBeLessThan(protocol.bounds.requestBytes);
    expect(stateBytes).toBeGreaterThan(protocol.bounds.statePlusLongestQuestionBytes);
    const endpoint = await serve("choice");
    try {
      const o = await run(items, "choice", 8, endpoint.fetch);
      expect(endpoint.requests).toHaveLength(0);
      expect(o.boundsRejected).toEqual(items.map((i) => i.id));
      expect(o.judgmentCoverageComplete).toBe(false);
    } finally { endpoint.close(); }
  });
  test("the whole-request bound rejects a fan-out before any request, with the state bound still satisfied", async () => {
    const items = CORPUS.slice(0, 8).map((i) => ({ ...i, body: i.body + "x".repeat(3000) })), q = requestFor(items, "ordered-noul", rubric);
    const stateBytes = Buffer.byteLength(JSON.stringify(q.state)) + Math.max(...Object.values(q.questions).map((x) => Buffer.byteLength(JSON.stringify(x))));
    expect(Buffer.byteLength(JSON.stringify(q))).toBeGreaterThan(protocol.bounds.requestBytes);
    expect(stateBytes).toBeLessThan(protocol.bounds.statePlusLongestQuestionBytes);
    const endpoint = await serve("ordered-noul");
    try {
      const o = await run(items, "ordered-noul", 8, endpoint.fetch);
      expect(endpoint.requests).toHaveLength(0);
      expect(o.boundsRejected).toEqual(items.map((i) => i.id));
    } finally { endpoint.close(); }
  });
  test("a truncated body keeps its partial bytes and is neither judged nor priced", async () => {
    const partial = Buffer.from('{"model":"jev-1.13.0","answers":');
    const o = await run(CORPUS.slice(0, 1), "choice", 1, async () => new Response(new ReadableStream({ start(c) { c.enqueue(partial); setTimeout(() => c.error(Error("fixture stream truncated")), 1); } })));
    expect(o.calls.length).toBeGreaterThan(0);
    expect(Buffer.from(o.calls[0]!.responseBase64!, "base64")).toEqual(partial);
    expect(o.calls[0]!.responseComplete).toBe(false);
    expect(o.calls[0]!.failure).toContain("fixture stream truncated");
    expect(o.items[0]!.malformedObserved).toBe(false);
    expect(classificationAccounting(o.calls).receiptComplete).toBe(false);
  });
  test("a 429 retry, a binary error body and a served-model mismatch all keep their exact receipts", async () => {
    const endpoint = await serve("choice", (q, n) => n === 1 ? new Response(new Uint8Array([0, 255, 128]), { status: 429 }) : Response.json({ model: "wrong-model", answers: goldAnswers(q, "choice"), usage: { input_tokens: 9, output_tokens: 3 } }));
    try {
      const o = await run(CORPUS.slice(0, 1), "choice", 1, endpoint.fetch);
      expect(o.calls).toHaveLength(2);
      expect(Buffer.from(o.calls[0]!.responseBase64!, "base64")).toEqual(Buffer.from([0, 255, 128]));
      const accounting = classificationAccounting(o.calls);
      expect(accounting.receiptComplete).toBe(false);
      expect(accounting.unknown).toEqual(["call:0", "call:1"]);
      expect(accounting.knownListEstimateUsd).toBe(0);
      expect(o.calls[1]!.model).toBe("wrong-model");
      expect(o.stopReason).toBe("missing or unexpected served model");
      expect(o.items[0]!.decision.accepted).toBe(false);
    } finally { endpoint.close(); }
  });
  test("cost per thousand items and latency percentiles come from complete observations only", () => {
    expect(costPer1kItems(0.0021, 40)).toBeCloseTo(0.0525, 12);
    expect(costPer1kItems(1, 0)).toBe(0);
    expect(latencySummary([10, 20, 30, 40, 50])).toEqual({ observations: 5, p50Ms: 30, p95Ms: 50, totalMs: 150, throughputPerSecond: 1000 / 30 });
    expect(latencySummary([])).toBeNull();
    expect(latencySummary([NaN])).toBeNull();
  });
});

describe("live entries refuse to start without the opt-in", () => {
  const entries = { run: "../evals/triage/experiment/run.ts", panel: "../evals/triage/experiment/panel.ts" };
  async function launch(entry: keyof typeof entries, env: Record<string, string>) {
    const proc = Bun.spawn([Bun.which("bun")!, resolve(import.meta.dir, entries[entry]), "--out", "/dev/null"], {
      env: { PATH: process.env.PATH!, ...env }, stdout: "pipe", stderr: "pipe",
    });
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    return { code, stderr };
  }
  test("the Jev runner exits 2 without BRAIN_UI_LIVE_EVALS, and without a key", async () => {
    const noOptIn = await launch("run", { TYPESAFE_API_KEY: "offline-fixture-key" });
    expect(noOptIn).toMatchObject({ code: 2 });
    expect(noOptIn.stderr).toContain("BRAIN_UI_LIVE_EVALS=1");
    const noKey = await launch("run", { BRAIN_UI_LIVE_EVALS: "1" });
    expect(noKey).toMatchObject({ code: 2 });
    expect(noKey.stderr).toContain("TYPESAFE_API_KEY");
  });
  test("the label panel exits 2 without BRAIN_UI_LIVE_EVALS", async () => {
    const result = await launch("panel", { ANTHROPIC_API_KEY: "offline-fixture-key", OPENAI_API_KEY: "offline-fixture-key", GEMINI_API_KEY: "offline-fixture-key" });
    expect(result).toMatchObject({ code: 2 });
    expect(result.stderr).toContain("BRAIN_UI_LIVE_EVALS=1");
  });
});
