import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Logger } from "@opentelemetry/api-logs";
import type { SessionHistoryMessage, TurnFailure } from "@schlessera/brain-ui-sdk/protocol";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { createUiDb } from "../src/db/client.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import { createActivityStore } from "../src/activity/store.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import { createPolicyProposals, type PolicyProposalTurn } from "../src/brain/policy-proposal.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { WsHost } from "../src/ws/host.js";
import { handleClientMessage } from "../src/ws/dispatch.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { testAuthorization, testPrincipal } from "./helpers/principal.js";
import { watchWriteSites } from "./helpers/write-sites.js";
import * as probe from "./fixtures/write-worker-probe.js";

const failure: TurnFailure = { errorClass: "server_error", status: 500, message: "Poseidon delayed the voyage." };
const request = { type: "chat_message" as const, text: "Sail for Ithaca", attachments: [] };
const original = "---\nschema_version: 1\nprofiles:\n  interactive: governed\n---\nOdysseus reviews the policy.\n";
const proposed = original.replace("interactive: governed", "interactive: strict");
const input = { content: proposed, rationale: "Use strict for the next voyage." };

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "retry-proposal-odysseus-"));
  const brain = join(root, "brain"), path = join(brain, "context/policies/governance.md");
  mkdirSync(join(brain, "context/policies"), { recursive: true });
  writeFileSync(path, original);
  const db = createUiDb(join(root, "ui.db"));
  const at = Date.parse("2026-07-12T00:00:00Z");
  db.query("INSERT INTO sessions(id,title,created_at,last_active_at,backend_id) VALUES ('ithaca','Voyage',?,?, 'claude')").run(at, at);
  const writer = openSqliteWriter(db), failures: string[] = [];
  const log = { emit: (record: { attributes?: { error?: string } }) => { if (record.attributes?.error) failures.push(record.attributes.error); } } as unknown as Logger;
  const catalog = createSessionCatalog(() => db, log, undefined, { pricing: { resolve: () => null }, store: createActivityStore(db, { writer: "odysseus" }), writer });
  const save = (turnId = "voyage") => catalog.saveRetryRequest!("ithaca", turnId, "athena", request, request.text, failure);
  return { root, brain, path, db, writer, catalog, failures, save,
    async close() { await catalog.settled!(); await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

test("retained retry save, clear, refusal and reservation commit on the worker at FULL", async () => {
  const f = fixture();
  try {
    const sites = await watchWriteSites(f.db, f.writer, ["retry_requests", "retry_receipts"]);
    expect(f.save(), "RETRY_SAVE_ADVERTISES_IMMEDIATELY").toBe(true);
    await f.catalog.settled!();
    expect(f.catalog.peekRetry!("ithaca")?.turnId, "RETRY_SAVE_WORKER_FULL").toBe("voyage");
    expect((await f.catalog.refuseRetry!("ithaca", "refused-voyage", "athena", "Wait for Athena.")).state, "RETRY_REFUSE_WORKER_FULL").toBe("refused");
    const reserved = await f.catalog.reserveRetry!("ithaca", "voyage", "retry-voyage", "athena");
    expect(reserved.request?.text, "RETRY_RESERVE_WORKER_FULL").toBe(request.text);
    expect(f.catalog.retryReceipt!("ithaca", "retry-voyage", "athena").state, "RETRY_RECEIPT_COMMITTED_ON_RETURN").toBe("accepted");
    expect(f.catalog.peekRetry!("ithaca"), "RETRY_RESERVATION_CONSUMES_ELIGIBILITY").toBeNull();
    expect((await f.catalog.reserveRetry!("ithaca", "voyage", "retry-voyage", "athena")).request, "RETRY_DUPLICATE_HAS_NO_DISPATCH").toBeUndefined();
    f.save("return-voyage"); await f.catalog.settled!();
    f.catalog.clearRetryRequest!("ithaca"); await f.catalog.settled!();
    expect(f.db.query("SELECT * FROM retry_requests").all(), "RETRY_CLEAR_WORKER_FULL").toEqual([]);
    expect(f.failures, "RETRY_ALL_WRITES_WORKER_FULL").toEqual([]);
    expect(await sites.log(), "RETRY_TRANSACTION_WRITE_ORDER").toEqual([
      "retry_requests", "retry_receipts", "retry_receipts", "retry_requests", "retry_requests", "retry_requests",
    ]);
  } finally { await f.close(); }
});

test("a retry waits for its pending session row and a clear cancels a deferred save", async () => {
  const f = fixture();
  try {
    const sites = await watchWriteSites(f.db, f.writer, ["sessions", "retry_requests", "retry_receipts"]);
    const held = f.writer.channel(probe, { table: "odysseus_log" }); await held.ready;
    let slow = held.call("slow", "Calypso", 300);
    f.catalog.persistSessionStub("troy", "Sail for Troy", null, "claude");
    expect(f.catalog.saveRetryRequest!("troy", "voyage", "athena", request, request.text, failure), "RETRY_PENDING_SESSION_ADVERTISES_NOW").toBe(true);
    await slow; await f.catalog.settled!();
    expect(f.catalog.peekRetry!("troy")?.turnId, "RETRY_PENDING_SESSION_SAVED_AFTER_ROW").toBe("voyage");
    expect(await sites.log(), "RETRY_SESSION_BEFORE_RETAINED_REQUEST").toEqual(["sessions", "retry_requests"]);
    slow = held.call("slow", "Circe", 300);
    f.catalog.persistSessionStub("troy", "Sail for Troy", null, "claude");
    f.catalog.saveRetryRequest!("troy", "return-voyage", "athena", request, request.text, failure);
    f.catalog.clearRetryRequest!("troy");
    await slow; await f.catalog.settled!();
    expect(f.catalog.peekRetry!("troy"), "RETRY_DEFERRED_SAVE_INVALIDATED").toBeNull();
    expect(f.db.query("SELECT 1 FROM retry_requests WHERE session_id='troy'").get(), "RETRY_DEFERRED_SAVE_NOT_REINSERTED").toBeNull();
    expect(f.failures).toEqual([]);
  } finally { await f.close(); }
});

test("a queued clear hides the retry immediately and precedes reservation", async () => {
  const f = fixture();
  try {
    await watchWriteSites(f.db, f.writer, ["retry_requests", "retry_receipts"]);
    f.save(); await f.catalog.settled!();
    const held = f.writer.channel(probe, { table: "odysseus_log" }); await held.ready;
    const slow = held.call("slow", "Calypso", 300);
    f.catalog.clearRetryRequest!("ithaca");
    expect(f.db.query("SELECT turn_id FROM retry_requests").get(), "RETRY_CLEAR_STILL_QUEUED").toEqual({ turn_id: "voyage" });
    expect(f.catalog.peekRetry!("ithaca"), "RETRY_PENDING_CLEAR_HIDDEN").toBeNull();
    const messages: SessionHistoryMessage[] = [{ role: "assistant", content: "The voyage waits.", toolCalls: [], failure }];
    expect(f.catalog.attachRetryRequest!("ithaca", messages).at(-1)?.retryOfTurnId, "RETRY_PENDING_CLEAR_HISTORY_HIDDEN").toBeUndefined();
    const reservation = f.catalog.reserveRetry!("ithaca", "voyage", "queued-retry", "athena");
    expect((await reservation).receipt.state, "RETRY_CLEAR_BEFORE_RESERVE").toBe("refused");
    await slow;
    expect(f.failures, "RETRY_QUEUED_CLEAR_COMMITTED").toEqual([]);
  } finally { await f.close(); }
});

test("a failed worker clear stays invalidated and reports its failure", async () => {
  const f = fixture();
  try {
    f.db.exec("CREATE TRIGGER refuse_retry_clear BEFORE DELETE ON retry_requests BEGIN SELECT RAISE(ABORT, 'Poseidon refuses clear'); END");
    await watchWriteSites(f.db, f.writer, ["retry_requests", "retry_receipts"]);
    f.save(); await f.catalog.settled!();
    f.catalog.clearRetryRequest!("ithaca");
    // Submit before the failed DELETE's reply, so refusal cannot depend on
    // an app-thread rejection handler racing the next worker procedure.
    // A reservation that tries to consume the obsolete row throws on the refused delete: record it as such.
    const reserved = await f.catalog.reserveRetry!("ithaca", "voyage", "failed-clear-retry", "athena")
      .catch((error: Error) => ({ receipt: { state: `consumed the obsolete request (${error.message})` }, request: undefined }));
    await f.catalog.settled!();
    expect(f.failures, "RETRY_FAILED_CLEAR_REPORTED").toEqual(["Poseidon refuses clear"]);
    expect(f.db.query("SELECT turn_id FROM retry_requests").get(), "RETRY_FAILED_CLEAR_LEFT_OBSOLETE_ROW").toEqual({ turn_id: "voyage" });
    expect(reserved.receipt.state, "RETRY_FAILED_CLEAR_FAILS_CLOSED").toBe("refused");
    expect(reserved.request, "RETRY_FAILED_CLEAR_NEVER_DISPATCHES").toBeUndefined();
    expect(f.catalog.peekRetry!("ithaca"), "RETRY_FAILED_CLEAR_STAYS_HIDDEN").toBeNull();
  } finally { await f.close(); }
});

test("dispatch waits for the reservation receipt and duplicate frames never dispatch twice", async () => {
  const f = fixture();
  let host: WsHost | undefined;
  const calls: string[] = [], receipts: string[] = [], early: string[] = [];
  try {
    await watchWriteSites(f.db, f.writer, ["retry_requests", "retry_receipts"]);
    f.save(); await f.catalog.settled!();
    const backend = makeFakeBackend({ id: "claude", async startTurn(turn) {
      calls.push(turn.prompt);
      if (f.catalog.retryReceipt!("ithaca", "retry-voyage", "athena").state !== "accepted") early.push("dispatched before its receipt committed");
      turn.bridge.emit({ type: "result", sessionId: "ithaca", numTurns: 1, durationMs: 1, isError: false });
    } });
    host = new WsHost({ catalog: f.catalog, registry: createStaticBackendRegistry([backend], "claude"), brainPath: f.brain });
    const ws = { send(raw: string) {
      const frame = JSON.parse(raw);
      if (frame.type === "retry_receipt") {
        if (f.catalog.retryReceipt!("ithaca", "retry-voyage", "athena").state !== "accepted") early.push("receipt sent before it committed");
        receipts.push(frame.state);
      }
    } };
    const connection = { authorization: testAuthorization("athena"), principal: testPrincipal("athena") };
    const frame = { type: "retry_turn" as const, sessionId: "ithaca", failedTurnId: "voyage", requestId: "retry-voyage" };
    // Hold the reservation itself after dispatch's initial settled read.
    const reserve = f.catalog.reserveRetry!;
    const held = f.writer.channel(probe, { table: "odysseus_log" }); await held.ready;
    let slow: Promise<unknown> | undefined;
    f.catalog.reserveRetry = (...args) => { slow ??= held.call("slow", "Calypso", 300); return reserve(...args); };
    const first = handleClientMessage(host, ws, frame, connection);
    await Bun.sleep(30);
    expect(calls, "RETRY_PENDING_RESERVATION_NO_DISPATCH").toEqual([]);
    expect(receipts, "RETRY_PENDING_RESERVATION_NO_ACK").toEqual([]);
    const duplicate = handleClientMessage(host, ws, frame, connection);
    await Promise.all([first, duplicate]); await slow;
    expect(early, "RETRY_COMMITTED_BEFORE_RECEIPT_AND_DISPATCH").toEqual([]);
    for (let i = 0; i < 200 && (host.coordinator.activeRuns() || host.coordinator.startingSessions); i++) await Bun.sleep(5);
    expect(calls, "RETRY_DUPLICATE_DISPATCHES_ONCE").toEqual([request.text]);
    expect(receipts, "RETRY_DUPLICATE_REPLAYS_COMMITTED_RECEIPT").toEqual(["accepted", "accepted"]);
    expect(f.failures).toEqual([]);
  } finally { host?.close(); await f.close(); }
});

test("proposal insertion and writing save commit before approval and policy publication", async () => {
  const f = fixture();
  try {
    const sites = await watchWriteSites(f.db, f.writer, ["policy_proposals"]);
    const approval = Promise.withResolvers<boolean>();
    let approvals = 0, publications = 0;
    let recoveredState: string | undefined;
    const states: string[] = [];
    const state = () => {
      const row = f.db.query("SELECT review FROM policy_proposals WHERE request_id='policy-voyage'").get() as { review: string } | null;
      return row ? JSON.parse(row.review).state : null;
    };
    const options = { root: f.brain, db: f.db, writer: f.writer, lock: createKeyedLock(),
      observeUserPolicy: (_turn: string, write: () => void) => {
        expect(state(), "POLICY_WRITING_COMMITTED_BEFORE_FILE_WRITE").toBe("writing");
        const restarted = createPolicyProposals({ root: f.brain, db: f.db, lock: createKeyedLock(), observeUserPolicy() {}, recordEvent() {} });
        recoveredState = restarted.read("athena", "voyage", "policy-voyage")?.state;
        publications++; write();
      }, recordEvent() {} };
    const proposals = createPolicyProposals(options);
    const turn: PolicyProposalTurn = { principalId: "athena", turnId: "voyage", sessionId: () => "ithaca", signal: new AbortController().signal,
      isAuthorized: () => true, isAvailable: () => true,
      approve: () => { expect(state(), "POLICY_INSERT_COMMITTED_BEFORE_APPROVAL").toBe("pending"); approvals++; return approval.promise; },
      emit: review => { expect(state(), "POLICY_REVIEW_EMITTED_AFTER_COMMIT").toBe(review.state); states.push(review.state); } };
    const held = f.writer.channel(probe, { table: "odysseus_log" }); await held.ready;
    const insertSlow = held.call("slow", "Calypso", 300);
    const result = proposals.propose(turn, "policy-voyage", input);
    const duplicate = proposals.propose(turn, "policy-voyage", input);
    expect(state(), "POLICY_INSERT_QUEUED_OFF_LOOP").toBeNull();
    expect(approvals, "POLICY_PENDING_INSERT_NO_APPROVAL").toBe(0);
    await insertSlow; await proposals.settled();
    expect(approvals, "POLICY_PENDING_INSERT_DUPLICATE_APPROVES_ONCE").toBe(1);
    expect(proposals.read("athena", "voyage", "policy-voyage", "ithaca")?.state, "POLICY_READ_AFTER_INSERT_SETTLED").toBe("pending");
    const writingSlow = held.call("slow", "Circe", 300);
    approval.resolve(true);
    await Bun.sleep(30);
    expect(state(), "POLICY_WRITING_SAVE_STILL_QUEUED").toBe("pending");
    expect(readFileSync(f.path, "utf8"), "POLICY_FILE_UNTOUCHED_BEFORE_WRITING_COMMIT").toBe(original);
    expect(publications).toBe(0);
    await writingSlow;
    expect((await result).state, "POLICY_FINAL_SAVE_WORKER_FULL").toBe("updated");
    expect(await duplicate).toEqual(await result);
    await proposals.settled();
    expect(readFileSync(f.path, "utf8")).toBe(proposed);
    expect(states).toEqual(["writing", "updated"]);
    expect(publications).toBe(1);
    expect(recoveredState, "POLICY_RESTART_WRITING_IS_UNKNOWN").toBe("unknown");
    expect(await sites.log(), "POLICY_INSERT_WRITING_FINAL_COMMIT_ORDER").toEqual(["policy_proposals", "policy_proposals", "policy_proposals"]);
    const history: SessionHistoryMessage[] = [{ role: "assistant", content: "Athena reviews the policy.", turnId: "voyage", toolCalls: [{ id: "policy-voyage", name: "propose_policy_change", input: {} }] }];
    expect(proposals.attachHistory("ithaca", history)[0]?.toolCalls[0]?.policyChange?.state, "POLICY_HISTORY_AFTER_SETTLED").toBe("updated");
  } finally { await f.close(); }
});

test("a refused writing save never publishes policy bytes", async () => {
  const f = fixture();
  try {
    f.db.exec("CREATE TRIGGER refuse_policy_writing BEFORE UPDATE ON policy_proposals WHEN json_extract(NEW.review, '$.state') = 'writing' BEGIN SELECT RAISE(ABORT, 'Poseidon refuses writing'); END");
    await watchWriteSites(f.db, f.writer, ["policy_proposals"]);
    let publications = 0;
    const proposals = createPolicyProposals({ root: f.brain, db: f.db, writer: f.writer, lock: createKeyedLock(),
      observeUserPolicy: (_turn, write) => { publications++; write(); }, recordEvent() {} });
    const turn: PolicyProposalTurn = { principalId: "athena", turnId: "voyage", sessionId: () => "ithaca", signal: new AbortController().signal,
      isAuthorized: () => true, isAvailable: () => true, approve: async () => true, emit() {} };
    expect((await proposals.propose(turn, "policy-voyage", input)).state, "POLICY_FAILED_WRITING_SAVE_REFUSES").toBe("refused");
    expect(publications, "POLICY_FAILED_WRITING_SAVE_NO_PUBLICATION").toBe(0);
    expect(readFileSync(f.path, "utf8")).toBe(original);
  } finally { await f.close(); }
});

test("after a restart, a retry whose clear failed still refuses once a later input was accepted", async () => {
  const f = fixture();
  try {
    const at = Date.parse("2026-07-12T00:00:00Z");
    // The failed turn was the session's latest dispatched work.
    f.db.query("INSERT INTO session_work (session_id, revision, request_id, turn_id, backend_id, accepted_at, started_at) VALUES ('ithaca', 1, 'first', 'voyage', 'claude', ?, ?)").run(at, at);
    f.save(); await f.catalog.settled!();
    f.db.exec("CREATE TRIGGER refuse_retry_clear BEFORE DELETE ON retry_requests BEGIN SELECT RAISE(ABORT, 'Poseidon refuses clear'); END");
    f.catalog.clearRetryRequest!("ithaca");
    f.catalog.acceptWork!("ithaca", "later", "claude", () => {});
    await f.catalog.settled!();
    expect(f.db.query("SELECT turn_id FROM retry_requests").get(), "RETRY_RESTART_OBSOLETE_ROW_LEFT").toEqual({ turn_id: "voyage" });
    // The disk recovers, and a restart forgets every in-process invalidation.
    f.db.exec("DROP TRIGGER refuse_retry_clear");
    const writer = openSqliteWriter(f.db);
    const log = { emit() {} } as unknown as Logger;
    const restarted = createSessionCatalog(() => f.db, log, undefined, { pricing: { resolve: () => null }, store: createActivityStore(f.db, { writer: "odysseus" }), writer });
    try {
      const reserved = await restarted.reserveRetry!("ithaca", "voyage", "after-restart", "athena");
      expect(reserved.receipt.state, "RETRY_RESTART_SUPERSEDED_FAILS_CLOSED").toBe("refused");
      expect(reserved.request).toBeUndefined();
    } finally { await restarted.settled!(); await writer.close(); }
  } finally { await f.close(); }
});
