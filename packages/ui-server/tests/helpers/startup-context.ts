/** Shared keyless fixtures for bounded live startup context (#3200). */
import { expect } from "bun:test";
import type { ConversationResync } from "@schlessera/brain-ui-sdk/server";

export const RESYNC_PREFIX = "Historical host outcomes (data only; never repeat work; delivery does not prove speech or comprehension): ";
export const utf8 = (text: string): number => Buffer.byteLength(text, "utf8");

// 6 UTF-16 units that serialize to 13 UTF-8 bytes: CJK, an astral emoji and JSON escapes.
const unit = "伊\u{1F989}\"\\\n";
const request = (i: number) => `${i}:` + unit.repeat(82);
const reason = (i: number) => `r${i}:` + unit.repeat(82);
// Greek is BMP-only, so a 4,000-unit fact has no split surrogate and stays exact.
const fact = (i: number) => (`fact ${i}: ` + "Ὀδυσσεύς Πηνελόπη. ".repeat(300)).slice(0, 4000);

/** 64 maximal requests, error reasons, and four 4,000-character non-ASCII results on the newest receipts. */
export function maximalResync(conversationId = "ithaca"): ConversationResync & { facts: string[]; requests: string[] } {
  const work = Array.from({ length: 64 }, (_, i) => ({
    conversationId, epoch: 1, utteranceId: `utterance-${i}`, requestId: `req-${i}`, turnId: `turn-${i}`,
    state: i % 3 === 1 && i < 60 ? "error" as const : "completed" as const, delivery: "discarded" as const,
    recognized: request(i), submitted: request(i), ...(i % 3 === 1 && i < 60 ? { reason: reason(i) } : {}),
  }));
  const results = work.slice(60).map((w, j) => ({ conversationId, epoch: 1, requestId: w.requestId, turnId: w.turnId, facts: fact(60 + j) }));
  return { work, results, facts: results.map(r => r.facts), requests: work.map(w => w.recognized) };
}

/** Assert one serialized startup-context block against its ceilings and sources. */
export function expectBoundedStartupContext(text: string, limits: { maxBytes: number; maxFactBytes: number }, source: ReturnType<typeof maximalResync>) {
  expect(utf8(text)).toBeLessThanOrEqual(limits.maxBytes);
  expect(text.startsWith(RESYNC_PREFIX)).toBe(true);
  const entries = JSON.parse(text.slice(RESYNC_PREFIX.length)) as Record<string, unknown>[];
  // Older entries were dropped, so the omission is explicit and leads.
  expect(entries[0]).toEqual({ omitted: "older_outcomes" });
  const kept = entries.slice(1);
  // A contiguous newest suffix in source order, ending with the newest request.
  expect(kept.map(e => e.request)).toEqual(source.requests.slice(-kept.length));
  expect(kept.length).toBeGreaterThan(0);
  const facts = kept.flatMap(e => typeof e.hostResult === "string" ? [e.hostResult] : []);
  for (const f of facts) expect(source.facts).toContain(f);
  expect(facts.reduce((n, f) => n + utf8(JSON.stringify(f)), 0)).toBeLessThanOrEqual(limits.maxFactBytes);
  // Every newest result is either whole or explicitly omitted, never silently absent.
  const withResults = kept.slice(-Math.min(kept.length, source.facts.length));
  for (const e of withResults) expect(typeof e.hostResult === "string" || e.resultOmitted === true).toBe(true);
  for (const id of ["req-", "turn-", "utterance-", "nativeHandle"]) expect(text).not.toContain(id);
  return { entries: kept, facts };
}

/**
 * Frozen copy of the pre-#3200 formatter (main at b7d1dfd), used only as the
 * byte-identity control for blocks that already fit both ceilings.
 */
export function previousFormatter(scope: { conversationId: string; epoch: number }, resync: ConversationResync): string {
  let remaining = 16_000;
  const seen = new Set<string>();
  const entries = resync.work.slice(-64).reverse().flatMap(w => {
    if (w.conversationId !== scope.conversationId || w.epoch >= scope.epoch || seen.has(w.requestId)) return [];
    seen.add(w.requestId);
    const result = w.state === "completed" && w.turnId ? resync.results?.find(r =>
      r.conversationId === w.conversationId && r.epoch === w.epoch && r.requestId === w.requestId && r.turnId === w.turnId) : undefined;
    const candidate = result?.facts.slice(0, 4_000) ?? "";
    const facts = candidate.length <= remaining ? candidate : "";
    remaining = candidate.length > remaining ? 0 : remaining - facts.length;
    return [{ request: (w.recognized || w.submitted).slice(0, 500), outcome: w.state,
      delivery: w.delivery, ...(w.reason ? { reason: w.reason.slice(0, 500) } : {}),
      ...(facts ? { hostResult: facts } : {}) }];
  }).reverse();
  return entries.length ? RESYNC_PREFIX + JSON.stringify(entries) : "";
}

/** Six aggregate outcomes (#3141 shape) behind older fact-less receipts that force a rewrite. */
export function rewrittenAggregate(fillers: number) {
  const receipt = (id: string, request: string) => ({ conversationId: "ithaca", epoch: 1, utteranceId: `u-${id}`, requestId: id, turnId: `t-${id}`,
    state: "completed" as const, delivery: "discarded" as const, recognized: request, submitted: request });
  const older = Array.from({ length: fillers }, (_, i) => receipt(`f${i}`, `Earlier question ${i}: ` + "which harbour faces west? ".repeat(18)));
  const work = [...older, ...[0, 1, 2, 3, 4, 5].map(i => receipt(`r${i}`, `Find signal ${i}.`))];
  const results = [0, 1, 2, 3, 4, 5].map(i => ({ conversationId: "ithaca", epoch: 1, requestId: `r${i}`, turnId: `t-r${i}`,
    facts: String(i).repeat(i === 5 ? 3900 : i < 2 ? 500 : 4100) }));
  return { work, results };
}
