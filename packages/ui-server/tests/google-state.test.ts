import { afterEach, expect, test } from "bun:test";
import { expectRejection } from "./helpers/expect-rejection.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import { createGoogleStateWrites, type GoogleDecisionEvent, type GoogleInversePrepared } from "../src/google/state-writes.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0)) await close(); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "google-state-"));
  const db = createUiDb(join(root, "ui.db")), writer = openSqliteWriter(db);
  for (const id of ["ithaca", "aeaea"]) db.query("INSERT INTO sessions(id,created_at,last_active_at) VALUES (?,1,1)").run(id);
  const state = createGoogleStateWrites(db, writer);
  cleanups.push(async () => { await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const now = Date.now();
  const lock = { sessionId: "ithaca", cardId: "card", turnId: "turn", principalId: "odysseus", brainId: "brain", account: "mail",
    draftId: "r123", hostEpoch: "epoch", createdAt: now, expiresAt: now + 60_000 };
  const inverse: GoogleInversePrepared = { sessionId: "ithaca", inverseId: "inverse", callId: "call", turnId: "turn", principalId: "odysseus",
    brainId: "brain", accountIdentity: "resolved-ithaca", operation: "gmail.draft.save", inverse: { action: "delete_created" },
    precondition: { absent: true }, snapshot: new Uint8Array([1, 2, 3]), createdAt: now, expiresAt: now + 60_000 };
  const event: GoogleDecisionEvent = { kind: "google_reversible_action", sessionId: "ithaca", turnId: "turn", actor: "interactive", model: null, profile: "governed",
    payload: { callId: "call", tool: "gmail_draft", operation: "gmail.draft.save", effect: "reversible", target: null,
      tainted: false, decision: "approved", admission: null, inverseId: "inverse" } };
  return { db, state, lock, inverse, event, now };
}
test("google send locks are unique across sessions and release matches the owning card", async () => {
  const { db, state, lock } = fixture();
  expect(await state.acquireSendLock(lock)).toBe("acquired");
  expect(await state.acquireSendLock({ ...lock, sessionId: "aeaea", cardId: "other" })).toBe("draft_locked");
  await state.releaseSendLock("aeaea", "card");
  expect(db.query("SELECT COUNT(*) AS n FROM google_send_locks").get()).toEqual({ n: 1 });
  await state.releaseSendLock("ithaca", "card");
  expect(await state.acquireSendLock({ ...lock, cardId: "new" })).toBe("acquired");
  await state.releaseSendLock("ithaca", "card");
  expect(db.query("SELECT card_id FROM google_send_locks").get()).toEqual({ card_id: "new" });
});
test("google card cleanup still works after its chat is retired, and withdraws only prepared inverses", async () => {
  const { db, state, lock, event, inverse } = fixture();
  expect(await state.acquireSendLock(lock)).toBe("acquired");
  await state.commitGoogleDecision(event, inverse);
  await state.commitGoogleDecision({ ...event, payload: { ...event.payload, callId: "kept", inverseId: "kept" } },
    { ...inverse, callId: "kept", inverseId: "kept" });
  await state.confirmInverse("ithaca", "kept", { id: "r123", fingerprint: "a".repeat(64) });
  db.query("INSERT INTO chat_lifecycles(id,kind,principal_id,backend_id,generation,operation_id,retired_at) VALUES ('retired','session','odysseus',NULL,2,'op',1)").run();
  db.query("INSERT INTO chat_retired_identities(kind,id,lifecycle_id) VALUES ('session','ithaca','retired')").run();
  await state.releaseSendLock("ithaca", "card");
  expect(db.query("SELECT COUNT(*) AS n FROM google_send_locks").get(), "GOOGLE_RETIRED_CARD_RELEASES").toEqual({ n: 0 });
  expect(await state.withdrawInverse("ithaca", "inverse"), "GOOGLE_PREPARED_WITHDRAWN").toBe(1);
  expect(await state.withdrawInverse("ithaca", "kept"), "GOOGLE_CONFIRMED_KEPT").toBe(0);
  expect(db.query("SELECT inverse_id,state FROM google_inverses").all()).toEqual([{ inverse_id: "kept", state: "confirmed" }]);
});
test("google send locks replace stale epochs and expired rows and clear at host start", async () => {
  const { db, state, lock } = fixture();
  await state.acquireSendLock(lock);
  expect(await state.acquireSendLock({ ...lock, sessionId: "aeaea", cardId: "next", hostEpoch: "new-epoch" })).toBe("acquired");
  db.query("UPDATE google_send_locks SET created_at=1,expires_at=2").run();
  expect(await state.acquireSendLock({ ...lock, hostEpoch: "new-epoch" })).toBe("acquired");
  await state.clearSendLocksAtHostStart();
  expect(db.query("SELECT COUNT(*) AS n FROM google_send_locks").get()).toEqual({ n: 0 });
});
for (const failing of ["governance_events", "google_inverses"]) test(`google decision atomically rolls back when ${failing} insert fails`, async () => {
  const { db, state, event, inverse } = fixture();
  db.exec(`CREATE TRIGGER fail_insert BEFORE INSERT ON ${failing} BEGIN SELECT RAISE(ABORT,'injected insert failure'); END`);
  await expectRejection(state.commitGoogleDecision(event, inverse), "injected insert failure");
  expect(db.query("SELECT COUNT(*) AS n FROM google_inverses").get(), "NO_ORPHAN_INVERSE").toEqual({ n: 0 });
  expect(db.query("SELECT COUNT(*) AS n FROM governance_events").get(), "NO_ORPHAN_DECISION").toEqual({ n: 0 });
});
test("google prepared inverse commits with its receipt then confirms, becomes unknown and expires", async () => {
  const { db, state, event, inverse } = fixture();
  const receipt = await state.commitGoogleDecision(event, inverse);
  expect(receipt.inverseId).toBe("inverse");
  expect(db.query("SELECT decision_event_id,state FROM google_inverses").get()).toEqual({ decision_event_id: receipt.eventId, state: "prepared" });
  await state.confirmInverse("ithaca", "inverse", { id: "r123", fingerprint: "a".repeat(64) });
  expect(db.query("SELECT state,json_extract(inverse_json,'$.result.id') AS id FROM google_inverses").get()).toEqual({ state: "confirmed", id: "r123" });
  await state.markInverseUnknown("ithaca", "inverse");
  await expectRejection(state.confirmInverse("ithaca", "inverse", { id: "r123", fingerprint: "a".repeat(64) }), "Google inverse is not prepared and live");
  expect(await state.pruneExpiredInverses(inverse.expiresAt - 1)).toBe(0);
  expect(await state.pruneExpiredInverses(inverse.expiresAt)).toBe(1);
  expect(db.query("SELECT COUNT(*) AS n FROM governance_events").get()).toEqual({ n: 1 });
});
test("google decision rejects mismatched inverse attribution without any receipt", async () => {
  const { db, state, event, inverse } = fixture();
  await expectRejection(state.commitGoogleDecision(event, { ...inverse, sessionId: "aeaea" }), "attribution mismatch");
  await expectRejection(state.commitGoogleDecision(event, null), "inverse mismatch");
  expect(db.query("SELECT COUNT(*) AS n FROM governance_events").get()).toEqual({ n: 0 });
});

test("google duplicate decision is refused without changing its committed inverse", async () => {
  const { db, state, event, inverse } = fixture();
  const once = { ...event, dedupeKey: "google-call" };
  const receipt = await state.commitGoogleDecision(once, inverse);
  await expectRejection(state.commitGoogleDecision(once, inverse), "Google decision already committed");
  expect(db.query("SELECT id FROM governance_events").all()).toEqual([{ id: receipt.eventId }]);
  expect(db.query("SELECT inverse_id,state,decision_event_id FROM google_inverses").all())
    .toEqual([{ inverse_id: "inverse", state: "prepared", decision_event_id: receipt.eventId }]);
});
test("google state refuses missing sessions and expired incoming locks without claiming another draft", async () => {
  const { db, state, lock, now } = fixture();
  await expectRejection(state.acquireSendLock({ ...lock, sessionId: "missing" }), "Google state requires a persisted session");
  await expectRejection(state.acquireSendLock({ ...lock, createdAt: now - 2000, expiresAt: now - 1000 }), "Google send lock already expired");
  expect(db.query("SELECT COUNT(*) AS n FROM google_send_locks").get()).toEqual({ n: 0 });
  expect(await state.acquireSendLock(lock)).toBe("acquired");
});

for (const kind of ["other_operation", "declined", "refused"] as const) test(`google inverse gate refuses outward ${kind}`, async () => {
  const f = fixture();
  const operation = kind === "other_operation" ? "gmail.draft.delete" as const : "gmail.draft.save" as const;
  const event: GoogleDecisionEvent = { kind: "outward_action", sessionId: "ithaca", turnId: "turn", actor: "interactive", model: null, profile: null,
    payload: { tool: "gmail_draft", action: "google_write", input: "{}", inputTruncated: false, target: null, historyRewrite: false, tainted: false,
      decision: kind === "other_operation" ? "approved" : kind, rule: null, google: { callId: "call", operation, effect: "irreversible" } } };
  await expect(f.state.commitGoogleDecision(event, { ...f.inverse, operation }), `INVERSE_GATE_${kind.toUpperCase()}`).rejects.toThrow("inverse mismatch");
  expect(f.db.query("SELECT * FROM google_inverses").all()).toEqual([]);
  expect(f.db.query("SELECT * FROM governance_events").all()).toEqual([]);
});
