/** Startup-context byte bounds at their exact edges (#3200). Pure; no transport. */
import { expect, test } from "bun:test";
import { conversationHistory, STARTUP_CONTEXT_LIMITS } from "../src/voice/conversation-history";
import { maximalResync, RESYNC_PREFIX, utf8 } from "./helpers/startup-context";

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
