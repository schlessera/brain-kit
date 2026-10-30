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
