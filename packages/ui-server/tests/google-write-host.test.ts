import { Hono } from "hono";
import { createGoogleApprovalRoutes } from "../src/routes/google-approvals.js";
import type { AppEnv } from "../src/app-env.js";
import { createPrincipal, type Principal } from "../src/db/principals.js";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { openGoogleLedger } from "@schlessera/brain-common/internal/google-ledger";
import { createGoogleAllowances } from "../src/google/allowances.js";
import { watchdogMs } from "../../../scripts/test-deadlines.js";
import { afterEach, expect, test } from "bun:test";
import { createUiDb } from "../src/db/client.js";
import { createGoogleStateWrites, isDraftSendLocked } from "../src/google/state-writes.js";
import { createGoogleToolsHost, type GoogleToolsTurn } from "../src/google/host.js";
import type { PreparedGoogleWrite } from "../src/google/write-engine.js";
import type { GoogleToolCall } from "@schlessera/brain-ui-sdk/tool-contracts";
import type { PermissionDecision, PermissionRequest } from "@schlessera/brain-ui-sdk/server";
import { GOOGLE_CARD, GOOGLE_MODIFY, GOOGLE_SEND, GOOGLE_SAFETY, googleModifyPrepared, googleSendPrepared, googlePolicy } from "./helpers/google-write-fixture.js";
import { GOOGLE_APPROVAL_CARD_BYTES, type GoogleMailApproval } from "@schlessera/brain-ui-sdk/tool-contracts";
import { MAX_WS_MESSAGE_BYTES, jsonBytes, shrinkForReplication } from "../src/ws/shrink.js";
import { initializeGoogleWrites } from "../src/google/startup.js";
import { createEffectiveSafety } from "../src/governance/effective-safety.js";
import { acknowledgeSafety, beginSafetyCollection, bindSafetyCollection, endSafetyCollection, latchSafety, recoverSafetyRecording,
  releaseSafetyWrite, reserveSafetyWrite, safetyCatalogCreated, safetyProjection } from "../src/governance/safety-store.js";

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(mode: "ask" | "allow" = "ask", limit?: number) {
  const db = createUiDb(":memory:"); cleanup.push(() => db.close());
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  db.query("UPDATE principals SET id='odysseus' WHERE id=?").run(principal.id);
  for (const id of ["ithaca", "aeaea"]) db.query("INSERT INTO sessions(id,created_at,last_active_at) VALUES (?,1,1)").run(id);
  mkdirSync(resolve("tmp"), { recursive: true });
  const root = mkdtempSync(resolve("tmp/google-approvals-")), ledger = openGoogleLedger(resolve(root, "approvals.db"));
  cleanup.push(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const allowances = createGoogleAllowances(db);
  let identity = "odysseus@example.com", clock = Date.now(), epoch = "ithaca-epoch";
  const state = createGoogleStateWrites(db), controller = new AbortController();
  let policy = googlePolicy(mode), safety = { ...GOOGLE_SAFETY }, current = true, owner = true, tainted = false;
  let dispatched = 0, prepares = 0, routing: "recipient_restricted" | null = null;
  let prepare: (call: GoogleToolCall) => Promise<PreparedGoogleWrite> = async call => {
    prepares++;
    return call.tool === "brain_google_gmail_send" ? googleSendPrepared(call, () => dispatched++) : googleModifyPrepared(call, () => dispatched++);
  };
  const cards: PermissionRequest[] = [];
  let answer: (card: PermissionRequest) => Promise<PermissionDecision> = async () => ({ behavior: "allow" });
  const turn: GoogleToolsTurn = { turnId: "turn-ithaca", principalId: "odysseus", sessionId: () => "ithaca", posture: "interactive",
    policy: () => frozen, routing: async () => routing, tainted: () => tainted,
    write: { signal: controller.signal, toolName: name => name, isCurrent: () => current, safety: () => safety,
      routingNow: () => routing ?? "allowed", record: (...args) => state.commitGoogleDecision(...args), requestPermission: async card => { cards.push(card); return answer(card); } } };
  if (limit !== undefined) policy = { ...policy, limits: { ...policy.limits, reversible_per_turn: limit } };
  const frozen = structuredClone(policy);
  safety = { ...safety, policyHash: JSON.stringify(policy) };
  const host = createGoogleToolsHost({ credential: { transport: () => { throw new Error("No Google binary in write tests"); } },
    principal: () => owner ? "owner" : "not_owner", untrusted: async () => {},
    audit: async (scope, event) => { if (!event.standingFailures?.length) return; const { insertGovernanceEvent, governanceEventRow } = await import("../src/governance/events.js");
      insertGovernanceEvent(db, governanceEventRow({ kind: "google_call", payload: event, ...scope, model: null, profile: null })); }, now: () => clock,
    writes: { brainId: "brain", hostEpoch: epoch, ledger: () => ledger, allowances, resolveAccount: async () => ({ ok: true, value: identity }), currentPolicyHash: () => JSON.stringify(policy), state, ready: () => true, currentPolicy: () => policy,
      isDraftLocked: (account, draft, epoch, at) => isDraftSendLocked(db, "brain", account, draft, epoch, at),
      preparedWrites: { "gmail.modify": (_, call) => prepare(call), "gmail.draft.send": (_, call) => prepare(call),
        "gmail.draft.save": (_, call) => prepare(call), "gmail.draft.delete": (_, call) => prepare(call) } } });
  cleanup.unshift(() => host.close?.());
  return { db, state, ledger, allowances, turn, host, controller, cards,
    setPolicy: (next: typeof policy) => { policy = next; safety = { ...safety, policyHash: JSON.stringify(next) }; },
    identity: (next: string) => { identity = next; }, clock: (next: number) => { clock = next; }, now: () => clock,
    tainted: (next: boolean) => { tainted = next; }, owner: (next: boolean) => { owner = next; }, dispatched: () => dispatched, prepares: () => prepares,
    answer: (fn: typeof answer) => { answer = fn; }, prepare: (fn: typeof prepare) => { prepare = fn; },
    change: (kind: string) => { if (kind === "authority") current = false; if (kind === "policy") policy = googlePolicy(mode === "ask" ? "allow" : "ask");
      if (kind === "safety") safety = { ...safety, recordingAvailable: false }; if (kind === "taint") tainted = true;
      if (kind === "routing") routing = "recipient_restricted"; if (kind === "owner") owner = false;
      if (kind === "evidenceRevision" || kind === "trustRevision") safety = { ...safety, [kind]: "1" }; if (kind === "restricted") safety = { ...safety, restricted: true }; },
    call: (call = GOOGLE_MODIFY, context = turn) => host.call(context, call) };
}

test("google remembers an unedited always answer for the next reversible call", async () => {
  const f = fixture(); f.answer(async () => ({ behavior: "allow", always: true }));
  expect(await f.call(), "GOOGLE_ALWAYS_GRANTS").toMatchObject({ ok: true, admission: "card" });
  expect(await f.call(), "GOOGLE_REMEMBERED_NEXT_CALL").toMatchObject({ ok: true, admission: "remembered_approval" });
  expect(f.cards).toHaveLength(1);
});

test("google exact card commits decision and inverse before one dispatch and confirms inverse", async () => {
  const f = fixture();
  f.prepare(async call => googleModifyPrepared(call, () => {
    expect(f.db.query("SELECT state FROM google_inverses").get(), "GOOGLE_INVERSE_COMMITTED_BEFORE_DISPATCH").toEqual({ state: "prepared" });
    expect(f.db.query("SELECT kind FROM governance_events").get(), "GOOGLE_DECISION_COMMITTED_BEFORE_DISPATCH").toEqual({ kind: "google_reversible_action" });
  }));
  const result = await f.call();
  expect(result).toMatchObject({ ok: true, admission: "card", operation: "gmail.modify", result: GOOGLE_CARD.payload });
  expect(f.cards.map(card => card.input)).toEqual([{ ...GOOGLE_CARD, offers: { allow_always: true, allow_for_session: false } }]);
  expect(f.db.query("SELECT state FROM google_inverses").get()).toEqual({ state: "confirmed" });
});

test("google awaits the decision transaction and invokes exactly once", async () => {
  const f = fixture(), started = deferred<void>(), release = deferred<void>();
  const original = f.state.commitGoogleDecision;
  f.state.commitGoogleDecision = async (...args) => { started.resolve(); await release.promise; return original(...args); };
  const result = f.call(); await started.promise;
  const whilePending = f.dispatched();
  release.resolve();
  expect(whilePending, "GOOGLE_NO_DISPATCH_WHILE_RECORD_PENDING").toBe(0);
  expect(await result).toMatchObject({ ok: true });
  expect(f.dispatched(), "GOOGLE_SINGLE_DISPATCH").toBe(1);
});
for (const table of ["governance_events", "google_inverses"]) test(`google ${table} failure refuses with no dispatch`, async () => {
  const f = fixture();
  f.db.exec(`CREATE TRIGGER fail_google BEFORE INSERT ON ${table} BEGIN SELECT RAISE(ABORT,'injected failure'); END`);
  const answer = await f.call();
  expect(f.dispatched(), "GOOGLE_RECORD_FAILURE_ZERO_DISPATCH").toBe(0);
  expect(answer, "GOOGLE_RECORD_FAILURE_REFUSES").toMatchObject({ ok: false, error: { reason: "recording_unavailable" } });
  expect(f.db.query("SELECT COUNT(*) n FROM google_inverses").get()).toEqual({ n: 0 });
});
for (const choice of [{ forSession: true }, { always: true, forSession: true }]) test(`google unavailable standing answer ${JSON.stringify(choice)} is declined`, async () => {
  const f = fixture(); f.answer(async () => ({ behavior: "allow", ...choice }));
  expect(await f.call()).toMatchObject({ ok: false, error: { reason: "standing_choice_unavailable" } });
  expect(f.dispatched()).toBe(0);
  expect(f.db.query("SELECT json_extract(payload,'$.decision') decision FROM governance_events").get()).toEqual({ decision: "declined" });
});
test("google canonical echo allows but edited input refuses", async () => {
  const f = fixture(); f.answer(async card => ({ behavior: "allow", updatedInput: { ...card.input, tainted: true } }));
  expect(await f.call(), "GOOGLE_EDITED_APPROVAL_REFUSED").toMatchObject({ ok: false, error: { reason: "edited" } });
  expect(f.dispatched()).toBe(0);
  f.answer(async card => ({ behavior: "allow", updatedInput: Object.fromEntries(Object.entries(card.input).reverse()) }));
  expect(await f.call()).toMatchObject({ ok: true }); expect(f.dispatched()).toBe(1);
});
test("google voice refuses before showing a needed card and policy admission runs in voice", async () => {
  const f = fixture();
  expect(await f.call(GOOGLE_MODIFY, { ...f.turn, posture: "voice" })).toMatchObject({ ok: false, error: { reason: "voice_posture" } });
  expect(f.cards, "GOOGLE_VOICE_NO_CARD").toHaveLength(0); expect(f.dispatched()).toBe(0);
  const allowed = fixture("allow");
  expect(await allowed.call(GOOGLE_MODIFY, { ...allowed.turn, posture: "voice" })).toMatchObject({ ok: true, admission: "policy" });
  expect(allowed.cards).toHaveLength(0); expect(allowed.dispatched()).toBe(1);
});
test("google non-owner refuses before any preparation", async () => {
  const f = fixture(); f.change("owner");
  expect(await f.call()).toMatchObject({ ok: false, error: { reason: "not_owner" } });
  expect(f.prepares()).toBe(0); expect(f.cards).toHaveLength(0); expect(f.dispatched()).toBe(0);
});
for (const kind of ["authority", "policy", "safety"]) test(`google ${kind} change during card refuses post-card dispatch`, async () => {
  const f = fixture(); f.answer(async () => { f.change(kind); return { behavior: "allow" }; });
  expect(await f.call(), "GOOGLE_POST_CARD_LIVE_REFUSAL").toMatchObject({ ok: false, error: { reason: kind === "authority" ? "cancelled" : kind === "policy" ? "policy_changed" : "safety_changed" } });
  expect(f.dispatched(), "GOOGLE_POST_CARD_ZERO_DISPATCH").toBe(0);
  expect(f.prepares(), "GOOGLE_POST_CARD_NO_STALE_PREREAD").toBe(1);
});
for (const kind of ["authority", "policy", "safety", "taint", "routing"]) test(`google ${kind} change at final admission refuses card-less dispatch`, async () => {
  const f = fixture("allow");
  f.prepare(async call => { const p = googleModifyPrepared(call, () => { throw new Error("must not dispatch"); });
    const execute = p.execute; p.execute = async check => { f.change(kind); return execute(check); }; return p; });
  expect(await f.call(), "GOOGLE_FINAL_ADMISSION_REFUSAL").toMatchObject({ ok: false });
  // The admission was recorded before execute; the refusal follows it, and the never-dispatched inverse is withdrawn.
  expect((f.db.query("SELECT json_extract(payload,'$.decision') AS decision FROM governance_events ORDER BY id").all() as { decision: string }[])
    .map(row => row.decision), "GOOGLE_REFUSAL_FOLLOWS_ADMISSION").toEqual(["allowed", "refused"]);
  expect(f.db.query("SELECT COUNT(*) AS n FROM google_inverses").get(), "GOOGLE_UNDISPATCHED_INVERSE_WITHDRAWN").toEqual({ n: 0 });
});
for (const kind of ["authority", "policy", "safety"]) test(`google ${kind} change while waiting for account lock refuses`, async () => {
  const f = fixture("allow"), entered = deferred<void>(), release = deferred<void>();
  let executions = 0, prepares = 0;
  f.prepare(async call => { prepares++; const p = googleModifyPrepared(call); p.execute = async final => {
    const error = final(); if (error) return { ok: false, error }; executions++; entered.resolve(); await release.promise;
    return { ok: true, result: GOOGLE_CARD.payload };
  }; return p; });
  const first = f.call(); await entered.promise;
  const second = f.call(); f.change(kind); release.resolve();
  await first; expect(await second).toMatchObject({ ok: false }); expect(executions).toBe(1);
  expect(prepares, "GOOGLE_LOCK_WAIT_NO_STALE_PREREAD").toBe(1);
});
test("google card-less unknown outcome dispatches once, marks its inverse unknown, and a later routing change refuses", async () => {
  const f = fixture("allow"); let invocations = 0;
  f.prepare(async call => { const p = googleModifyPrepared(call); p.execute = async check => {
    const error = check(); if (error) return { ok: false, error }; invocations++; throw new Error("timeout");
  }; return p; });
  expect(await f.call()).toMatchObject({ ok: false, error: { code: "outcome_unknown" } });
  expect(invocations, "GOOGLE_UNKNOWN_ONE_DISPATCH").toBe(1);
  expect(f.db.query("SELECT state FROM google_inverses").get()).toEqual({ state: "unknown" });
  f.change("routing"); expect(await f.call()).toMatchObject({ ok: false, error: { reason: "recipient_restricted" } });
  expect(invocations).toBe(1);
});
test("google send lock survives card wait, blocks send save delete, and decline releases only its owner", async () => {
  const f = fixture(), shown = deferred<void>(), answer = deferred<PermissionDecision>();
  f.answer(async () => { shown.resolve(); return answer.promise; });
  const first = f.call(GOOGLE_SEND); await shown.promise;
  expect(f.db.query("SELECT COUNT(*) n FROM google_send_locks").get()).toEqual({ n: 1 });
  for (const call of [GOOGLE_SEND, { tool: "brain_google_gmail_draft", input: { action: "delete", draft_id: "r123" } },
    { tool: "brain_google_gmail_draft", input: { action: "update", draft_id: "r123", body: "The loom is ready." } }] as GoogleToolCall[]) {
    expect(await f.call(call), "GOOGLE_LOCK_BLOCKS_COMPETITORS").toMatchObject({ ok: false, error: { reason: "draft_locked" } });
  }
  await f.state.releaseSendLock("aeaea", f.cards[0]!.toolUseId);
  expect(f.db.query("SELECT COUNT(*) n FROM google_send_locks").get()).toEqual({ n: 1 });
  f.answer(async () => ({ behavior: "allow" }));
  expect(await f.call({ tool: "brain_google_gmail_send", input: { draft_id: "r124" } }), "GOOGLE_OTHER_DRAFT_REMAINS_USABLE").toMatchObject({ ok: true });
  answer.resolve({ behavior: "deny", message: "Declined" }); await first;
  expect(f.db.query("SELECT COUNT(*) n FROM google_send_locks").get(), "GOOGLE_DECLINE_RELEASES_LOCK").toEqual({ n: 0 });
  f.answer(async () => ({ behavior: "allow" })); expect(await f.call(GOOGLE_SEND)).toMatchObject({ ok: true });
  expect(f.db.query("SELECT COUNT(*) n FROM google_send_locks").get()).toEqual({ n: 0 });
});
for (const ending of ["allow", "edited", "stop", "withdrawn"]) test(`google send card ${ending} releases lock and another session remains usable`, async () => {
  const f = fixture(); f.answer(async card => {
    if (ending === "stop") { f.controller.abort(); return { behavior: "deny", message: "Stopped" }; }
    if (ending === "withdrawn") throw new Error("withdrawn");
    return { behavior: "allow", ...(ending === "edited" ? { updatedInput: { ...card.input, tainted: true } } : {}) };
  });
  await f.call(GOOGLE_SEND);
  expect(f.db.query("SELECT COUNT(*) n FROM google_send_locks").get()).toEqual({ n: 0 });
  f.answer(async () => ({ behavior: "allow" }));
  const other: GoogleToolsTurn = { ...f.turn, turnId: "turn-aeaea", sessionId: () => "aeaea",
    write: { ...f.turn.write!, signal: new AbortController().signal } };
  expect(await f.call(GOOGLE_MODIFY, other)).toMatchObject({ ok: true });
});

test("google unknown card-less outcome consumes the turn item limit before the next call", async () => {
  const f = fixture("allow", 1); let dispatches = 0;
  f.prepare(async call => { const p = googleModifyPrepared(call); p.execute = async final => {
    const error = final(); if (error) return { ok: false, error }; dispatches++; throw new Error("timeout");
  }; return p; });
  expect(await f.call()).toMatchObject({ ok: false, error: { code: "outcome_unknown" } });
  expect(f.cards).toHaveLength(0);
  f.answer(async () => ({ behavior: "deny", message: "No second change" }));
  expect(await f.call()).toMatchObject({ ok: false, error: { reason: "declined" } });
  expect(f.cards, "GOOGLE_UNKNOWN_DOES_NOT_REFUND_ITEMS").toHaveLength(1); expect(dispatches).toBe(1);
});
test("google changed prepared payload is refused after the exact card", async () => {
  const f = fixture(); let prepared = 0;
  f.prepare(async call => { const p = googleModifyPrepared(call); if (prepared++) p.card = { ...GOOGLE_CARD, payload: { ...GOOGLE_CARD.payload, message_ids: ["19a0c3d2e4f50602"] } }; return p; });
  expect(await f.call()).toMatchObject({ ok: false, error: { reason: "prepared_changed" } });
});
test("google irreversible receipt contains metadata only and no full message", async () => {
  const f = fixture(); expect(await f.call(GOOGLE_SEND)).toMatchObject({ ok: true, effect: "irreversible", admission: "card" });
  const stored = f.db.query("SELECT payload FROM governance_events WHERE kind='outward_action'").get() as { payload: string };
  expect(stored.payload).not.toContain("The voyage is over."); expect(stored.payload).not.toContain("odysseus@example.com");
  expect(JSON.parse(stored.payload)).toMatchObject({ action: "google_write", inputTruncated: false, decision: "approved" });
});

for (const failure of ["timeout", "abort", "ambiguous"] as const) test(`google returned ${failure} after dispatch is unknown and never retried`, async () => {
  const f = fixture(); let dispatches = 0;
  f.prepare(async call => { const p = googleModifyPrepared(call); p.execute = async final => {
    const refused = final(); if (refused) return { ok: false, error: refused }; dispatches++;
    if (failure === "abort") f.controller.abort();
    return { ok: false, error: { code: "upstream_error", reason: failure, message: "No read answer" } };
  }; return p; });
  expect(await f.call()).toMatchObject({ ok: false, error: { code: "outcome_unknown", message: "The write may or may not have happened at Google; check before trying again." } });
  expect(dispatches).toBe(1); expect(f.db.query("SELECT state FROM google_inverses").get()).toEqual({ state: "unknown" });
});

test("google failed card lock release retries automatically and leaves unrelated writes usable", async () => {
  const f = fixture();
  const release = f.state.releaseSendLock; let attempts = 0;
  f.state.releaseSendLock = async (...args) => { if (++attempts === 1) throw new Error("injected release failure"); return release(...args); };
  f.answer(async () => ({ behavior: "deny", message: "Declined" }));
  expect(await f.call(GOOGLE_SEND)).toMatchObject({ ok: false, error: { reason: "state_unavailable" } });
  expect(f.db.query("SELECT COUNT(*) n FROM google_send_locks").get()).toEqual({ n: 1 });
  f.answer(async () => ({ behavior: "allow" }));
  expect(await f.call()).toMatchObject({ ok: true });
  const until = Date.now() + watchdogMs(5_000);
  while (attempts < 2) { if (Date.now() > until) throw new Error("Google lock cleanup did not retry"); await Bun.sleep(20); }
  expect(f.db.query("SELECT COUNT(*) n FROM google_send_locks").get()).toEqual({ n: 0 });
});

for (const kind of ["authority", "policy", "safety"]) test(`google ${kind} change during decision commit refuses dispatch`, async () => {
  const f = fixture("allow"), entered = deferred<void>(), release = deferred<void>();
  const original = f.state.commitGoogleDecision; let first = true;
  f.state.commitGoogleDecision = async (...args) => {
    if (first) { first = false; entered.resolve(); await release.promise; }
    return original(...args);
  };
  const pending = f.call(); await entered.promise; f.change(kind); release.resolve();
  expect(await pending).toMatchObject({ ok: false });
  expect(f.dispatched(), "GOOGLE_RECORD_WAIT_CHANGE_ZERO_DISPATCH").toBe(0);
});

for (const kind of ["evidenceRevision", "trustRevision", "restricted"]) test(`google ${kind} change after the card settles refuses before dispatch`, async () => {
  const f = fixture();
  let prepared = 0;
  f.prepare(async call => { if (++prepared === 2) f.change(kind); return googleModifyPrepared(call, () => { throw new Error("must not dispatch"); }); });
  expect(await f.call(), "GOOGLE_APPROVED_SAFETY_PINNED").toMatchObject({ ok: false, error: { reason: "safety_changed" } });
  expect(f.cards).toHaveLength(1);
  expect(f.db.query("SELECT COUNT(*) AS n FROM google_inverses").get()).toEqual({ n: 0 });
});

/** A schema-valid send card whose escaped references alone reach `bytes` of JSON. */
function sendCardReaching(bytes: number): (call: GoogleToolCall) => Promise<PreparedGoogleWrite> {
  return async call => {
    const p = googleSendPrepared(call);
    const payload = p.card.payload as Extract<GoogleMailApproval, { operation: "gmail.draft.send" }>["payload"];
    const references: string[] = [];
    const sized = () => jsonBytes({ ...p.card, payload: { ...payload, message: { ...payload.message, references } } });
    while (references.length < 100 && sized() < bytes) references.push(`<${"\"".repeat(1_900)}${references.length}@ithaca.example>`);
    while (references.length && sized() > bytes) references.pop();
    p.card = { ...p.card, payload: { ...payload, message: { ...payload.message, in_reply_to: [], references } } } as GoogleMailApproval;
    return p;
  };
}
test("google refuses an approval card too large to show exactly, before any lock or card", async () => {
  const f = fixture();
  f.prepare(async call => {
    const p = await sendCardReaching(Infinity)(call);
    const payload = p.card.payload as Extract<GoogleMailApproval, { operation: "gmail.draft.send" }>["payload"];
    p.card = { ...p.card, payload: { ...payload, message: { ...payload.message, in_reply_to: payload.message.references } } } as GoogleMailApproval;
    expect(jsonBytes(p.card), "GOOGLE_FIXTURE_OVER_BUDGET").toBeGreaterThan(GOOGLE_APPROVAL_CARD_BYTES);
    return p;
  });
  expect(await f.call(GOOGLE_SEND), "GOOGLE_CARD_TOO_LARGE_REFUSED").toMatchObject({ ok: false, error: { code: "draft_not_displayable", reason: "card_too_large" } });
  expect(f.cards).toHaveLength(0); expect(f.dispatched()).toBe(0);
  expect(f.db.query("SELECT COUNT(*) AS n FROM google_send_locks").get()).toEqual({ n: 0 });
});
test("google approval frame at the card budget replicates byte for byte", async () => {
  const f = fixture();
  f.prepare(sendCardReaching(GOOGLE_APPROVAL_CARD_BYTES));
  f.answer(async () => ({ behavior: "deny", message: "Not now." }));
  await f.call(GOOGLE_SEND);
  expect(f.cards).toHaveLength(1);
  const frame = { type: "tool_approval_request", ...f.cards[0]! };
  expect(jsonBytes(f.cards[0]!.input), "GOOGLE_FIXTURE_NEAR_BUDGET").toBeGreaterThan(GOOGLE_APPROVAL_CARD_BYTES - 5_000);
  expect(jsonBytes(frame)).toBeLessThan(MAX_WS_MESSAGE_BYTES);
  expect(shrinkForReplication(frame), "GOOGLE_CARD_NEVER_SHRUNK").toEqual(frame);
});

test("google withdrawal and unknown marking that fail are retried until they land", async () => {
  const f = fixture("allow");
  f.db.exec("CREATE TRIGGER google_withdraw_failure BEFORE DELETE ON google_inverses BEGIN SELECT RAISE(ABORT, 'withdraw failed'); END");
  f.prepare(async call => { const p = googleModifyPrepared(call); const execute = p.execute; p.execute = async check => { f.change("authority"); return execute(check); }; return p; });
  expect(await f.call(), "GOOGLE_FINAL_ADMISSION_REFUSAL").toMatchObject({ ok: false });
  expect(f.db.query("SELECT state FROM google_inverses").all(), "GOOGLE_WITHDRAWAL_FAILED_ONCE").toEqual([{ state: "prepared" }]);
  f.db.exec("DROP TRIGGER google_withdraw_failure");
  const until = Date.now() + watchdogMs(10_000);
  while ((f.db.query("SELECT COUNT(*) AS n FROM google_inverses").get() as { n: number }).n > 0) {
    if (Date.now() > until) throw new Error("GOOGLE_WITHDRAWAL_RETRIED: the undispatched inverse was never withdrawn");
    await Bun.sleep(20);
  }
  const g = fixture("allow");
  g.db.exec("CREATE TRIGGER google_unknown_failure BEFORE UPDATE ON google_inverses WHEN NEW.state='unknown' BEGIN SELECT RAISE(ABORT, 'unknown failed'); END");
  g.prepare(async call => { const p = googleModifyPrepared(call); p.execute = async check => { const error = check(); if (error) return { ok: false, error };
    return { ok: false, error: { code: "outcome_unknown", reason: "timeout", message: "timed out" } }; }; return p; });
  expect(await g.call()).toMatchObject({ ok: false, error: { code: "outcome_unknown" } });
  expect(g.db.query("SELECT state FROM google_inverses").all()).toEqual([{ state: "prepared" }]);
  g.db.exec("DROP TRIGGER google_unknown_failure");
  while ((g.db.query("SELECT state FROM google_inverses").get() as { state: string }).state !== "unknown") {
    if (Date.now() > until) throw new Error("GOOGLE_UNKNOWN_MARKING_RETRIED: the dispatched inverse stayed prepared");
    await Bun.sleep(20);
  }
}, watchdogMs(30_000));

test("google startup cleanup failure restricts writes until a retry restores readiness", async () => {
  let failing = true;
  const startup = await initializeGoogleWrites({ clearSendLocksAtHostStart: async () => { if (failing) throw new Error("locked"); },
    pruneExpiredInverses: async () => 0 } as unknown as Parameters<typeof initializeGoogleWrites>[0], () => {});
  try {
    expect(startup.ready(), "GOOGLE_STARTUP_FAILURE_RESTRICTS").toBe(false);
    failing = false;
    const until = Date.now() + watchdogMs(10_000);
    while (!startup.ready()) {
      if (Date.now() > until) throw new Error("GOOGLE_STARTUP_RECOVERS_READY: writes never became ready again");
      await Bun.sleep(20);
    }
  } finally { startup.close(); }
}, watchdogMs(30_000));

test("google final admission closes when execute settles, so a retained callback never dispatches late", async () => {
  const f = fixture("allow");
  let retained: (() => unknown) | undefined, late: unknown;
  f.prepare(async call => { const p = googleModifyPrepared(call, () => { throw new Error("must not dispatch"); }); const execute = p.execute;
    p.execute = async check => { retained = () => check(); void execute; return { ok: false, error: { code: "upstream_error", reason: "gave_up", message: "gave up" } }; }; return p; });
  expect(await f.call()).toMatchObject({ ok: false, error: { reason: "missing_admission" } });
  late = retained!();
  expect(late, "GOOGLE_ADMISSION_CLOSED_AFTER_SETTLE").toMatchObject({ reason: "admission_closed" });
  expect(f.db.query("SELECT COUNT(*) AS n FROM google_inverses").get()).toEqual({ n: 0 });
});

test("google lost commit replies leave no inverse and no send lock behind", async () => {
  const f = fixture("allow");
  const turn: GoogleToolsTurn = { ...f.turn, write: { ...f.turn.write!, record: async (...args) => { await f.state.commitGoogleDecision(...args); throw new Error("reply lost"); } } };
  expect(await f.call(GOOGLE_MODIFY, turn), "GOOGLE_LOST_RECORD_REPLY_REFUSES").toMatchObject({ ok: false, error: { reason: "recording_unavailable" } });
  expect(f.dispatched()).toBe(0);
  expect(f.db.query("SELECT COUNT(*) AS n FROM google_inverses").get(), "GOOGLE_LOST_RECORD_REPLY_WITHDRAWS").toEqual({ n: 0 });
  expect((f.db.query("SELECT json_extract(payload,'$.callId') AS call, json_extract(payload,'$.decision') AS decision FROM governance_events ORDER BY id").all() as { call: string; decision: string }[])
    .map(row => row.decision), "GOOGLE_LOST_RECORD_REPLY_REFUSAL_FOLLOWS").toEqual(["allowed", "refused"]);
  expect(new Set((f.db.query("SELECT json_extract(payload,'$.callId') AS call FROM governance_events").all() as { call: string }[]).map(row => row.call)).size).toBe(1);
  const g = fixture();
  const acquire = g.state.acquireSendLock;
  g.state.acquireSendLock = async input => { await acquire(input); throw new Error("reply lost"); };
  expect(await g.call(GOOGLE_SEND)).toMatchObject({ ok: false });
  expect(g.cards).toHaveLength(0); expect(g.dispatched()).toBe(0);
  expect(g.db.query("SELECT COUNT(*) AS n FROM google_send_locks").get(), "GOOGLE_LOST_LOCK_REPLY_RELEASES").toEqual({ n: 0 });
});

test("google remembered approvals are inert when tainted and deny wins", async () => {
  const f = fixture(); f.answer(async () => ({ behavior: "allow", always: true })); await f.call();
  f.tainted(true); f.answer(async () => ({ behavior: "allow" }));
  expect(await f.call(), "GOOGLE_TAINT_IGNORES_MEMORY").toMatchObject({ ok: true, admission: "card" });
  expect(f.cards.at(-1)!.input).toMatchObject({ offers: { allow_always: false, allow_for_session: true } });
  f.tainted(false);
  const deniedPolicy = { ...googlePolicy(), operations: { "gmail.modify": "deny" as const } }; f.setPolicy(deniedPolicy);
  const denied = { ...f.turn, policy: () => deniedPolicy };
  expect(await f.call(GOOGLE_MODIFY, denied), "GOOGLE_DENY_ABOVE_MEMORY").toMatchObject({ ok: false, error: { reason: "operation_denied" } });
});

test("google session allowance admits voice only for its operation and entity", async () => {
  const f = fixture(); f.tainted(true); f.answer(async () => ({ behavior: "allow", forSession: true }));
  expect(await f.call()).toMatchObject({ ok: true, admission: "card" });
  expect(await f.call(GOOGLE_MODIFY, { ...f.turn, posture: "voice" }), "GOOGLE_SESSION_VOICE").toMatchObject({ ok: true, admission: "session_allowance" });
  const other: GoogleToolCall = { tool: "brain_google_gmail_modify", input: { message_ids: ["19a0c3d2e4f50601"], add_label_ids: ["STARRED"] } };
  expect(await f.call(other, { ...f.turn, posture: "voice" }), "GOOGLE_ENTITY_BOUND").toMatchObject({ ok: false, error: { reason: "voice_posture" } });
  f.db.query("UPDATE google_session_allowances SET operation='gmail.draft.save'").run();
  expect(await f.call(GOOGLE_MODIFY, { ...f.turn, posture: "voice" }), "GOOGLE_OPERATION_BOUND").toMatchObject({ ok: false, error: { reason: "voice_posture" } });
  expect(f.cards).toHaveLength(1);
});

for (const boundary of ["24 hours", "host restart"]) test(`google session allowance expires at ${boundary}`, async () => {
  const f = fixture(); f.tainted(true); f.answer(async () => ({ behavior: "allow", forSession: true })); await f.call();
  if (boundary === "24 hours") f.clock(f.now() + 86_400_000);
  else f.db.query("UPDATE google_session_allowances SET host_epoch='previous-process'").run();
  expect(await f.call(GOOGLE_MODIFY, { ...f.turn, posture: "voice" }), "GOOGLE_ALLOWANCE_EXPIRED").toMatchObject({ ok: false, error: { reason: "voice_posture" } });
});

test("google session allowance ceiling is 100 across turns", async () => {
  const f = fixture(); f.tainted(true); f.answer(async () => ({ behavior: "allow", forSession: true })); await f.call();
  for (let i = 0; i < 100; i++) expect(await f.call(GOOGLE_MODIFY, { ...f.turn, turnId: `voyage-${i}`, posture: "voice", write: { ...f.turn.write! } })).toMatchObject({ ok: true, admission: "session_allowance" });
  expect(await f.call(GOOGLE_MODIFY, { ...f.turn, posture: "voice", write: { ...f.turn.write! } }), "GOOGLE_ALLOWANCE_100_CEILING").toMatchObject({ ok: false, error: { reason: "voice_posture" } });
});

for (const kind of ["policy", "principal", "normal"]) test(`google session allowance permanently voids on ${kind}`, async () => {
  const f = fixture(); f.tainted(true); f.answer(async () => ({ behavior: "allow", forSession: true })); await f.call();
  if (kind === "policy") f.change("policy");
  if (kind === "principal") f.owner(false);
  if (kind === "normal") f.tainted(false);
  await f.call(GOOGLE_MODIFY, { ...f.turn, posture: "voice" });
  expect(f.db.query("SELECT COUNT(*) n FROM google_session_allowances").get(), "GOOGLE_ALLOWANCE_VOID").toEqual({ n: 0 });
  f.owner(true); f.tainted(true);
  expect(await f.call(GOOGLE_MODIFY, { ...f.turn, posture: "voice" })).toMatchObject({ ok: false });
});

test("google session allowance admits nothing after latch recovery while its chat's safety evidence is unreadable", async () => {
  const f = fixture(); f.tainted(true); f.answer(async () => ({ behavior: "allow", forSession: true }));
  // The production admission read: the chat's own safety projection, not a stub.
  const live = createEffectiveSafety(f.db, { turnId: "turn-ithaca", sessionId: () => "ithaca", policyHash: JSON.stringify(googlePolicy()),
    authority: () => ({ current: true, epoch: "0" }) });
  const turn = (posture: GoogleToolsTurn["posture"]): GoogleToolsTurn => ({ ...f.turn, posture, write: { ...f.turn.write!, safety: () => live.read() } });
  // A classified chat with complete coverage, restricted only by one unresolved occurrence.
  beginSafetyCollection(f.db, { turnId: "ogygia", bindingId: "ogygia", sessionId: null, principalId: "odysseus", backendId: "claude", at: f.now(), policyHash: null });
  safetyCatalogCreated(f.db, "ithaca", "odysseus", "ogygia");
  bindSafetyCollection(f.db, "ogygia", "ithaca");
  acknowledgeSafety(f.db, "ogygia", "claude", 1);
  endSafetyCollection(f.db, "ogygia");
  const occurrence = (id: string, sequence: string, payload: string) => f.db.run(`INSERT INTO safety_records(id,collection_id,sequence,observed_at,kind,occurrence_id,state,payload,bytes,reserved_rows,reserved_bytes)
    SELECT ?,id,?,1,'occurrence',?,'finalized',?,1,1,1 FROM safety_collections WHERE turn_id='ogygia'`, [id, sequence, id, payload]);
  occurrence("circe", "900000000002", '{"admission":{"trusted":false}}');
  expect(live.read().restricted).toBe(true);
  expect(await f.call(GOOGLE_MODIFY, turn("interactive"))).toMatchObject({ ok: true, admission: "card" });
  expect(await f.call(GOOGLE_MODIFY, turn("voice")), "GOOGLE_LIVE_SAFETY_ALLOWANCE").toMatchObject({ ok: true, admission: "session_allowance" });
  // Its sequence sorts first, so continuity reads it before the readable one.
  occurrence("calypso", "900000000001", "not-json");
  latchSafety(f.db, null, "recording_failed");
  recoverSafetyRecording(f.db);
  expect(f.db.query("SELECT failed FROM safety_meta").get(), "GOOGLE_UNREADABLE_LATCH_CLEARED").toEqual({ failed: 0 });
  const remaining = f.db.query("SELECT remaining_items FROM google_session_allowances").get(), dispatched = f.dispatched();
  expect(remaining, "GOOGLE_UNREADABLE_ALLOWANCE_KEPT").toEqual({ remaining_items: 99 });
  expect(() => live.read(), "GOOGLE_UNREADABLE_PROJECTION_THROWS").toThrow("Safety evidence is unreadable");
  expect(await f.call(GOOGLE_MODIFY, turn("voice")), "GOOGLE_UNREADABLE_SAFETY_REFUSES").toMatchObject({ ok: false, error: { reason: "safety_changed" } });
  expect(f.dispatched(), "GOOGLE_UNREADABLE_NO_DISPATCH").toBe(dispatched);
  expect(f.db.query("SELECT remaining_items FROM google_session_allowances").get(), "GOOGLE_UNREADABLE_NOT_CHARGED").toEqual(remaining);
  // Control: the unreadable record alone refused it. The chat stayed restricted, so the allowance still holds.
  f.db.run("DELETE FROM safety_records WHERE id='calypso'");
  expect(await f.call(GOOGLE_MODIFY, turn("voice")), "GOOGLE_READABLE_AGAIN_ADMITS").toMatchObject({ ok: true, admission: "session_allowance" });
});

// SQLite's extractors read JSON5 and JSONB payloads that json_valid rejects.
// Continuity keeps the allowance on such a payload, so the projection must not
// read trust from it either: otherwise a normal interval nobody observes is
// missed, and the kept allowance is usable again once the chat re-restricts (#4631).
for (const encoding of ["json5", "jsonb"] as const) test(`google session allowance does not survive an unobserved normal interval behind a ${encoding} occurrence`, async () => {
  const f = fixture(); f.tainted(true);
  const version = (f.db.query("SELECT sqlite_version() v").get() as { v: string }).v;
  if (encoding === "jsonb") {
    let supported = true; try { f.db.query("SELECT jsonb('{}')").get(); } catch { supported = false; }
    const [major = 0, minor = 0] = version.split(".").map(Number);
    expect(supported, "GOOGLE_JSONB_COVERAGE " + version).toBe(major > 3 || (major === 3 && minor >= 45));
    // Below 3.45 SQLite cannot store or read JSONB, so this encoding cannot occur.
    if (!supported) return;
  }
  const live = createEffectiveSafety(f.db, { turnId: "turn-ithaca", sessionId: () => "ithaca", policyHash: JSON.stringify(googlePolicy()),
    authority: () => ({ current: true, epoch: "0" }) });
  const voice: GoogleToolsTurn = { ...f.turn, posture: "voice", write: { ...f.turn.write!, safety: () => live.read() } };
  beginSafetyCollection(f.db, { turnId: "scheria", bindingId: "scheria", sessionId: null, principalId: "odysseus", backendId: "claude", at: f.now(), policyHash: null });
  safetyCatalogCreated(f.db, "ithaca", "odysseus", "scheria");
  bindSafetyCollection(f.db, "scheria", "ithaca");
  acknowledgeSafety(f.db, "scheria", "claude", 1);
  expect(live.read().restricted).toBe(false);
  // Restricted only by a pending reservation when the allowance is granted.
  reserveSafetyWrite(f.db, "scheria", "pending-scheria", 100);
  await f.allowances.grant({ sessionId: "ithaca", principalId: "odysseus", brainId: "brain", accountIdentity: "odysseus@example.com",
    hostEpoch: "ithaca-epoch", policyHash: JSON.stringify(googlePolicy()), now: f.now(), tainted: true, authorized: true },
    "gmail.modify", ["archive"], "card-scheria");
  const occurrence = (id: string, sequence: string, payload: string) => f.db.run(`INSERT INTO safety_records(id,collection_id,sequence,observed_at,kind,occurrence_id,state,payload,bytes,reserved_rows,reserved_bytes)
    SELECT ?,id,?,1,'occurrence',?,'finalized',?,1,1,1 FROM safety_collections WHERE turn_id='scheria'`, [id, sequence, id, payload]);
  // A trusted occurrence that only SQLite's extractors can read, by manual edit.
  occurrence("nausicaa", "900000000001", encoding === "json5" ? "{admission:{trusted:true}}" : '{"admission":{"trusted":true}}');
  if (encoding === "jsonb") f.db.run("UPDATE safety_records SET payload=jsonb(payload) WHERE id='nausicaa'");
  // The normal transition, with no Google call to observe it.
  releaseSafetyWrite(f.db, "pending-scheria");
  expect(f.db.query("SELECT COUNT(*) n FROM google_session_allowances").get(), "GOOGLE_NONCANONICAL_ALLOWANCE_KEPT").toEqual({ n: 1 });
  let afterRelease: string;
  try { afterRelease = safetyProjection(f.db, null, "ithaca").restriction; } catch (error) { afterRelease = (error as Error).message; }
  // An ordinary untrusted occurrence restricts the chat again.
  occurrence("arete", "900000000002", '{"admission":{"trusted":false}}');
  const dispatched = f.dispatched();
  expect(await f.call(GOOGLE_MODIFY, voice), "GOOGLE_NONCANONICAL_ALLOWANCE_REFUSED").toMatchObject({ ok: false, error: { reason: "safety_changed" } });
  expect(f.dispatched(), "GOOGLE_NONCANONICAL_NO_DISPATCH").toBe(dispatched);
  expect(f.db.query("SELECT remaining_items FROM google_session_allowances").get(), "GOOGLE_NONCANONICAL_NOT_CHARGED").toEqual({ remaining_items: 100 });
  expect(afterRelease, "GOOGLE_NONCANONICAL_NO_NORMAL_INTERVAL").toBe("Safety evidence is unreadable");
  // Control: once that occurrence is gone the chat reads as restricted, and the allowance admits.
  f.db.run("DELETE FROM safety_records WHERE id='nausicaa'");
  expect(await f.call(GOOGLE_MODIFY, voice), "GOOGLE_READABLE_RESTRICTED_ADMITS").toMatchObject({ ok: true, admission: "session_allowance" });
});

test("google alias repoint inherits no approval and a change after the card refuses", async () => {
  const f = fixture(); f.answer(async () => ({ behavior: "allow", always: true })); await f.call();
  f.identity("penelope@example.com");
  expect(await f.call(GOOGLE_MODIFY, { ...f.turn, posture: "voice" }), "GOOGLE_ALIAS_NO_INHERIT").toMatchObject({ ok: false, error: { reason: "voice_posture" } });
  f.answer(async () => { f.identity("telemachus@example.com"); return { behavior: "allow" }; });
  expect(await f.call(), "GOOGLE_IDENTITY_RECHECK").toMatchObject({ ok: false, error: { reason: "account_changed" } });
  expect(f.dispatched()).toBe(1);
});

for (const kind of ["remembered", "session"]) test(`google ${kind} revocation is checked at final admission`, async () => {
  const f = fixture(); f.tainted(kind === "session");
  f.answer(async () => ({ behavior: "allow", ...(kind === "session" ? { forSession: true } : { always: true }) })); await f.call();
  f.prepare(async call => { const p = googleModifyPrepared(call), execute = p.execute;
    p.execute = async final => {
      if (kind === "session") await f.allowances.revoke("ithaca", "odysseus", "brain", f.cards[0]!.toolUseId);
      else for (const row of f.ledger.list("brain")) f.ledger.revoke("brain", row.id);
      return execute(final);
    }; return p; });
  expect(await f.call(), "GOOGLE_FINAL_GRANT_REVOKED").toMatchObject({ ok: false });
  expect(f.dispatched()).toBe(1);
});

test("google irreversible and tainted always answers never grant", async () => {
  for (const call of [GOOGLE_MODIFY, GOOGLE_SEND]) {
    const f = fixture(); f.tainted(true); f.answer(async () => ({ behavior: "allow", always: true }));
    expect(await f.call(call), "GOOGLE_WRONG_GRANT_KIND").toMatchObject({ ok: false, error: { reason: "standing_choice_unavailable" } });
    expect(f.ledger.list("brain")).toHaveLength(0);
  }
});

test("google handoff fork and import destinations never consume source session authority", async () => {
  const f = fixture(); f.tainted(true); f.answer(async () => ({ behavior: "allow", forSession: true })); await f.call();
  for (const kind of ["handoff", "fork", "import"]) {
    const sessionId = `aeaea-${kind}`;
    f.db.query("INSERT INTO sessions(id,created_at,last_active_at,handoff_from) VALUES(?,1,1,?)").run(sessionId, kind === "handoff" ? "ithaca" : null);
    expect(await f.call(GOOGLE_MODIFY, { ...f.turn, sessionId: () => sessionId, turnId: `turn-${sessionId}`, posture: "voice", write: { ...f.turn.write! } }),
      "GOOGLE_SESSION_AUTHORITY_NEVER_TRANSFERS").toMatchObject({ ok: false, error: { reason: "voice_posture" } });
  }
  expect(await f.call(GOOGLE_MODIFY, { ...f.turn, posture: "voice" })).toMatchObject({ ok: true, admission: "session_allowance" });
});

test("google unavailable standing stores fall back to an exact card and recover", async () => {
  const f = fixture(); f.answer(async () => ({ behavior: "allow", forSession: true })); f.tainted(true); await f.call();
  f.db.exec("ALTER TABLE google_session_allowances RENAME TO held_allowances");
  f.answer(async () => ({ behavior: "allow" }));
  expect(await f.call(), "GOOGLE_ALLOWANCE_FAILURE_CARD_FALLBACK").toMatchObject({ ok: true, admission: "card" });
  expect(f.db.query("SELECT json_extract(payload,'$.standingFailures[0].store') AS store FROM governance_events WHERE kind='google_call'").get(),
    "GOOGLE_STORAGE_FAILURE_DURABLE").toEqual({ store: "session_allowances" });
  f.db.exec("ALTER TABLE held_allowances RENAME TO google_session_allowances");
  expect(await f.call(), "GOOGLE_ALLOWANCE_AUTOMATIC_RECOVERY").toMatchObject({ ok: true, admission: "session_allowance" });
});

test("google allowance honors the per-turn ceiling in addition to its total", async () => {
  const f = fixture("ask", 1); f.tainted(true); f.answer(async () => ({ behavior: "allow", forSession: true })); await f.call();
  expect(await f.call(GOOGLE_MODIFY, { ...f.turn, posture: "voice" })).toMatchObject({ ok: true, admission: "session_allowance" });
  expect(await f.call(GOOGLE_MODIFY, { ...f.turn, posture: "voice" }), "GOOGLE_ALLOWANCE_TURN_LIMIT").toMatchObject({ ok: false, error: { reason: "voice_posture" } });
});

test("google remembered approval cannot override a later operation deny", async () => {
  const f = fixture(); f.answer(async () => ({ behavior: "allow", always: true })); await f.call();
  const policy = { ...googlePolicy(), operations: { "gmail.modify": "deny" as const } }; f.setPolicy(policy);
  expect(await f.call(GOOGLE_MODIFY, { ...f.turn, policy: () => policy, write: { ...f.turn.write! } }),
    "GOOGLE_LATER_DENY_WINS").toMatchObject({ ok: false, error: { reason: "operation_denied" } });
});

test("google ledger failure asks once, records its cause, and recovers on the next call", async () => {
  const f = fixture(); f.answer(async () => ({ behavior: "allow", always: true })); await f.call();
  const read = f.ledger.approvals; f.ledger.approvals = () => { throw new Error("injected ledger read failure"); };
  f.answer(async () => ({ behavior: "allow" }));
  expect(await f.call(), "GOOGLE_LEDGER_CARD_FALLBACK").toMatchObject({ ok: true, admission: "card" });
  expect(f.db.query("SELECT json_extract(payload,'$.standingFailures[0].message') AS message FROM governance_events WHERE kind='google_call'").get(),
    "GOOGLE_LEDGER_FAILURE_DURABLE").toEqual({ message: "Google standing approval storage is unavailable." });
  f.ledger.approvals = read;
  expect(await f.call()).toMatchObject({ ok: true, admission: "remembered_approval" });
});

for (const kind of ["always", "session"]) test(`google changed identity leaves no ${kind} grant`, async () => {
  const f = fixture(); f.tainted(kind === "session");
  f.answer(async () => { f.identity("penelope@example.com"); return { behavior: "allow", ...(kind === "always" ? { always: true } : { forSession: true }) }; });
  expect(await f.call()).toMatchObject({ ok: false, error: { reason: "account_changed" } });
  expect(f.ledger.list("brain"), "GOOGLE_CHANGED_IDENTITY_NO_GRANT").toEqual([]);
  expect(f.db.query("SELECT COUNT(*) n FROM google_session_allowances").get(), "GOOGLE_CHANGED_IDENTITY_NO_GRANT").toEqual({ n: 0 });
  expect(f.dispatched()).toBe(0);
});
for (const kind of ["always", "session"]) test(`google failed ${kind} grant keeps the once-only card`, async () => {
  const f = fixture(); f.tainted(kind === "session");
  if (kind === "always") f.ledger.remember = () => { throw new Error("EACCES opening /srv/private-google/ledger.sqlite token=secret"); };
  else f.allowances.grant = async () => { throw new Error("EACCES opening /srv/private-google/ui.db"); };
  f.answer(async () => ({ behavior: "allow", ...(kind === "always" ? { always: true } : { forSession: true }) }));
  expect(await f.call(), "GOOGLE_GRANT_FAILURE_ONCE_ONLY").toMatchObject({ ok: true, admission: "card", standingChoice: "not_kept" });
  expect(f.dispatched()).toBe(1);
  const events = f.db.query("SELECT payload FROM governance_events WHERE kind='google_call'").all();
  expect(events, "GOOGLE_GRANT_FAILURE_AUDITED").toHaveLength(1);
  expect(JSON.stringify(events), "GOOGLE_AUDIT_NO_HOST_PATH").not.toContain("/srv/");
  expect(JSON.stringify(events)).toContain("The standing choice was not kept; this call uses its exact approval.");
  expect(f.ledger.list("brain")).toEqual([]);
  expect(f.db.query("SELECT COUNT(*) n FROM google_session_allowances").get()).toEqual({ n: 0 });
});
test("google engine never reads remembered authority for a tainted decision", async () => {
  const f = fixture(); f.tainted(true);
  let reads = 0; const read = f.ledger.approvals;
  f.ledger.approvals = scope => { reads++; return read(scope); };
  await f.call();
  expect(reads, "GOOGLE_ENGINE_TAINT_GUARD").toBe(0);
});
test("google final admission cannot switch to an unreserved allowance", async () => {
  const f = fixture(); f.answer(async () => ({ behavior: "allow", always: true })); await f.call();
  f.prepare(async call => {
    const prepared = googleModifyPrepared(call, () => { throw new Error("GOOGLE_UNRESERVED_DISPATCH"); }), execute = prepared.execute;
    prepared.execute = async final => {
      await f.allowances.grant({ sessionId: "ithaca", principalId: "odysseus", brainId: "brain", accountIdentity: "odysseus@example.com",
        hostEpoch: "ithaca-epoch", policyHash: JSON.stringify(googlePolicy()), now: f.now(), tainted: true, authorized: true },
        "gmail.modify", ["archive"], "other-card");
      f.tainted(true);
      return execute(final);
    };
    return prepared;
  });
  expect(await f.call(), "GOOGLE_FINAL_ADMISSION_KIND").toMatchObject({ ok: false, error: { reason: "safety_changed" } });
  expect(f.db.query("SELECT remaining_items FROM google_session_allowances").get()).toEqual({ remaining_items: 100 });
});

test("google identity changed during session grant withdraws that new authority", async () => {
  const f = fixture(); f.tainted(true);
  const grant = f.allowances.grant;
  f.allowances.grant = async (...args) => { await grant(...args); f.identity("penelope@example.com"); };
  f.answer(async () => ({ behavior: "allow", forSession: true }));
  expect(await f.call()).toMatchObject({ ok: false, error: { reason: "account_changed" } });
  expect(f.db.query("SELECT COUNT(*) n FROM google_session_allowances").get(), "GOOGLE_POST_WRITER_IDENTITY_NO_GRANT").toEqual({ n: 0 });
  expect(f.dispatched()).toBe(0);
});

for (const fault of ["changed identity", "lost reply"] as const) test(`google session grant cleanup retries after ${fault}`, async () => {
  const f = fixture(); f.tainted(true);
  const grant = f.allowances.grant, revoke = f.allowances.revoke;
  let unavailable = true, attempts = 0;
  f.allowances.grant = async (...args) => {
    await grant(...args);
    if (fault === "changed identity") f.identity("penelope@example.com");
    else throw new Error("writer reply lost");
  };
  f.allowances.revoke = async (...args) => {
    attempts++;
    if (unavailable) throw new Error("writer unavailable");
    return revoke(...args);
  };
  f.answer(async () => ({ behavior: "allow", forSession: true }));
  const result = await f.call();
  expect(result, "GOOGLE_GRANT_CLEANUP_RESULT").toMatchObject(fault === "changed identity"
    ? { ok: false, error: { reason: "account_changed" } }
    : { ok: true, admission: "card", standingChoice: "not_kept" });
  expect(f.db.query("SELECT COUNT(*) n FROM google_session_allowances").get()).toEqual({ n: 1 });
  const app = new Hono<AppEnv>();
  const owner = f.db.query<Principal, []>("SELECT * FROM principals WHERE id='odysseus'").get()!;
  app.use("*", async (c, next) => { c.set("principal", owner); await next(); });
  app.route("/api", createGoogleApprovalRoutes({ brainId: "brain", hostEpoch: "ithaca-epoch", ledger: () => f.ledger,
    allowances: f.allowances, authorized: id => id === owner.id, owns: (id, session) => id === owner.id && session === "ithaca",
    tainted: () => true, policyHash: () => JSON.stringify(googlePolicy()) }));
  const response = await app.request("/api/sessions/ithaca/google/allowances");
  expect(response.status).toBe(200);
  expect(await response.json(), "GOOGLE_HTTP_WITHDRAWN_GRANT_HIDDEN").toEqual({ allowances: [] });
  f.identity("odysseus@example.com");
  expect(await f.call(GOOGLE_MODIFY, { ...f.turn, posture: "voice" }),
    "GOOGLE_WITHDRAWN_GRANT_UNUSABLE").toMatchObject({ ok: false });
  unavailable = false;
  const until = Date.now() + watchdogMs(10_000);
  while ((f.db.query("SELECT COUNT(*) n FROM google_session_allowances").get() as { n: number }).n) {
    if (Date.now() > until) throw new Error("GOOGLE_GRANT_WITHDRAWAL_RETRY");
    await Bun.sleep(20);
  }
  expect(attempts, "GOOGLE_GRANT_WITHDRAWAL_RETRY").toBeGreaterThan(1);
});

test("google startup purges prior epochs before becoming ready", async () => {
  const f = fixture(); f.tainted(true);
  f.answer(async () => ({ behavior: "allow", forSession: true }));
  await f.call();
  expect(f.db.query("SELECT COUNT(*) n FROM google_session_allowances").get()).toEqual({ n: 1 });
  const startup = await initializeGoogleWrites(f.state, () => {}, () => f.allowances.clearOldEpochs("new-epoch"));
  cleanup.unshift(() => startup.close());
  expect(startup.ready()).toBe(true);
  expect(f.db.query("SELECT COUNT(*) n FROM google_session_allowances").get(), "GOOGLE_STARTUP_OLD_ALLOWANCES").toEqual({ n: 0 });
});
