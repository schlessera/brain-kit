import type { TurnJournalSummary } from "../src/protocol.js";
import { expect, test } from "bun:test";
import { parseClientMessage, parseServerMessage } from "../src/schemas.js";
const decision = { type: "scope_decision", sessionId: "ithaca", turnId: "voyage", eventId: "cap-loom", submissionId: "athena", action: "continue" };
test("scope decisions require exact event/turn/session/submission identity and accept no spoken/free-text/model grant", () => {
  expect(parseClientMessage(JSON.stringify(decision)).ok).toBe(true);
  for (const key of ["sessionId", "turnId", "eventId", "submissionId"]) {
    const incomplete = { ...decision } as Record<string, unknown>; delete incomplete[key];
    expect(parseClientMessage(JSON.stringify(incomplete)).ok, `SCOPE_REQUIRED_${key}`).toBe(false);
  }
  for (const patch of [{ action: "unlimited" }, { action: "yes" }, { channel: "voice" }, { policy: {} }, { answers: { Continue: "yes" } }])
    expect(parseClientMessage(JSON.stringify({ ...decision, ...patch })).ok).toBe(false);
});
test("additive scope receipts validate finite exact ceilings and preserve nullable observation facts", () => {
  const summary: TurnJournalSummary = { state: "complete", changedFiles: null, steeringFiles: null, costUsd: null, costIsEstimate: null, profile: null, actor: null, model: null, policyHash: null, sharedAttribution: false, observedAt: null,
    scope: { policySource: "default", limits: { files_changed: 1000, tool_calls: 500, minutes: 120, turn_bytes: 4294967296 }, hardTimeoutMs: 600000,
      calls: 500, minutes: 1, changedPaths: null, observedBytes: null, coverage: "partial", observedAt: 1,
      receipts: [{ eventId: "loom", dimension: "tool_calls", count: 500, cap: 500, newCap: 1000, overshoot: 0, frozen: true, observedAt: 1, state: "paused" }] } };
  const parsed = parseServerMessage(JSON.stringify({ type: "turn_journal", sessionId: "ithaca", turnId: "voyage", journal: summary }));
  expect(parsed.ok).toBe(true); if (parsed.ok && parsed.message.type === "turn_journal") expect(parsed.message.journal.scope).toEqual(summary.scope);
  summary.scope!.receipts[0]!.newCap = Infinity;
  expect(parseServerMessage(JSON.stringify({ type: "turn_journal", sessionId: "ithaca", turnId: "voyage", journal: summary })).ok, "SCOPE_NONFINITE_CEILING_REFUSED").toBe(false);
  for (const state of ["accepted", "pending", "answered_elsewhere", "ended_before_answer", "refused", "failed"]) expect(parseServerMessage(JSON.stringify({ ...decision, type: "scope_decision_receipt", state })).ok).toBe(true);
});
