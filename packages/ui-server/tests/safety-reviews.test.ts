/** Real FULL writer, immutable occurrences and host-only individual verdicts. */
import { holdSafetyRecovery } from "./helpers/hold-safety-recovery";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client";
import { createPrincipal } from "../src/db/principals";
import { openSqliteWriter, type SqliteWriter } from "../src/db/write-worker";
import { createGovernanceWrites } from "../src/governance/event-writes";
import * as procedures from "../src/governance/event-writes";
import * as probe from "./fixtures/write-worker-probe";
import * as reviewClock from "./fixtures/safety-review-clock";
import { createSafetyCollector } from "../src/governance/safety-collector";
import { pruneSafetyDetail, safetyCatalogCreated, safetyRecords } from "../src/governance/safety-store";
import { governanceEventRow } from "../src/governance/events";
import { occurrence } from "../src/governance/occurrence";
import { retireChat } from "../src/ws/chat-lifecycle";
import { cleanChatStore } from "../src/ws/chat-store-cleanup";
import type { SafetyReviewBody, SafetyReviewReceipt, SafetyReviewer } from "../src/governance/safety-reviews";
import { expectRejection } from "./helpers/expect-rejection";
import { openDialogue, bindDialogue } from "../src/ws/dialogue-storage";
import * as heldWriter from "./fixtures/held-publication-writer";

async function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-safety-reviews-")), path = join(root, "ui.db");
  const db = createUiDb(path), writer = openSqliteWriter(db), writes = createGovernanceWrites(db, writer);
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const actor: SafetyReviewer = { principalId: principal.id, channel: "owner_history" };
  const bindingId = crypto.randomUUID();
  await writes.safetyBegin({ turnId: "voyage", bindingId, sessionId: null, principalId: principal.id, backendId: "claude", at: 0 });
  db.query("INSERT INTO sessions(id,created_at,last_active_at,backend_id) VALUES('ithaca',0,0,'claude')").run();
  db.query("INSERT INTO chat_session_owners VALUES('ithaca',?,0)").run(principal.id);
  safetyCatalogCreated(db, "ithaca", principal.id, "voyage"); await writes.bind("voyage", "ithaca");
  const collector = createSafetyCollector(db, writes, { turnId: "voyage", bindingId, sessionId: () => "ithaca", backendId: "claude",
    signal: new AbortController().signal, shellProxied: () => true, brainPath: root });
  await collector.ready("claude", 1);
  const channel = writer.channel(reviewClock, undefined); await channel.ready;
  const state = () => writes.safety(null, "ithaca");
  const body = (occurrenceId: string): SafetyReviewBody => ({ version: 1, session: state().session!, occurrenceId,
    expectedEvidenceRevision: state().evidenceRevision, verdict: "safe" });
  const triggers = () => safetyRecords(db, "ithaca").filter(r => r.kind === "occurrence");
  const add = async (name: string, finalize = true) => {
    await collector.begin(name, "WebFetch", { url: "https://ithaca.invalid/notice" });
    if (finalize) await collector.result(name, "WebFetch", "The harbour is open.", true);
    return triggers().at(-1)!.id;
  };
  const review = async (occurrenceId: string) => {
    const value = body(occurrenceId), prepared = await writes.safetyPrepareReview(value, actor);
    expect(prepared.stage).toBe("prepared");
    return writes.safetyCommitReview(prepared.requestId!, value, actor);
  };
  return { root, path, db, writer, writes, collector, actor, bindingId, channel, state, body, triggers, add, review,
    async close() { await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("individual committed A/B/C verdicts preserve same-source restrictions independently of pruned pages", async () => {
  const f = await fixture(); try {
    expect(f.writer.offloop).toBe(true);
    const [a, b, c] = [await f.add("A"), await f.add("B"), await f.add("C")];
    const before = f.state();
    const result = await f.review(a!);
    expect(result.stage).toBe("verdict_committed");
    expect(f.state().unresolvedCount, "REVIEW_A_LEAVES_B_AND_SAME_SOURCE_C").toBe(2);
    expect(f.state().earliestUnresolvedId).toBe(b!);
    expect(f.state().restriction, "REVIEW_A_LEAVES_RESTRICTION").toBe("restricted");
    expect(BigInt(f.state().evidenceRevision)).toBeGreaterThan(BigInt(before.evidenceRevision));
    pruneSafetyDetail(f.db, Number.MAX_SAFE_INTEGER);
    expect(safetyRecords(f.db, "ithaca", 1)).toHaveLength(1);
    expect(safetyRecords(f.db, "ithaca", 1)[0]!.detailPruned).toBe(true);
    expect(f.state().unresolvedCount, "REVIEW_PARTIAL_PRUNED_PAGE_IS_NOT_AGGREGATE").toBe(2);
    expect(safetyRecords(f.db, "ithaca").filter(r => r.kind === "safe_decision")[0]!.occurrenceId).toBe(a!);
    await f.review(b!); expect(f.state().unresolvedCount).toBe(1);
    expect(f.state().restriction).toBe("restricted");
    await f.review(c!); expect(f.state().restriction, "REVIEW_ONLY_COMPLETE_ZERO_UNRESOLVED_RESTORES_NORMAL").toBe("normal");
    expect(f.db.query("SELECT COUNT(*) n FROM safety_decisions").get()).toEqual({ n: 3 });
    expect(() => f.db.query("UPDATE safety_decisions SET verdict='safe'").run()).toThrow("immutable safety decision");
  } finally { await f.close(); }
});

test("a queued review sees adopted provisional input before its reservation commits", async () => {
  const f = await fixture(), release = new Int32Array(new SharedArrayBuffer(4));
  const submitReservation = Promise.withResolvers<void>();
  let held: Promise<unknown> | undefined, pending: Promise<unknown> | undefined;
  try {
    const id = await f.add("A");
    openDialogue(f.db, { conversationId: "target-voice", principalId: f.actor.principalId, epoch: 1, providerId: "voice", sessionId: "ithaca" });
    const scout = openDialogue(f.db, { conversationId: "scout-voice", principalId: f.actor.principalId, epoch: 1, providerId: "voice" });
    await f.writes.safetyBegin({ turnId: "scout", bindingId: "scout-binding", sessionId: null,
      historyOwnerId: scout.id, principalId: f.actor.principalId, backendId: "claude", at: 0 });
    await f.writes.safetyReady("scout", "claude", 1);
    bindDialogue(f.db, "scout-voice", f.actor.principalId, "ithaca");
    const body = f.body(id), prepared = await f.writes.safetyPrepareReview(body, f.actor);
    expect(prepared.stage).toBe("prepared");
    const channel = f.writer.channel(heldWriter, {}); await channel.ready;
    const entered = new Int32Array(new SharedArrayBuffer(4)); held = channel.call("hold", entered, release);
    const waiting = Atomics.waitAsync(entered, 0, 0, 5000); if (waiting.async) await waiting.value;
    expect(Atomics.load(entered, 0)).toBe(1);
    // Hold only submission of the reservation, forwarding every call to the
    // real FULL writer. The local overlay must restrict before SQL exists.
    const delayedWriter: SqliteWriter = { ...f.writer, channel(module, options, revive) {
      const channel = f.writer.channel(module, options, revive);
      return { ...channel, call<T>(name: string, ...args: unknown[]): Promise<T> {
        return name === "safetyReserve" ? submitReservation.promise.then(() => channel.call<T>(name, ...args)) : channel.call<T>(name, ...args);
      } };
    } };
    const queuedWrites = createGovernanceWrites(f.db, delayedWriter);
    pending = queuedWrites.firstTaint({ kind: "taint", turnId: "scout", sessionId: null,
      actor: "interactive", model: null, profile: "governed", payload: { source: "web_fetch", tool: "WebFetch", detail: null,
        occurrence: occurrence("scout-binding", "tool_web_input", "scout-input", "open") } });
    const result = f.writes.safetyCommitReview(prepared.requestId!, body, f.actor);
    Atomics.store(release, 0, 1); Atomics.notify(release, 0); await held;
    expect(await result, "ADOPTED_LOCAL_INPUT_PREVENTS_SAFE_VERDICT").toMatchObject({ stage: "refused", reason: "recording_pending" });
    expect(f.db.query("SELECT COUNT(*) n FROM safety_pending").get()).toEqual({ n: 0 });
    submitReservation.resolve();
    await pending;
    expect(f.db.query("SELECT COUNT(*) n FROM safety_decisions").get()).toEqual({ n: 0 });
    expect(f.state().unresolvedCount).toBe(2);
  } finally {
    submitReservation.resolve();
    Atomics.store(release, 0, 1); Atomics.notify(release, 0);
    await Promise.allSettled([held, pending]); await f.close();
  }
});

for (const mode of ["open", "interrupted_unknown", "finalized"] as const) test(`review eligibility requires explicit finalized delivery: ${mode}`, async () => {
  const f = await fixture(); try {
    const a = await f.add("A", false);
    if (mode === "interrupted_unknown") await f.collector.result("A", "WebFetch", "Interrupted", false);
    if (mode === "finalized") await f.collector.result("A", "WebFetch", "Ended", true);
    const value = f.body(a), prepared = await f.writes.safetyPrepareReview(value, f.actor);
    expect(prepared.reason, "REVIEW_NONFINAL_EXPOSURE_IS_INELIGIBLE").toBe(mode === "finalized" ? null : "not_finalized");
    const result = await f.writes.safetyCommitReview(prepared.requestId!, value, f.actor);
    expect(result.stage).toBe(mode === "finalized" ? "verdict_committed" : "refused");
    expect(f.state().unresolvedCount).toBe(mode === "finalized" ? 0 : 1);
  } finally { await f.close(); }
});

test("strict review body refuses ranges, source/session-wide clears and caller authority fields", async () => {
  const f = await fixture(); try {
    const value = f.body(await f.add("A"));
    for (const extra of [{ occurrenceIds: [value.occurrenceId] }, { throughSequence: "99" }, { source: "web_fetch" },
      { clear: true }, { principalId: f.actor.principalId }, { channel: "owner_history" }, { rule: {} }]) {
      await expectRejection(f.writes.safetyPrepareReview({ ...value, ...extra }, f.actor), "Unrecognized key", "REVIEW_REJECTS_NONINDIVIDUAL_CLEAR");
    }
    expect(f.state().unresolvedCount, "REVIEW_REJECTS_NONINDIVIDUAL_CLEAR").toBe(1);
    expect(f.db.query("SELECT COUNT(*) n FROM safety_review_requests").get()).toEqual({ n: 0 });
  } finally { await f.close(); }
});

test("host requests reject foreign identity, invented IDs and conflicting retries without replacing receipts", async () => {
  const f = await fixture(); try {
    const a = await f.add("A"), b = await f.add("B"), value = f.body(a);
    const prepared = await f.writes.safetyPrepareReview(value, f.actor);
    const changed = await f.writes.safetyCommitReview(prepared.requestId!, { ...value, occurrenceId: b }, f.actor);
    expect(changed.reason, "REVIEW_CHANGED_BODY_CONFLICT").toBe("request_conflict");
    expect(await f.writes.safetyCommitReview(prepared.requestId!, value, { ...f.actor, principalId: "circe" }))
      .toMatchObject({ reason: "unavailable", projection: null });
    expect(await f.writes.safetyCommitReview("invented", value, f.actor)).toMatchObject({ reason: "unavailable", projection: null });
    const committed = await f.writes.safetyCommitReview(prepared.requestId!, value, f.actor);
    await f.add("C");
    // Exact replay returns its original historical projection, not a fresh success.
    const reordered = { verdict: value.verdict, expectedEvidenceRevision: value.expectedEvidenceRevision, occurrenceId: a,
      session: { historyGeneration: value.session.historyGeneration, historyOwnerId: value.session.historyOwnerId, sessionId: value.session.sessionId }, version: 1 as const };
    expect(await f.writes.safetyCommitReview(prepared.requestId!, reordered, f.actor), "REVIEW_REPLAY_IS_ORIGINAL_RECEIPT").toEqual(committed);
    expect(f.state().unresolvedCount).toBe(2);
    const again = await f.writes.safetyPrepareReview(f.body(a), f.actor);
    expect(again.reason, "REVIEW_ALREADY_RESOLVED_IS_EXPLICIT").toBe("already_resolved");
    expect(await f.writes.safetyCommitReview(again.requestId!, f.body(a), f.actor)).toEqual(again);
    expect(f.db.query("SELECT COUNT(*) n FROM safety_decisions").get()).toEqual({ n: 1 });
  } finally { await f.close(); }
});

test("new committed and pending occurrences win a prepared-review race", async () => {
  const f = await fixture(); try {
    const a = await f.add("A"), value = f.body(a), prepared = await f.writes.safetyPrepareReview(value, f.actor);
    await f.add("B");
    expect(await f.writes.safetyCommitReview(prepared.requestId!, value, f.actor), "REVIEW_NEW_OCCURRENCE_STALES_REVIEW")
      .toMatchObject({ stage: "refused", reason: "stale_revision" });
    expect(f.state().unresolvedCount).toBe(2);
    const current = f.body(a), next = await f.writes.safetyPrepareReview(current, f.actor);
    const hold = f.writer.channel(probe, { table: "review_hold" }); await hold.ready;
    const entered = new Int32Array(new SharedArrayBuffer(4));
    const slow = hold.call("slow", "Ithaca", 200, entered), waiting = Atomics.waitAsync(entered, 0, 0, 5000);
    if (waiting.async) await waiting.value;
    expect(Atomics.load(entered, 0)).toBe(1);
    const added = f.writes.firstTaint({ kind: "taint", turnId: "voyage", sessionId: "ithaca", actor: "interactive", model: null, profile: null,
      payload: { source: "web_fetch", tool: "WebFetch", detail: null, occurrence: occurrence(f.bindingId, "tool_web_input", "C", "finalized") } });
    const committing = f.writes.safetyCommitReview(next.requestId!, current, f.actor);
    expect(f.state().restriction, "REVIEW_PENDING_INPUT_RESTRICTS_IMMEDIATELY").toBe("restricted");
    expect(f.state().reasons).toContain("recording_pending");
    await slow; await added;
    expect((await committing).reason, "REVIEW_PENDING_INPUT_WINS").toBe("recording_pending");
    expect(f.state().unresolvedCount).toBe(3);
  } finally { await f.close(); }
});

test("a queued verdict never loosens admission before the FULL worker COMMIT", async () => {
  const f = await fixture(); try {
    const a = await f.add("A"), value = f.body(a), prepared = await f.writes.safetyPrepareReview(value, f.actor);
    const hold = f.writer.channel(probe, { table: "verdict_hold" }); await hold.ready;
    const entered = new Int32Array(new SharedArrayBuffer(4));
    const slow = hold.call("slow", "Ithaca", 200, entered), waiting = Atomics.waitAsync(entered, 0, 0, 5000);
    if (waiting.async) await waiting.value;
    expect(Atomics.load(entered, 0)).toBe(1);
    const committing = f.writes.safetyCommitReview(prepared.requestId!, value, f.actor);
    expect(f.state().unresolvedCount, "REVIEW_PENDING_VERDICT_IS_NOT_A_DECISION").toBe(1);
    expect(createGovernanceWrites(f.db, f.writer).taint(null, "ithaca")).not.toBeNull();
    await slow; expect((await committing).verdict).toBe("committed");
    expect(f.state().restriction).toBe("normal");
  } finally { await f.close(); }
});

test("a newly pending occurrence immediately restricts a previously resolved chat through every facade", async () => {
  const f = await fixture(); try {
    await f.review(await f.add("A")); expect(f.state().restriction).toBe("normal");
    const hold = f.writer.channel(probe, { table: "new_occurrence_hold" }); await hold.ready;
    const entered = new Int32Array(new SharedArrayBuffer(4));
    const slow = hold.call("slow", "Ithaca", 200, entered), waiting = Atomics.waitAsync(entered, 0, 0, 5000);
    if (waiting.async) await waiting.value;
    expect(Atomics.load(entered, 0)).toBe(1);
    const added = f.writes.firstTaint({ kind: "taint", turnId: "voyage", sessionId: "ithaca", actor: "interactive", model: null, profile: null,
      payload: { source: "web_fetch", tool: "WebFetch", detail: null, occurrence: occurrence(f.bindingId, "tool_web_input", "B", "finalized") } });
    for (const writes of [f.writes, createGovernanceWrites(f.db, f.writer)]) {
      expect(writes.safety(null, "ithaca").restriction, "REVIEW_NEW_PENDING_INPUT_RESTRICTS_RESOLVED_CHAT").toBe("restricted");
      expect(writes.taint(null, "ithaca")).not.toBeNull();
    }
    await slow; await added;
    expect(f.state().unresolvedCount).toBe(1);
  } finally { await f.close(); }
});

test("genuine verdict COMMIT failure rolls back decision, revision and receipt, allowing exact retry", async () => {
  const f = await fixture(); try {
    const a = await f.add("A"), value = f.body(a), prepared = await f.writes.safetyPrepareReview(value, f.actor), before = f.state();
    // AFTER INSERT runs; the missing FK is checked only by the outer COMMIT.
    f.db.exec(`CREATE TABLE review_commit_probe(id TEXT REFERENCES safety_records(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_review_commit AFTER INSERT ON safety_decisions BEGIN INSERT INTO review_commit_probe VALUES('missing-raft'); END`);
    await expectRejection(f.writes.safetyCommitReview(prepared.requestId!, value, f.actor), "FOREIGN KEY constraint failed");
    expect(f.db.query("SELECT COUNT(*) n FROM review_commit_probe").get()).toEqual({ n: 0 });
    expect(f.db.query("SELECT COUNT(*) n FROM safety_decisions").get(), "REVIEW_COMMIT_FAILURE_HAS_NO_DECISION").toEqual({ n: 0 });
    expect(f.state(), "REVIEW_COMMIT_FAILURE_PRESERVES_AGGREGATE").toEqual(before);
    expect(f.db.query("SELECT terminal_at,receipt FROM safety_review_requests WHERE id=?").get(prepared.requestId!))
      .toEqual({ terminal_at: null, receipt: JSON.stringify(prepared) });
    f.db.exec("DROP TRIGGER fail_review_commit");
    expect((await f.writes.safetyCommitReview(prepared.requestId!, value, f.actor)).verdict).toBe("committed");
  } finally { await f.close(); }
});

test("failed prepare COMMIT issues no handle or success receipt", async () => {
  const f = await fixture(); try {
    const value = f.body(await f.add("A")), before = f.state();
    f.db.exec(`CREATE TABLE prepare_commit_probe(id TEXT REFERENCES safety_records(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_prepare_commit AFTER INSERT ON safety_review_requests BEGIN INSERT INTO prepare_commit_probe VALUES('missing-raft'); END`);
    await expectRejection(f.writes.safetyPrepareReview(value, f.actor), "FOREIGN KEY constraint failed");
    expect(f.db.query("SELECT COUNT(*) n FROM safety_review_requests").get(), "REVIEW_FAILED_PREPARE_ISSUES_NO_HANDLE").toEqual({ n: 0 });
    expect(f.state()).toEqual(before);
  } finally { await f.close(); }
});

test("failed new recording cannot be hidden by resolving previously retained evidence", async () => {
  const f = await fixture(); try {
    const a = await f.add("A"), value = f.body(a), prepared = await f.writes.safetyPrepareReview(value, f.actor);
    f.db.exec(`CREATE TABLE occurrence_commit_probe(id TEXT REFERENCES safety_records(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_new_occurrence AFTER INSERT ON safety_records BEGIN INSERT INTO occurrence_commit_probe VALUES('missing-raft'); END`);
    await expectRejection(f.collector.begin("B", "WebFetch", { url: "https://troy.invalid" }), "FOREIGN KEY constraint failed");
    expect(f.state().reasons, "REVIEW_LOST_INPUT_RETAINS_FAILURE_LATCH").toContain("recording_failed");
    expect(await f.writes.safetyCommitReview(prepared.requestId!, value, f.actor))
      .toMatchObject({ stage: "refused", reason: "recording_failed" });
    expect(f.state().restriction).toBe("restricted");
    expect(f.state().unresolvedCount).toBe(1);
    expect(f.db.query("SELECT COUNT(*) n FROM safety_pending").get()).toEqual({ n: 1 });
  } finally { await f.close(); }
});

test("a loss notice whose COMMIT rolls back still refuses verdicts through the shared local failure marker", async () => {
  const f = await fixture(); try {
    const a = await f.add("A"), value = f.body(a), prepared = await f.writes.safetyPrepareReview(value, f.actor);
    holdSafetyRecovery(f.db);
    f.db.exec(`CREATE TABLE loss_commit_probe(id TEXT REFERENCES safety_records(id) DEFERRABLE INITIALLY DEFERRED);
      CREATE TRIGGER fail_loss_commit AFTER UPDATE OF failed ON safety_meta WHEN NEW.failed=1
      BEGIN INSERT INTO loss_commit_probe VALUES('missing-raft'); END;
      CREATE TRIGGER fail_loss_chat AFTER UPDATE OF failure ON safety_collections WHEN NEW.failure IS NOT NULL
      BEGIN INSERT INTO loss_commit_probe VALUES('missing-raft'); END`);
    await expectRejection(f.writes.safetyFail("voyage"), "FOREIGN KEY constraint failed");
    expect(f.db.query("SELECT failed FROM safety_meta").get()).toEqual({ failed: 0 });
    expect(await f.writes.safetyCommitReview(prepared.requestId!, value, f.actor), "REVIEW_LOCAL_LOSS_REFUSES_WITH_RECORDING_FAILED")
      .toMatchObject({ stage: "refused", reason: "recording_failed", projection: null });
    expect(f.state().unresolvedCount).toBe(1);
    expect(createGovernanceWrites(f.db, f.writer).recordingAvailable(null, "ithaca")).toBe(false);
  } finally { await f.close(); }
});

test("durable reservation and duplicate reviewers serialize across independent FULL writers", async () => {
  const f = await fixture();
  // A second existing connection must not run startup recovery on live epochs.
  const { Database } = await import("bun:sqlite");
  const peer = new Database(f.path); peer.exec("PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000");
  const writer = openSqliteWriter(peer), other = createGovernanceWrites(peer, writer);
  try {
    const a = await f.add("A"), value = f.body(a);
    const [one, two] = await Promise.all([f.writes.safetyPrepareReview(value, f.actor), other.safetyPrepareReview(value, f.actor)]);
    const receipts = await Promise.all([f.writes.safetyCommitReview(one.requestId!, value, f.actor), other.safetyCommitReview(two.requestId!, value, f.actor)]);
    expect(receipts.map(r => r.reason).sort(), "REVIEW_TWO_WRITERS_APPEND_EXACTLY_ONE_DECISION").toEqual([null, "already_resolved"].sort());
    expect(f.db.query("SELECT COUNT(*) n FROM safety_decisions").get()).toEqual({ n: 1 });
    const b = await f.add("B"), current = f.body(b), next = await f.writes.safetyPrepareReview(current, f.actor);
    const row = governanceEventRow({ kind: "taint", turnId: "voyage", sessionId: "ithaca", actor: "interactive", model: null, profile: null,
      payload: { source: "web_fetch", tool: "WebFetch", detail: null } });
    const calls = writer.channel(procedures, undefined);
    await calls.call("safetyReserve", row, "reserved-C", 1024);
    expect((await f.writes.safetyCommitReview(next.requestId!, current, f.actor)).reason, "REVIEW_OTHER_WRITER_PENDING_WINS").toBe("recording_pending");
    expect(f.state().restriction).toBe("restricted");
  } finally { await writer.close(); peer.close(); await f.close(); }
});

test("expiry, bounded receipt retention and pruning never accept an old or arbitrary handle", async () => {
  const f = await fixture(); try {
    const value = f.body(await f.add("A"));
    const prepared = await f.channel.call<SafetyReviewReceipt>("safetyPrepareReview", value, f.actor, 1000);
    const expired = await f.channel.call<SafetyReviewReceipt>("safetyCommitReview", prepared.requestId!, value, f.actor, 901000, false);
    expect(expired.reason, "REVIEW_EXPIRED_HANDLE_CANNOT_MUTATE").toBe("request_expired");
    expect(await f.channel.call<SafetyReviewReceipt>("safetyCommitReview", prepared.requestId!, value, f.actor, 902000, false)).toEqual(expired);
    const later = await f.channel.call<SafetyReviewReceipt>("safetyPrepareReview", value, f.actor, 86400000 + 901000);
    expect(f.db.query("SELECT 1 FROM safety_review_requests WHERE id=?").get(prepared.requestId!)).toBeNull();
    expect((await f.channel.call<SafetyReviewReceipt>("safetyCommitReview", prepared.requestId!, value, f.actor, 86400000 + 901001, false)).reason,
      "REVIEW_PRUNED_HANDLE_NEVER_RECREATES_REQUEST").toBe("unavailable");
    expect(later.requestId!).not.toBe(prepared.requestId!);
    expect(f.state().unresolvedCount).toBe(1);
  } finally { await f.close(); }
});

async function holdReviewWriter(f: Awaited<ReturnType<typeof fixture>>, milliseconds: number) {
  const hold = f.writer.channel(probe, { table: "review_clock_hold" }); await hold.ready;
  const entered = new Int32Array(new SharedArrayBuffer(4)), startedAt = Date.now();
  const pending = hold.call("slow", "Ithaca", milliseconds, entered);
  const waiting = Atomics.waitAsync(entered, 0, 0, 5000);
  if (waiting.async) await waiting.value;
  expect(Atomics.load(entered, 0)).toBe(1);
  return { pending, earliestCompletion: startedAt + milliseconds };
}

test("a review expiring in the FULL writer queue cannot commit a verdict", async () => {
  const f = await fixture(); try {
    const value = f.body(await f.add("A")), issuedAt = Date.now() - 899000;
    const prepared = await f.channel.call<SafetyReviewReceipt>("safetyPrepareReview", value, f.actor, issuedAt);
    const hold = await holdReviewWriter(f, 1400);
    expect(Date.now()).toBeLessThan(issuedAt + 900000);
    const committing = f.writes.safetyCommitReview(prepared.requestId!, value, f.actor);
    await hold.pending;
    expect((await committing).reason, "REVIEW_EXPIRED_IN_QUEUE_CANNOT_COMMIT").toBe("request_expired");
    expect(f.db.query("SELECT COUNT(*) n FROM safety_decisions").get()).toEqual({ n: 0 });
    expect(f.state().unresolvedCount).toBe(1);
    expect(f.state().restriction).toBe("restricted");
  } finally { await f.close(); }
});

test("review issuance starts its full lifetime after queued preparation executes", async () => {
  const f = await fixture(); try {
    const value = f.body(await f.add("A")), hold = await holdReviewWriter(f, 200);
    const preparing = f.writes.safetyPrepareReview(value, f.actor);
    await hold.pending;
    const prepared = await preparing;
    const row = f.db.query("SELECT issued_at,expires_at FROM safety_review_requests WHERE id=?").get(prepared.requestId!) as { issued_at: number; expires_at: number };
    expect(row.issued_at, "REVIEW_ISSUANCE_USES_EXECUTION_TIME").toBeGreaterThanOrEqual(hold.earliestCompletion);
    expect(row.expires_at).toBe(row.issued_at + 900000);
  } finally { await f.close(); }
});

test("decision time and terminal receipt retention start after queued commit executes", async () => {
  const f = await fixture(); try {
    const value = f.body(await f.add("A")), prepared = await f.writes.safetyPrepareReview(value, f.actor);
    const hold = await holdReviewWriter(f, 200);
    const committing = f.writes.safetyCommitReview(prepared.requestId!, value, f.actor);
    await hold.pending;
    const committed = await committing;
    const decision = f.db.query("SELECT decided_at FROM safety_decisions WHERE request_id=?").get(prepared.requestId!) as { decided_at: number };
    const row = f.db.query("SELECT terminal_at FROM safety_review_requests WHERE id=?").get(prepared.requestId!) as { terminal_at: number };
    expect(decision.decided_at, "REVIEW_DECISION_USES_EXECUTION_TIME").toBeGreaterThanOrEqual(hold.earliestCompletion);
    expect(row.terminal_at, "REVIEW_RETENTION_USES_TERMINAL_TIME").toBeGreaterThanOrEqual(decision.decided_at);
    expect(await f.channel.call<SafetyReviewReceipt>("safetyCommitReview", prepared.requestId!, value, f.actor, row.terminal_at + 86400000 - 1, false)).toEqual(committed);
    expect((await f.channel.call<SafetyReviewReceipt>("safetyCommitReview", prepared.requestId!, value, f.actor, row.terminal_at + 86400000, false)).reason).toBe("request_expired");
  } finally { await f.close(); }
});

test("a terminal receipt expiring in the FULL writer queue cannot replay success", async () => {
  const f = await fixture(); try {
    const value = f.body(await f.add("A")), terminalAt = Date.now() - 86400000 + 1000;
    const prepared = await f.channel.call<SafetyReviewReceipt>("safetyPrepareReview", value, f.actor, terminalAt - 1);
    await f.channel.call<SafetyReviewReceipt>("safetyCommitReview", prepared.requestId!, value, f.actor, terminalAt, false);
    const hold = await holdReviewWriter(f, 1400);
    expect(Date.now()).toBeLessThan(terminalAt + 86400000);
    const replaying = f.writes.safetyCommitReview(prepared.requestId!, value, f.actor);
    await hold.pending;
    expect((await replaying).reason, "REVIEW_REPLAY_EXPIRY_USES_EXECUTION_TIME").toBe("request_expired");
    expect(f.db.query("SELECT COUNT(*) n FROM safety_decisions").get()).toEqual({ n: 1 });
  } finally { await f.close(); }
});

test("terminal receipt retention includes work after the verdict decision", async () => {
  const f = await fixture(); try {
    const value = f.body(await f.add("A"));
    const prepared = await f.channel.call<SafetyReviewReceipt>("safetyPrepareReview", value, f.actor, 1000);
    const committed = await f.channel.call<SafetyReviewReceipt>("safetyCommitReview", prepared.requestId!, value, f.actor, [2000, 3000], false);
    expect(committed.verdict).toBe("committed");
    expect(f.db.query("SELECT decided_at FROM safety_decisions").get()).toEqual({ decided_at: 2000 });
    expect(f.db.query("SELECT terminal_at FROM safety_review_requests WHERE id=?").get(prepared.requestId!), "REVIEW_TERMINAL_TIME_INCLUDES_PROJECTION_WORK")
      .toEqual({ terminal_at: 3000 });
    expect(await f.channel.call<SafetyReviewReceipt>("safetyCommitReview", prepared.requestId!, value, f.actor, 3000 + 86400000 - 1, false)).toEqual(committed);
  } finally { await f.close(); }
});

test("receipt capacity refuses preparation without evicting existing live receipts; reserved verdict remains usable", async () => {
  const f = await fixture(); try {
    const value = f.body(await f.add("A")), requests: SafetyReviewReceipt[] = [];
    for (let i = 0; i < 32; i++) requests.push(await f.writes.safetyPrepareReview(value, f.actor));
    expect(requests.every(r => r.stage === "prepared")).toBe(true);
    expect((await f.writes.safetyPrepareReview(value, f.actor)).reason, "REVIEW_OUTSTANDING_REQUESTS_ARE_BOUNDED").toBe("capacity");
    f.db.query("UPDATE safety_meta SET used_rows=1000000,used_bytes=536870912").run();
    expect((await f.writes.safetyCommitReview(requests[0]!.requestId!, value, f.actor)).verdict, "REVIEW_PREPAID_VERDICT_WORKS_AT_INGESTION_CAPACITY").toBe("committed");
    expect(f.db.query("SELECT COUNT(*) n FROM safety_review_requests").get()).toEqual({ n: 32 });
  } finally { await f.close(); }
});

test("brain receipt bytes are reserved before preparation and never evict live terminal receipts", async () => {
  const f = await fixture(); try {
    const a = await f.add("A"); await f.review(a);
    const value = f.body(a), receipts: SafetyReviewReceipt[] = [];
    // One committed receipt already consumes the first reserved slot.
    for (let i = 0; i < 63; i++) receipts.push(await f.writes.safetyPrepareReview(value, f.actor));
    expect(receipts.every(r => r.reason === "already_resolved")).toBe(true);
    expect((await f.writes.safetyPrepareReview(value, f.actor)).reason, "REVIEW_BRAIN_RECEIPT_CAPACITY_REFUSES_BEFORE_EVICTION").toBe("capacity");
    expect(await f.writes.safetyCommitReview(receipts[0]!.requestId!, value, f.actor)).toEqual(receipts[0]);
    expect(f.db.query("SELECT COUNT(*) n,SUM(reserved_bytes) bytes FROM safety_review_requests").get()).toEqual({ n: 64, bytes: 16777216 });
    expect(() => f.db.query("UPDATE safety_review_requests SET receipt='null' WHERE id=?").run(receipts[0]!.requestId!))
      .toThrow("immutable safety review receipt");
  } finally { await f.close(); }
});

test("an uncommitted host handle survives restart without recreating the request or accepting foreign generations", async () => {
  const f = await fixture(); try {
    const a = await f.add("A"); await f.writes.safetyEnd("voyage");
    const value = f.body(a), prepared = await f.writes.safetyPrepareReview(value, f.actor);
    const foreign = { ...value, session: { ...value.session, historyGeneration: "2" } };
    expect((await f.writes.safetyCommitReview(prepared.requestId!, foreign, f.actor)).reason, "REVIEW_GENERATION_IS_EXACT").toBe("unavailable");
    await f.writer.close(); f.db.close();
    const db = createUiDb(f.path), writer = openSqliteWriter(db), writes = createGovernanceWrites(db, writer);
    try {
      const committed = await writes.safetyCommitReview(prepared.requestId!, value, f.actor);
      expect(committed.verdict, "REVIEW_PREPARED_HANDLE_SURVIVES_RESTART").toBe("committed");
      expect(db.query("SELECT COUNT(*) n FROM safety_review_requests").get()).toEqual({ n: 1 });
      expect((await writes.safetyCommitReview(prepared.requestId!, foreign, f.actor)).reason).toBe("unavailable");
    } finally { await writer.close(); db.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("restart and detail pruning preserve original receipt, aggregate, coverage and monotonic revision", async () => {
  const f = await fixture(); try {
    const a = await f.add("A"), b = await f.add("B"), value = f.body(a), prepared = await f.writes.safetyPrepareReview(value, f.actor);
    const committed = await f.writes.safetyCommitReview(prepared.requestId!, value, f.actor);
    await f.writes.safetyEnd("voyage"); pruneSafetyDetail(f.db, Number.MAX_SAFE_INTEGER);
    const before = f.state(); await f.writer.close(); f.db.close();
    const db = createUiDb(f.path), writer = openSqliteWriter(db), writes = createGovernanceWrites(db, writer);
    try {
      expect(writes.safety(null, "ithaca"), "REVIEW_RESTART_PRESERVES_COMPACT_AGGREGATE").toEqual(before);
      expect(await writes.safetyCommitReview(prepared.requestId!, value, f.actor), "REVIEW_RESTART_PRESERVES_RECEIPT").toEqual(committed);
      const nextValue = { ...value, occurrenceId: b, expectedEvidenceRevision: before.evidenceRevision };
      const next = await writes.safetyPrepareReview(nextValue, f.actor);
      const last = await writes.safetyCommitReview(next.requestId!, nextValue, f.actor);
      expect(last.projection!.restriction).toBe("normal");
      expect(BigInt(last.projection!.evidenceRevision)).toBeGreaterThan(BigInt(before.evidenceRevision));
    } finally { await writer.close(); db.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});

test("resolving known evidence cannot repair incomplete history", async () => {
  const f = await fixture(); try {
    const a = await f.add("A");
    // The host's established coverage-loss path persists a historical gap.
    await f.writes.safetyFail("voyage"); await f.writes.safetyEnd("voyage");
    const { recoverSafetyRecording } = await import("../src/governance/safety-store"); recoverSafetyRecording(f.db);
    expect((await f.review(a)).verdict).toBe("committed");
    expect(f.state().unresolvedCount).toBe(0);
    expect(f.state().restriction, "REVIEW_ZERO_UNRESOLVED_WITH_GAP_STAYS_RESTRICTED").toBe("restricted");
    expect(f.state().coverage.state).toBe("incomplete");
  } finally { await f.close(); }
});

test("retirement overrides successful retries, removes private review detail and survives restart", async () => {
  const f = await fixture(); try {
    const a = await f.add("A"), value = f.body(a), prepared = await f.writes.safetyPrepareReview(value, f.actor);
    await f.writes.safetyCommitReview(prepared.requestId!, value, f.actor);
    const result = retireChat(f.db, { operationId: "retire-ithaca", principalId: f.actor.principalId, target: { sessionId: "ithaca" },
      expected: { backendId: "claude", generation: 1 }, removableBackends: ["claude"], at: Date.now() });
    expect(result.status).toBe("retired"); if (result.status !== "retired") throw new Error("Fixture retirement refused");
    expect(await f.writes.safetyCommitReview(prepared.requestId!, value, f.actor), "REVIEW_RETIRED_SUCCESS_CANNOT_REPLAY")
      .toMatchObject({ stage: "refused", reason: "retired", projection: null });
    cleanChatStore(f.db, result.lifecycleId, "projections", Date.now());
    for (const table of ["safety_review_requests", "safety_decisions", "safety_records"]) expect(f.db.query(`SELECT COUNT(*) n FROM ${table}`).get()).toEqual({ n: 0 });
    await f.writer.close(); f.db.close();
    const db = createUiDb(f.path), writer = openSqliteWriter(db), writes = createGovernanceWrites(db, writer);
    try {
      expect(await writes.safetyCommitReview(prepared.requestId!, value, f.actor), "REVIEW_RETIREMENT_FENCE_OUTLIVES_REQUEST")
        .toMatchObject({ stage: "refused", reason: "retired", projection: null });
      expect((await writes.safetyPrepareReview(value, f.actor)).reason).toBe("retired");
      expect(db.query("SELECT COUNT(*) n FROM safety_review_requests").get()).toEqual({ n: 0 });
    } finally { await writer.close(); db.close(); }
  } finally { rmSync(f.root, { recursive: true, force: true }); }
});
