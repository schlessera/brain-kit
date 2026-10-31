/** Startup-context byte bounds at their exact edges (#3200). Pure; no transport. */
import { expect, test } from "bun:test";
import { conversationHistory, STARTUP_CONTEXT_LIMITS } from "../src/voice/conversation-history";
import { maximalResync, previousFormatter, RESYNC_PREFIX, rewrittenAggregate, utf8 } from "./helpers/startup-context";

const scope = { conversationId: "ithaca", epoch: 2 };

test("every byte ceiling is honored exactly, omission marker included", () => {
  const resync = maximalResync();
  const small = { ...resync, work: resync.work.slice(-12) };
  let previous = 0;
  for (let maxBytes = 120; maxBytes <= 9_000; maxBytes += 7) {
    const text = conversationHistory(scope, small, { maxBytes, maxFactBytes: 16_000 });
    expect(utf8(text)).toBeLessThanOrEqual(maxBytes);
    // Once the newest outcome fits, more room never loses it at a marker boundary.
    // (The count of older shells may fall when a whole newest fact starts to fit.)
    const count = text ? JSON.parse(text.slice(RESYNC_PREFIX.length)).filter((e: { omitted?: string }) => !e.omitted).length : 0;
    if (previous) expect(count).toBeGreaterThan(0);
    previous = count;
    if (maxBytes >= 1_300) expect(count).toBeGreaterThan(0); // the newest shell plus marker fits here
    if (!text) continue;
    const entries = JSON.parse(text.slice(RESYNC_PREFIX.length));
    // Anything dropped is marked; the kept entries are the newest suffix.
    const kept = entries.filter((e: { omitted?: string }) => !e.omitted);
    expect(entries[0]?.omitted === "older_outcomes").toBe(kept.length < small.work.length);
    expect(kept.map((e: { request: string }) => e.request)).toEqual(small.requests.slice(small.requests.length - kept.length));
  }
});

test("the explicit fact ceiling binds even when the total would fit", () => {
  const fact = (i: number) => `${i}`.repeat(2_600);
  const work = [0, 1, 2].map(i => ({ conversationId: "ithaca", epoch: 1, utteranceId: `u${i}`, requestId: `r${i}`, turnId: `t${i}`,
    state: "completed" as const, delivery: "discarded" as const, recognized: `Ask ${i}.`, submitted: `Ask ${i}.` }));
  const results = work.map((w, i) => ({ conversationId: "ithaca", epoch: 1, requestId: w.requestId, turnId: w.turnId, facts: fact(i) }));
  const text = conversationHistory(scope, { work, results }, STARTUP_CONTEXT_LIMITS.gpt);
  expect(utf8(text)).toBeLessThan(STARTUP_CONTEXT_LIMITS.gpt.maxBytes - 1_000); // total had room for all three
  // 2,602 serialized bytes each: the newest fits 5,000; any second one would make 5,204.
  expect(JSON.parse(text.slice(RESYNC_PREFIX.length))).toEqual([
    { request: "Ask 0.", outcome: "completed", delivery: "discarded", resultOmitted: true },
    { request: "Ask 1.", outcome: "completed", delivery: "discarded", resultOmitted: true },
    { request: "Ask 2.", outcome: "completed", delivery: "discarded", hostResult: fact(2) },
  ]);
});

test("a rewritten block names every source result it does not carry, never a bare shell (#3200 review)", () => {
  const resync = rewrittenAggregate(30);
  expect(utf8(previousFormatter(scope, resync))).toBeGreaterThan(STARTUP_CONTEXT_LIMITS.gemini.maxBytes); // forces a rewrite
  const text = conversationHistory(scope, resync, STARTUP_CONTEXT_LIMITS.gemini);
  expect(utf8(text)).toBeLessThanOrEqual(STARTUP_CONTEXT_LIMITS.gemini.maxBytes);
  const entries = JSON.parse(text.slice(RESYNC_PREFIX.length));
  expect(entries[0]).toEqual({ omitted: "older_outcomes" });
  const shell = (i: number) => ({ request: `Find signal ${i}.`, outcome: "completed", delivery: "discarded" });
  // 3,902 + 3 x 4,002 = 15,908 serialized fact bytes; a 502-byte result would exceed 16,000.
  expect(entries.slice(-6)).toEqual([
    { ...shell(0), resultOmitted: true },
    { ...shell(1), resultOmitted: true },
    { ...shell(2), hostResult: "2".repeat(4000) },
    { ...shell(3), hostResult: "3".repeat(4000) },
    { ...shell(4), hostResult: "4".repeat(4000) },
    { ...shell(5), hostResult: "5".repeat(3900) },
  ]);
});

test("rewritten blocks never blank a joined result; fitting blocks keep the previous bytes exactly (#3200 review)", () => {
  let seed = 3200;
  const next = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
  let rewritten = 0; let identical = 0;
  for (let n = 0; n < 400; n++) {
    const count = 1 + Math.floor(next() * 40);
    const work = Array.from({ length: count }, (_, i) => ({ conversationId: "ithaca", epoch: 1, utteranceId: `u${i}`, requestId: `r${i}`, turnId: `t${i}`,
      state: "completed" as const, delivery: "discarded" as const, recognized: `${i}`.padEnd(1 + Math.floor(next() * 500), "\u03b1"), submitted: "s" }));
    const results = work.map((w, i) => ({ conversationId: "ithaca", epoch: 1, requestId: w.requestId, turnId: w.turnId, facts: `${i % 10}`.repeat(1 + Math.floor(next() * 4200)) }));
    for (const limits of [STARTUP_CONTEXT_LIMITS.gemini, STARTUP_CONTEXT_LIMITS.gpt]) {
      const previous = previousFormatter(scope, { work, results });
      const previousFacts = JSON.parse(previous.slice(RESYNC_PREFIX.length)).reduce((sum: number, e: { hostResult?: string }) => sum + (e.hostResult ? utf8(JSON.stringify(e.hostResult)) : 0), 0);
      const text = conversationHistory(scope, { work, results }, limits);
      if (utf8(previous) <= limits.maxBytes && previousFacts <= limits.maxFactBytes) { expect(text).toBe(previous); identical++; continue; }
      rewritten++;
      expect(utf8(text)).toBeLessThanOrEqual(limits.maxBytes);
      for (const e of JSON.parse(text.slice(RESYNC_PREFIX.length))) if (!e.omitted) expect(typeof e.hostResult === "string" || e.resultOmitted === true).toBe(true);
    }
  }
  expect(rewritten).toBeGreaterThan(100);
  expect(identical).toBeGreaterThan(50);
});
