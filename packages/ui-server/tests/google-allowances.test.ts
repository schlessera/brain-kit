import { beginSafetyCollection, safetyCatalogCreated, bindSafetyCollection, acknowledgeSafety, endSafetyCollection,
  latchSafety, recoverSafetyRecording, reserveSafetyWrite, releaseSafetyWrite, safetyProjection } from "../src/governance/safety-store.js";
import { createGovernanceWrites } from "../src/governance/event-writes.js";
import { expectRejection } from "./helpers/expect-rejection.js";
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { createUiDb } from "../src/db/client.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import { createPrincipal, revokePrincipal } from "../src/db/principals.js";
import { createGoogleAllowances, type GoogleAllowanceContext } from "../src/google/allowances.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => { for (const close of cleanups.splice(0).reverse()) await close(); });
function fixture() {
  mkdirSync(resolve("tmp"), { recursive: true });
  const root = mkdtempSync(resolve("tmp/google-allowance-")), db = createUiDb(resolve(root, "ui.db"));
  let writer: ReturnType<typeof openSqliteWriter>;
  cleanups.push(async () => { await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); });
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  db.query("INSERT INTO sessions(id,created_at,last_active_at) VALUES('ithaca',1,1),('aeaea',1,1)").run();
  const c: GoogleAllowanceContext = { sessionId: "ithaca", principalId: principal.id, brainId: "brain", accountIdentity: "odysseus@example.com",
    hostEpoch: "epoch", policyHash: "policy", now: Date.now(), tainted: true, authorized: true };
  writer = openSqliteWriter(db);
  return { db, writer, principal, c, store: createGoogleAllowances(db, writer) };
}
test("Google writer reserves one shared 100-item budget for a multi-entity card", async () => {
  const { store, c } = fixture();
  await store.grant(c, "gmail.modify", ["archive", "label:STARRED"], "card");
  await store.reserve(c, "gmail.modify", ["archive"], 60);
  expect(store.read(c).map(row => row.remaining_items), "GOOGLE_SHARED_CARD_CEILING").toEqual([40, 40]);
  await expectRejection(store.reserve(c, "gmail.modify", ["label:STARRED"], 41), "exhausted");
  await store.reserve(c, "gmail.modify", ["label:STARRED"], 40);
  expect(store.read(c).map(row => row.remaining_items)).toEqual([0, 0]);
});
test("Google writer rejects a partial reservation atomically and never crosses scope", async () => {
  const { store, c } = fixture(); await store.grant(c, "gmail.modify", ["archive"], "card");
  await expectRejection(store.reserve(c, "gmail.modify", ["archive", "label:STARRED"], 10));
  expect(store.read(c)[0]!.remaining_items).toBe(100);
  for (const field of ["sessionId", "principalId", "brainId", "accountIdentity", "hostEpoch", "policyHash"] as const)
    expect(store.read({ ...c, [field]: "aeaea" }), "GOOGLE_ALLOWANCE_SCOPE").toHaveLength(0);
  await store.reconcile({ ...c, policyHash: "new-policy" });
  expect(store.read(c), "GOOGLE_OLD_POLICY_NEVER_REVIVES").toEqual([]);
});
test("Google principal revocation deletes allowances while another principal remains usable", async () => {
  const { store, c, db, principal } = fixture();
  const other = createPrincipal(db, { authMethod: "password", label: "Penelope", ttlSeconds: 3600 });
  await store.grant(c, "gmail.modify", ["archive"], "card");
  await store.grant({ ...c, principalId: other.id }, "gmail.modify", ["archive"], "other-card");
  revokePrincipal(db, principal.id, Date.now());
  expect(store.read(c), "GOOGLE_PRINCIPAL_REVOKE_VOID").toEqual([]);
  expect(store.read({ ...c, principalId: other.id })).toHaveLength(1);
});

test("Google allowance writer rechecks principal after a queued grant's authority was lost", async () => {
  const { store, c, db, principal } = fixture();
  revokePrincipal(db, principal.id, Date.now());
  await expectRejection(store.grant(c, "gmail.modify", ["archive"], "stale-card"), "current tainted owner authority", "GOOGLE_GRANT_COMMIT_AUTHORITY");
  expect(store.read(c)).toEqual([]);
});

test("Google policy hash invalidation happens on an unrelated turn and cannot revive", async () => {
  const { store, c, db, writer } = fixture();
  c.policyHash = "a".repeat(64);
  await store.grant(c, "gmail.modify", ["archive"], "card");
  const writes = createGovernanceWrites(db, writer);
  await writes.safetyBegin({ turnId: "aeaea-new-policy", bindingId: "aeaea-new-policy", sessionId: null,
    principalId: c.principalId, backendId: "claude", at: Date.now(), policyHash: "b".repeat(64) });
  expect(store.read(c), "GOOGLE_OTHER_TURN_POLICY_VOIDS").toEqual([]);
  await writes.safetyBegin({ turnId: "aeaea-old-policy", bindingId: "aeaea-old-policy", sessionId: null,
    principalId: c.principalId, backendId: "claude", at: Date.now(), policyHash: "a".repeat(64) });
  expect(store.read(c), "GOOGLE_POLICY_RESTORE_NO_REVIVAL").toEqual([]);
});

test("Google allowance reservation never borrows another operation's grant", async () => {
  const { store, c } = fixture(); await store.grant(c, "gmail.modify", ["archive"], "card");
  await expectRejection(store.reserve(c, "gmail.draft.save", ["archive"], 1), "expired, revoked or exhausted", "GOOGLE_ALLOWANCE_OPERATION_BOUND");
  expect(store.read(c)[0]!.remaining_items).toBe(100);
});


test("Google null policy collection invalidates only its own session", async () => {
  const { store, c, db, writer } = fixture();
  await store.grant(c, "gmail.modify", ["archive"], "card");
  await store.grant({ ...c, sessionId: "aeaea" }, "gmail.modify", ["archive"], "other-card");
  await createGovernanceWrites(db, writer).safetyBegin({ turnId: "aeaea-unknown", bindingId: "aeaea-unknown", sessionId: "aeaea",
    principalId: c.principalId, backendId: "claude", at: Date.now(), policyHash: null });
  expect(store.read(c), "GOOGLE_NULL_POLICY_OTHER_SESSION").toHaveLength(1);
  expect(store.read({ ...c, sessionId: "aeaea" }), "GOOGLE_NULL_POLICY_OWN_SESSION").toEqual([]);
});
test("Google allowance store does not expose rows outside restricted authority", async () => {
  const { store, c } = fixture(); await store.grant(c, "gmail.modify", ["archive"], "card");
  expect(store.read({ ...c, tainted: false }), "GOOGLE_ALLOWANCE_READ_TAINT_GUARD").toEqual([]);
  expect(store.read({ ...c, authorized: false })).toEqual([]);
});
for (const transition of ["latch recovery", "reservation release"]) test(`Google restriction continuity survives ${transition} without a Google observer`, async () => {
  const { store, c, db } = fixture();
  beginSafetyCollection(db, { turnId: "normal-ithaca", bindingId: "normal-ithaca", sessionId: null,
    principalId: c.principalId, backendId: "claude", at: Date.now(), policyHash: "a".repeat(64) });
  safetyCatalogCreated(db, "ithaca", c.principalId, "normal-ithaca");
  bindSafetyCollection(db, "normal-ithaca", "ithaca");
  acknowledgeSafety(db, "normal-ithaca", "claude", 1);
  expect(safetyProjection(db, null, "ithaca").restriction).toBe("normal");
  if (transition === "latch recovery") {
    endSafetyCollection(db, "normal-ithaca");
    latchSafety(db, null, "recording_failed");
  } else reserveSafetyWrite(db, "normal-ithaca", "pending-ithaca", 100);
  expect(safetyProjection(db, null, "ithaca").restriction).toBe("restricted");
  await store.grant(c, "gmail.modify", ["archive"], "card");
  if (transition === "latch recovery") recoverSafetyRecording(db);
  else releaseSafetyWrite(db, "pending-ithaca");
  expect(safetyProjection(db, null, "ithaca").restriction, "GOOGLE_NORMAL_INTERVAL").toBe("normal");
  // Re-restrict before any allowance read/reconcile.
  if (transition === "latch recovery") latchSafety(db, null, "recording_failed");
  else reserveSafetyWrite(db, "normal-ithaca", "new-pending-ithaca", 100);
  expect(store.read(c), "GOOGLE_RESTRICTION_NO_REVIVAL").toEqual([]);
});
