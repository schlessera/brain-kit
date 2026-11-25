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

const cleanup: Array<() => void> = [];
afterEach(() => { for (const close of cleanup.splice(0)) close(); });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(mode: "ask" | "allow" = "ask", limit?: number) {
  const db = createUiDb(":memory:"); cleanup.push(() => db.close());
  for (const id of ["ithaca", "aeaea"]) db.query("INSERT INTO sessions(id,created_at,last_active_at) VALUES (?,1,1)").run(id);
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
  const host = createGoogleToolsHost({ credential: { transport: () => { throw new Error("No Google binary in write tests"); } },
    principal: () => owner ? "owner" : "not_owner", untrusted: async () => {},
    writes: { brainId: "brain", state, ready: () => true, currentPolicy: () => policy,
      isDraftLocked: (account, draft, epoch, at) => isDraftSendLocked(db, "brain", account, draft, epoch, at),
      preparedWrites: { "gmail.modify": (_, call) => prepare(call), "gmail.draft.send": (_, call) => prepare(call),
        "gmail.draft.save": (_, call) => prepare(call), "gmail.draft.delete": (_, call) => prepare(call) } } });
  cleanup.unshift(() => host.close?.());
  return { db, state, turn, host, controller, cards, dispatched: () => dispatched, prepares: () => prepares,
    answer: (fn: typeof answer) => { answer = fn; }, prepare: (fn: typeof prepare) => { prepare = fn; },
    change: (kind: string) => { if (kind === "authority") current = false; if (kind === "policy") policy = googlePolicy(mode === "ask" ? "allow" : "ask");
      if (kind === "safety") safety = { ...safety, recordingAvailable: false }; if (kind === "taint") tainted = true;
      if (kind === "routing") routing = "recipient_restricted"; if (kind === "owner") owner = false;
      if (kind === "evidenceRevision" || kind === "trustRevision") safety = { ...safety, [kind]: "1" }; if (kind === "restricted") safety = { ...safety, restricted: true }; },
    call: (call = GOOGLE_MODIFY, context = turn) => host.call(context, call) };
}

test("google exact card commits decision and inverse before one dispatch and confirms inverse", async () => {
  const f = fixture();
  f.prepare(async call => googleModifyPrepared(call, () => {
    expect(f.db.query("SELECT state FROM google_inverses").get(), "GOOGLE_INVERSE_COMMITTED_BEFORE_DISPATCH").toEqual({ state: "prepared" });
    expect(f.db.query("SELECT kind FROM governance_events").get(), "GOOGLE_DECISION_COMMITTED_BEFORE_DISPATCH").toEqual({ kind: "google_reversible_action" });
  }));
  const result = await f.call();
  expect(result).toMatchObject({ ok: true, admission: "card", operation: "gmail.modify", result: GOOGLE_CARD.payload });
  expect(f.cards.map(card => card.input)).toEqual([GOOGLE_CARD]);
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
for (const choice of [{ always: true }, { forSession: true }, { always: true, forSession: true }]) test(`google unavailable standing answer ${JSON.stringify(choice)} is declined`, async () => {
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
