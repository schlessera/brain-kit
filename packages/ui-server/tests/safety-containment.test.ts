/** A safety-recording failure restricts what it puts at risk, never more, and
 * recovers by itself when recovery needs no judgment (#3812, #3810). */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client";
import { openSqliteWriter } from "../src/db/write-worker";
import { attemptSafetyRecovery, createGovernanceWrites } from "../src/governance/event-writes";
import { createSafetyCollector } from "../src/governance/safety-collector";
import { latchSafety, safetyCatalogCreated, safetyFailureCause, SafetyCapacityExhausted, safetyFailureReason,
  SafetyRecordingUnavailable, SafetyUnavailable } from "../src/governance/safety-store";
import { emitTurnError } from "../src/ws/bridge-capabilities/turn-error";
import { holdSafetyRecovery } from "./helpers/hold-safety-recovery";
import { failurePresentation, refusalReason } from "../../ui-react/src/lib/turn-failure";

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function open(path: string) {
  const db = createUiDb(path), writer = openSqliteWriter(db), writes = createGovernanceWrites(db, writer);
  return { db, writer, writes, async close() { await writer.close(); db.close(); } };
}
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-safety-containment-")); roots.push(root);
  const path = join(root, "ui.db");
  return { path, ...open(path) };
}
type F = ReturnType<typeof fixture>;
/** A first turn that creates `sessionId`, with complete collection. */
async function chat(f: F, turnId: string, sessionId: string) {
  const bindingId = crypto.randomUUID();
  await f.writes.safetyBegin({ turnId, bindingId, sessionId: null, principalId: "odysseus", backendId: "pi", at: 0 });
  f.db.query("INSERT INTO sessions(id,created_at,last_active_at) VALUES(?,0,0)").run(sessionId);
  f.db.query("INSERT INTO chat_session_owners VALUES(?,'odysseus',0)").run(sessionId);
  safetyCatalogCreated(f.db, sessionId, "odysseus", turnId); await f.writes.bind(turnId, sessionId);
  const controller = new AbortController();
  const collector = createSafetyCollector(f.db, f.writes, { turnId, bindingId, sessionId: () => sessionId, backendId: "pi",
    shellProxied: () => false, signal: controller.signal, stop: () => controller.abort() });
  await collector.ready("pi", 1);
  return { bindingId, collector, controller };
}
/** A later turn in an existing chat, as turn admission begins it. */
async function next(f: F, turnId: string, sessionId: string | null) {
  await f.writes.safetyBegin({ turnId, bindingId: crypto.randomUUID(), sessionId, principalId: "odysseus", backendId: "pi", at: 1 });
  await f.writes.safetyReady(turnId, "pi", 1);
}
const failed = (f: F) => (f.db.query("SELECT failed FROM safety_meta").get() as { failed: number }).failed;
function captureStderr() {
  const lines: string[] = [], descriptor = Object.getOwnPropertyDescriptor(process.stderr, "write")!;
  Object.defineProperty(process.stderr, "write", { ...descriptor, value: (chunk: string | Uint8Array) => { lines.push(String(chunk)); return true; } });
  return { lines: () => lines.flatMap(l => l.split("\n")).filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return { raw: l }; } }),
    restore: () => Object.defineProperty(process.stderr, "write", descriptor) };
}
async function until(check: () => boolean, ms = 10000) {
  const end = Date.now() + ms;
  while (!check()) { if (Date.now() > end) throw new Error("condition not reached"); await Bun.sleep(25); }
}

test("a failed safetyBegin refuses only that turn: the same chat and another chat still run", async () => {
  const f = fixture(); try {
    await chat(f, "voyage", "ithaca");
    f.db.exec("CREATE TRIGGER break_begin BEFORE INSERT ON safety_collections WHEN NEW.turn_id='storm' BEGIN SELECT RAISE(ABORT,'forced begin failure'); END");
    const refused = await f.writes.safetyBegin({ turnId: "storm", bindingId: crypto.randomUUID(), sessionId: "ithaca", principalId: "odysseus", backendId: "pi", at: 1 })
      .then(() => null, error => error);
    expect(refused, "SAFETY_BEGIN_FAILURE_IS_A_RETRYABLE_REFUSAL").toBeInstanceOf(SafetyRecordingUnavailable);
    expect((refused as SafetyRecordingUnavailable).paused).toBe(false);
    expect(failed(f), "SAFETY_BEGIN_FAILURE_NEVER_LATCHES_THE_BRAIN").toBe(0);
    await next(f, "homecoming", "ithaca");
    expect(f.writes.recordingAvailable("homecoming", "ithaca"), "SAFETY_BEGIN_FAILURE_LEAVES_ITS_CHAT_USABLE").toBe(true);
    expect(f.writes.safety("homecoming", "ithaca").restriction).toBe("normal");
    await next(f, "siege", null);
    expect(f.writes.recordingAvailable("siege", null), "SAFETY_BEGIN_FAILURE_LEAVES_OTHER_CHATS_USABLE").toBe(true);
  } finally { await f.close(); }
});

test("a lost post-delivery occurrence restricts its chat permanently and leaves another chat normal", async () => {
  const f = fixture(); try {
    await chat(f, "voyage", "ithaca"); await chat(f, "siege", "troy");
    await f.writes.safetyFail("voyage", new Error("exposure transition lost after delivery"));
    expect(failed(f), "SAFETY_CHAT_LOSS_NEVER_LATCHES_THE_BRAIN").toBe(0);
    expect(f.writes.recordingAvailable("voyage", "ithaca"), "SAFETY_LOSS_STOPS_ITS_PRODUCER").toBe(false);
    expect(f.writes.recordingAvailable("siege", "troy"), "SAFETY_LOSS_LEAVES_OTHER_CHAT_PRODUCERS").toBe(true);
    await f.writes.safetyEnd("voyage"); await f.writes.safetyEnd("siege");
    const lost = f.writes.safety(null, "ithaca");
    expect(lost.restriction, "SAFETY_LOSS_RESTRICTS_ITS_CHAT").toBe("restricted");
    expect(lost.coverage.state).toBe("incomplete");
    expect(lost.coverage.epochs.find(e => e.reason === "recording_failed"), "SAFETY_LOSS_GAP_PROJECTS_AS_RECORDING_FAILED").toBeDefined();
    expect(f.writes.safety(null, "troy").restriction, "SAFETY_LOSS_LEAVES_OTHER_CHAT_NORMAL").toBe("normal");
    await next(f, "homecoming", "ithaca"); await next(f, "wooden-horse", "troy");
    expect(f.writes.recordingAvailable("homecoming", "ithaca"), "SAFETY_LOSS_CHAT_RUNS_RESTRICTED_NOT_REFUSED").toBe(true);
    expect(f.writes.safety("homecoming", "ithaca").restriction, "SAFETY_LOSS_GAP_IS_PERMANENT").toBe("restricted");
    expect(f.writes.safety("wooden-horse", "troy").restriction).toBe("normal");
    const cause = JSON.parse((f.db.query("SELECT failure_cause FROM safety_collections WHERE turn_id='voyage'").get() as { failure_cause: string }).failure_cause);
    expect(cause, "SAFETY_CHAT_FAILURE_KEEPS_ITS_CAUSE").toMatchObject({ site: "safetyFail", turnId: "voyage", message: "exposure transition lost after delivery" });
  } finally { await f.close(); }
});

test("an unwritable evidence store restricts the brain, new turns run restricted, and it clears itself", async () => {
  const f = fixture(); const log = captureStderr(); try {
    const voyage = await chat(f, "voyage", "ithaca");
    // Nothing the loss notice needs can commit: not the chat fact, not the
    // brain latch, not any evidence.
    f.db.exec(`CREATE TRIGGER no_chat_fact BEFORE UPDATE OF failure ON safety_collections BEGIN SELECT RAISE(ABORT,'disk I/O error'); END;
      CREATE TRIGGER no_brain_fact BEFORE UPDATE OF failed ON safety_meta WHEN NEW.failed=1 BEGIN SELECT RAISE(ABORT,'disk I/O error'); END;
      CREATE TRIGGER no_evidence BEFORE INSERT ON safety_records BEGIN SELECT RAISE(ABORT,'disk I/O error'); END;`);
    expect(await f.writes.safetyFail("voyage", new Error("lost")).then(() => "committed", () => "refused")).toBe("refused");
    expect(f.writes.recordingStatus(), "SAFETY_UNRECORDED_LOSS_RESTRICTS_THE_BRAIN").toMatchObject({ latched: true, retained: true });
    expect(f.writes.recordingAvailable("voyage", "ithaca")).toBe(false);
    // A new chat still starts: restricted, never refused.
    await next(f, "siege", null);
    expect(f.writes.recordingAvailable("siege", null), "SAFETY_BRAIN_RESTRICTION_RUNS_NEW_TURNS").toBe(true);
    expect(f.writes.safety("siege", null).restriction, "SAFETY_BRAIN_RESTRICTION_USES_TAINTED_POLICY").toBe("restricted");
    expect(f.writes.taint("siege", null), "SAFETY_BRAIN_RESTRICTION_TAINTS_NEW_TURNS").not.toBeNull();
    // Its own evidence cannot be written either; its permanent gap covers that.
    expect(await f.writes.firstTaint({ kind: "taint", turnId: "siege", sessionId: null, actor: "interactive", model: null, profile: null,
      payload: { source: "web_fetch", tool: "WebFetch", detail: null } }), "SAFETY_RESTRICTED_TURN_SURVIVES_UNWRITABLE_EVIDENCE").toBe(false);
    voyage.controller.abort();
    f.db.exec("DROP TRIGGER no_chat_fact; DROP TRIGGER no_brain_fact; DROP TRIGGER no_evidence;");
    await f.writes.safetyEnd("voyage");
    await until(() => !f.writes.recordingStatus().latched);
    expect(failed(f)).toBe(0);
    const gaps = Object.fromEntries((f.db.query("SELECT turn_id,gap FROM safety_collections WHERE turn_id IN ('voyage','siege')").all() as { turn_id: string; gap: string }[]).map(r => [r.turn_id, r.gap]));
    expect(gaps, "SAFETY_AUTOMATIC_RECOVERY_KEEPS_AFFECTED_GAPS").toEqual({ voyage: "recording_failed_recovered", siege: "recording_failed" });
    expect(f.writes.safety(null, "ithaca").restriction).toBe("restricted");
    await next(f, "homecoming", null);
    expect(f.writes.safety("homecoming", null).restriction, "SAFETY_AUTOMATIC_RECOVERY_RESTORES_NORMAL_NEW_CHATS").toBe("normal");
    const audit = f.db.query("SELECT trigger,actor,scope,cause,gapped,at FROM safety_recoveries").all() as { trigger: string; scope: string; cause: string; at: number }[];
    expect(audit.length, "SAFETY_AUTOMATIC_RECOVERY_IS_AUDITED").toBe(1);
    expect(audit[0]).toMatchObject({ trigger: "automatic", actor: "host", scope: "brain" });
    expect(audit[0]!.at).toBeGreaterThan(0);
    expect(JSON.parse(audit[0]!.cause), "SAFETY_RETAINED_LOSS_KEEPS_ITS_ORIGINAL_CAUSE").toMatchObject({ site: "retained", turnId: "voyage", errorClass: "Error",
      message: expect.stringContaining("lost") });
    expect(log.lines().filter(l => l.body === "safety recording recovered for the brain").length, "SAFETY_AUTOMATIC_RECOVERY_LOGS_ONE_LINE").toBe(1);
  } finally { log.restore(); await f.close(); }
});

test("a durable brain latch keeps its first cause, counts later ones and clears without a restart", async () => {
  const f = fixture(); const log = captureStderr(); try {
    await chat(f, "voyage", "ithaca");
    // The chat fact fails; the emergency reserve takes the brain latch.
    f.db.exec("CREATE TRIGGER no_chat_fact BEFORE UPDATE OF failure_cause ON safety_collections WHEN NEW.turn_id='voyage' AND (SELECT failed FROM safety_meta)=0 BEGIN SELECT RAISE(ABORT,'database or disk is full'); END");
    await f.writes.safetyFail("voyage", new TypeError("ledger write failed"));
    expect(failed(f), "SAFETY_UNWRITABLE_CHAT_FACT_LATCHES_THE_BRAIN").toBe(1);
    const first = f.db.query("SELECT * FROM safety_latch").get() as Record<string, unknown>;
    expect(first, "SAFETY_LATCH_KEEPS_ITS_FIRST_CAUSE").toMatchObject({ reason: "recording_failed", site: "safetyFail", turn_id: "voyage", error_class: "TypeError", count: 1 });
    expect(String(first.message)).toContain("ledger write failed");
    expect(first.since).toBeGreaterThan(0);
    // The worker's latch logs on its own thread; this one runs here.
    const before = log.lines().length;
    latchSafety(f.db, null, "capacity", safetyFailureCause(new SafetyCapacityExhausted("Safety ledger capacity exhausted", "brain"), "record", null));
    expect(f.db.query("SELECT site,turn_id,error_class,count FROM safety_latch").get(), "SAFETY_LATER_LATCH_ONLY_COUNTS")
      .toEqual({ site: "safetyFail", turn_id: "voyage", error_class: "TypeError", count: 2 });
    const latches = log.lines().slice(before);
    expect(latches.length, "SAFETY_EACH_LATCH_LOGS_ONE_LINE").toBe(1);
    expect(latches[0]).toMatchObject({ body: "safety recording latched for the brain",
      attributes: { "safety.site": "record", "safety.reason": "capacity", "error.message": "Safety ledger capacity exhausted" } });
    const status = f.writes.recordingStatus();
    expect(status, "SAFETY_STATUS_REPORTS_THE_LATCH").toMatchObject({ latched: true, reason: "capacity", cause: { site: "safetyFail", turnId: "voyage", count: 2, durable: true } });
    expect(status.since).toBe(first.since as number);
    // New turns run restricted while the brain is latched.
    await next(f, "siege", null);
    expect(f.writes.recordingAvailable("siege", null)).toBe(true);
    f.db.exec("DROP TRIGGER no_chat_fact");
    await f.writes.safetyEnd("voyage");
    await until(() => failed(f) === 0);
    expect(f.writes.recordingStatus()).toMatchObject({ latched: false, cause: null, lastRecovery: { trigger: "automatic", cause: { site: "safetyFail", count: 2 } } });
    expect(f.db.query("SELECT COUNT(*) n FROM safety_latch").get()).toEqual({ n: 0 });
  } finally { log.restore(); await f.close(); }
});

test("the incident state boots, recovers automatically and admits turns", async () => {
  const f = fixture();
  await chat(f, "voyage", "ithaca"); await f.writes.safetyEnd("voyage");
  // Exactly the incident: failed=1, reason='capacity', no pending rows, no open collections.
  f.db.exec(`UPDATE safety_meta SET failed=1,reason='capacity'; UPDATE safety_collections SET failure='capacity',gap='host_restart_unknown' WHERE turn_id='voyage'`);
  expect(f.db.query("SELECT (SELECT COUNT(*) FROM safety_pending) pending,(SELECT COUNT(*) FROM safety_collections WHERE ended=0) open").get()).toEqual({ pending: 0, open: 0 });
  await f.close();
  const g = open(f.path); try {
    expect((g.db.query("SELECT failed FROM safety_meta").get() as { failed: number }).failed, "SAFETY_INCIDENT_STATE_RECOVERS_AT_BOOT").toBe(0);
    expect(g.db.query("SELECT trigger,actor FROM safety_recoveries").all()).toEqual([{ trigger: "boot", actor: "host" }]);
    await g.writes.safetyBegin({ turnId: "homecoming", bindingId: crypto.randomUUID(), sessionId: "ithaca", principalId: "odysseus", backendId: "pi", at: 2 });
    await g.writes.safetyReady("homecoming", "pi", 1);
    expect(g.writes.recordingAvailable("homecoming", "ithaca"), "SAFETY_INCIDENT_STATE_ADMITS_TURNS_AFTER_BOOT").toBe(true);
    expect(g.writes.safety("homecoming", "ithaca").restriction, "SAFETY_INCIDENT_CHAT_KEEPS_ITS_GAP").toBe("restricted");
  } finally { await g.close(); }
});

test("a turn is refused outright only when even its restricted begin cannot commit", async () => {
  const f = fixture(); try {
    await chat(f, "voyage", "ithaca");
    latchSafety(f.db, "voyage", "recording_failed", safetyFailureCause(new Error("disk I/O error"), "safetyCommit", "voyage"));
    f.db.exec("CREATE TRIGGER no_collections BEFORE INSERT ON safety_collections BEGIN SELECT RAISE(ABORT,'disk I/O error'); END");
    const refused = await f.writes.safetyBegin({ turnId: "siege", bindingId: crypto.randomUUID(), sessionId: null, principalId: "odysseus", backendId: "pi", at: 1 })
      .then(() => null, error => error);
    expect(refused, "SAFETY_UNENFORCEABLE_RESTRICTION_REFUSES").toBeInstanceOf(SafetyRecordingUnavailable);
    expect((refused as SafetyRecordingUnavailable).paused, "SAFETY_PAUSED_REFUSAL_IS_DISTINCT").toBe(true);
    const frames: unknown[] = [], failures: unknown[] = [];
    emitTurnError({ sendToClients: (frame: unknown) => frames.push(frame), reportTurnFailed: (...args: unknown[]) => failures.push(args) } as never,
      { requestId: "request-siege", turnId: "siege", sessionId: undefined } as never, refused);
    expect(frames[0], "SAFETY_REFUSAL_HAS_A_DEDICATED_ERROR_CODE").toMatchObject({ type: "error", code: "SAFETY_RECORDING_UNAVAILABLE", requestId: "request-siege",
      failure: { errorClass: "safety_recording_paused" } });
    expect(failures[0]).toEqual(["SAFETY_RECORDING_UNAVAILABLE", expect.anything(), refused.message]);
  } finally { await f.close(); }
});

test("a refused reservation before delivery stops only the turn; its chat keeps no gap", async () => {
  const f = fixture(); try {
    const voyage = await chat(f, "voyage", "ithaca");
    f.db.exec("CREATE TRIGGER no_reservation BEFORE INSERT ON safety_pending BEGIN SELECT RAISE(ABORT,'forced reservation failure'); END");
    const refused = await voyage.collector.begin("scout", "WebFetch", { url: "https://ithaca.invalid/" }).then(() => null, error => error);
    expect(refused, "SAFETY_PRE_DELIVERY_RESERVATION_IS_RETRYABLE").toBeInstanceOf(SafetyRecordingUnavailable);
    expect(voyage.controller.signal.aborted, "SAFETY_PRE_DELIVERY_RESERVATION_STOPS_THE_TURN").toBe(true);
    expect(f.db.query("SELECT failure FROM safety_collections WHERE turn_id='voyage'").get(), "SAFETY_PRE_DELIVERY_RESERVATION_KEEPS_NO_GAP").toEqual({ failure: null });
    expect(failed(f)).toBe(0);
    f.db.exec("DROP TRIGGER no_reservation");
    await f.writes.safetyEnd("voyage"); await next(f, "homecoming", "ithaca");
    expect(f.writes.safety("homecoming", "ithaca").restriction).toBe("normal");
  } finally { await f.close(); }
});

test("owner recovery clears an idle latch, refuses while a producer is open, and records who did it", async () => {
  const f = fixture(); try {
    await chat(f, "voyage", "ithaca");
    latchSafety(f.db, "voyage", "recording_failed", safetyFailureCause(new Error("disk I/O error"), "safetyCommit", "voyage"));
    // The reconciler would race this test; the owner route is the fallback under test.
    expect(() => f.writes.recoverRecording("penelope"), "SAFETY_OWNER_RECOVERY_REFUSES_WITH_OPEN_PRODUCER").toThrow("Stop all safety producers");
    expect(failed(f), "SAFETY_REFUSED_RECOVERY_CHANGES_NOTHING").toBe(1);
    expect(f.db.query("SELECT COUNT(*) n FROM safety_recoveries").get()).toEqual({ n: 0 });
    await f.writes.safetyEnd("voyage");
    const recovery = f.writes.recoverRecording("penelope");
    expect(recovery, "SAFETY_OWNER_RECOVERY_RECORDS_ACTOR_AND_CAUSE").toMatchObject({ recovered: true, trigger: "owner", actor: "penelope", cause: { site: "safetyCommit", turnId: "voyage" } });
    expect(f.db.query("SELECT trigger,actor FROM safety_recoveries").get()).toEqual({ trigger: "owner", actor: "penelope" });
    await next(f, "siege", null);
    expect(f.writes.recordingAvailable("siege", null), "SAFETY_OWNER_RECOVERY_ADMITS_TURNS_WITHOUT_RESTART").toBe(true);
    expect(f.writes.safety("siege", null).restriction).toBe("normal");
  } finally { await f.close(); }
});

test("only a capacity check classifies a failure as capacity", () => {
  expect(safetyFailureReason(new SafetyCapacityExhausted("Safety pending capacity exhausted", "turn"))).toBe("capacity");
  for (const error of [new Error("SQLITE_IOERR"), new TypeError("bug"), new SafetyUnavailable("Invalid bounded safety identity")])
    expect(safetyFailureReason(error), "SAFETY_NON_CAPACITY_ERRORS_ARE_RECORDING_FAILED").toBe("recording_failed");
});

test("a non-capacity reservation error marks its chat recording_failed, not capacity", async () => {
  const f = fixture(); try {
    await chat(f, "voyage", "ithaca");
    f.db.exec("CREATE TRIGGER no_reservation BEFORE INSERT ON safety_pending BEGIN SELECT RAISE(ABORT,'forced reservation failure'); END");
    // A producer that does not hold its input: the reservation may follow delivery.
    await f.writes.firstTaint({ kind: "taint", turnId: "voyage", sessionId: "ithaca", actor: "interactive", model: null, profile: null,
      payload: { source: "web_fetch", tool: "WebFetch", detail: null } }).catch(() => {});
    expect(f.db.query("SELECT failure FROM safety_collections WHERE turn_id='voyage'").get(), "SAFETY_RESERVE_ERROR_IS_RECORDING_FAILED").toEqual({ failure: "recording_failed" });
    expect(f.db.query("SELECT failed,reason FROM safety_meta").get()).toEqual({ failed: 0, reason: null });
  } finally { await f.close(); }
});

test("a legacy row that cannot migrate gaps its own turn instead of latching capacity", async () => {
  const f = fixture();
  await chat(f, "voyage", "ithaca");
  await f.writes.safetyEnd("voyage");
  f.db.query(`INSERT INTO governance_events(session_id,turn_id,at,kind,payload,schema_version,actor,model,profile,dedupe_key)
    VALUES('ithaca','legacy-turn',0,'taint',?,1,'interactive',NULL,NULL,NULL)`).run(JSON.stringify({ source: "web_fetch", tool: "WebFetch", detail: null }));
  f.db.exec("CREATE TRIGGER no_legacy_record BEFORE INSERT ON safety_records BEGIN SELECT RAISE(ABORT,'forced migration failure'); END");
  await f.close();
  const g = open(f.path); try {
    expect(g.db.query("SELECT failed FROM safety_meta").get(), "SAFETY_MIGRATION_FAILURE_NEVER_LATCHES_CAPACITY").toEqual({ failed: 0 });
    const row = g.db.query("SELECT failure,ended,failure_cause FROM safety_collections WHERE turn_id='legacy-turn'").get() as { failure: string; ended: number; failure_cause: string };
    expect(row.failure, "SAFETY_MIGRATION_FAILURE_IS_RECORDING_FAILED").toBe("recording_failed");
    expect(JSON.parse(row.failure_cause)).toMatchObject({ site: "migrate", message: "forced migration failure" });
    expect(g.writes.safety(null, "ithaca").restriction, "SAFETY_MIGRATION_FAILURE_RESTRICTS_ITS_CHAT").toBe("restricted");
  } finally { await g.close(); }
});

test("the status route shows the recorder to the owner only, and recovery requires the owner", async () => {
  const { createStatusRoutes } = await import("../src/routes/health");
  const { Hono } = await import("hono");
  const recovered: string[] = [];
  const latched = { latched: true, since: 7, reason: "recording_failed", cause: null, retained: false, lastRecovery: null };
  const app = (kind?: string) => new Hono<never>().use(async (c, nextHandler) => { if (kind) (c as unknown as { set(k: string, v: unknown): void }).set("principal", { id: `${kind}-id`, kind }); await nextHandler(); })
    .route("/api", createStatusRoutes({ sourceCommit: "dev", getCronStatus: () => [], isTurnActive: () => false,
      getSafetyRecording: () => latched as never, recoverSafetyRecording: actor => { recovered.push(actor); return { recovered: true } as never; } }) as never);
  expect((await (await app("owner").request("/api/status")).json()).safetyRecording, "SAFETY_STATUS_VISIBLE_TO_OWNER").toEqual(latched);
  for (const kind of ["delegate", undefined])
    expect((await (await app(kind).request("/api/status")).json()).safetyRecording, "SAFETY_STATUS_HIDDEN_FROM_OTHERS").toBeUndefined();
  const post = (kind?: string) => app(kind).request("/api/status/safety-recording/recover", { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
  expect((await post("delegate")).status, "SAFETY_RECOVERY_REQUIRES_OWNER").toBe(403);
  expect((await post("owner")).status).toBe(200);
  expect(recovered).toEqual(["owner-id"]);
});

test("automatic recovery waits for an uncovered producer to drain", async () => {
  const f = fixture(); try {
    await chat(f, "voyage", "ithaca");
    latchSafety(f.db, null, "recording_failed", safetyFailureCause(new Error("disk I/O error"), "record", null));
    expect(attemptSafetyRecovery(f.db), "SAFETY_AUTOMATIC_RECOVERY_WAITS_FOR_UNCOVERED_PRODUCERS").toBe(false);
    expect(failed(f)).toBe(1);
    await f.writes.safetyEnd("voyage");
    expect(attemptSafetyRecovery(f.db)).toBe(true);
    expect(failed(f)).toBe(0);
  } finally { await f.close(); }
});

const occurrence = (turnId: string | null, sessionId: string | null) => ({ kind: "taint" as const, turnId, sessionId, actor: "interactive" as const,
  model: null, profile: null, payload: { source: "web_fetch" as const, tool: "WebFetch", detail: null } });

test("a producer refused under a brain latch still leaves its own chat a durable gap", async () => {
  const f = fixture(); try {
    await chat(f, "voyage", "ithaca");
    latchSafety(f.db, null, "recording_failed", safetyFailureCause(new Error("disk I/O error"), "record", null));
    // Not a producer that holds its input: what it refuses may already be delivered.
    expect(() => f.writes.firstTaint(occurrence("voyage", "ithaca"))).toThrow("requires recovery");
    await until(() => !!(f.db.query("SELECT failure FROM safety_collections WHERE turn_id='voyage'").get() as { failure: string | null }).failure);
    await f.writes.safetyEnd("voyage");
    expect(attemptSafetyRecovery(f.db)).toBe(true);
    expect(f.writes.safety(null, "ithaca").restriction, "SAFETY_REFUSED_PRODUCER_UNDER_LATCH_KEEPS_ITS_GAP").toBe("restricted");
  } finally { await f.close(); }
});

test("a loss with no collection is kept on its named chat, or gaps every chat when none is named", async () => {
  const f = fixture(); try {
    await chat(f, "voyage", "ithaca"); await f.writes.safetyEnd("voyage");
    await chat(f, "siege", "troy"); await f.writes.safetyEnd("siege");
    // The compatibility producer's own collection cannot be created.
    f.db.exec("CREATE TRIGGER no_unbound BEFORE INSERT ON safety_collections WHEN NEW.turn_id LIKE 'unbound_%' BEGIN SELECT RAISE(ABORT,'forced compatibility failure'); END");
    await f.writes.firstTaint(occurrence(null, "ithaca")).catch(() => {});
    expect(failed(f), "SAFETY_SESSION_LOSS_NEVER_LATCHES_THE_BRAIN").toBe(0);
    expect(f.writes.safety(null, "ithaca").restriction, "SAFETY_SESSION_LOSS_GAPS_ITS_NAMED_CHAT").toBe("restricted");
    expect(f.writes.safety(null, "troy").restriction).toBe("normal");
    await f.writes.firstTaint(occurrence(null, null)).catch(() => {});
    expect(f.db.query("SELECT unscoped FROM safety_latch").get(), "SAFETY_UNNAMED_LOSS_IS_DURABLY_UNSCOPED").toEqual({ unscoped: 1 });
    f.db.exec("DROP TRIGGER no_unbound");
    // Recovery from a fresh process, which retains nothing in memory.
    await f.close();
    const g = open(f.path); try {
      expect((g.db.query("SELECT failed FROM safety_meta").get() as { failed: number }).failed).toBe(0);
      expect(g.writes.safety(null, "troy").restriction, "SAFETY_UNSCOPED_RECOVERY_GAPS_EVERY_CHAT").toBe("restricted");
    } finally { await g.close(); }
  } catch (error) { await f.close().catch(() => {}); throw error; }
});

test("a capacity cause passed through the write worker stays capacity", async () => {
  const f = fixture(); try {
    await chat(f, "voyage", "ithaca");
    await f.writes.safetyFail("voyage", new SafetyCapacityExhausted("Safety occurrence write capacity exceeded", "turn"));
    expect(f.db.query("SELECT failure FROM safety_collections WHERE turn_id='voyage'").get(), "SAFETY_CAPACITY_SURVIVES_THE_WORKER").toEqual({ failure: "capacity" });
  } finally { await f.close(); }
});

/** Neither the chat fact nor the brain latch can commit: only this process holds the loss. */
function refuseLossNotices(f: F) {
  f.db.exec(`CREATE TRIGGER no_chat_fact BEFORE UPDATE OF failure ON safety_collections BEGIN SELECT RAISE(ABORT,'disk I/O error'); END;
    CREATE TRIGGER no_brain_fact BEFORE UPDATE OF failed ON safety_meta WHEN NEW.failed=1 BEGIN SELECT RAISE(ABORT,'disk I/O error'); END;`);
}

for (const loss of ["retained", "durable"] as const) test(`automatic recovery waits for every producer that predates the latch, even a failed one: ${loss}`, async () => {
  const f = fixture(); try {
    await chat(f, "voyage", "ithaca");
    holdSafetyRecovery(f.db);
    if (loss === "retained") {
      // Only this process holds the producer's loss; writes then work again.
      refuseLossNotices(f);
      await f.writes.safetyFail("voyage", new Error("exposure transition lost")).catch(() => {});
      f.db.exec("DROP TRIGGER no_chat_fact; DROP TRIGGER no_brain_fact");
    } else {
      // Its chat holds the loss durably, and something else latched the brain.
      await f.writes.safetyFail("voyage", new Error("exposure transition lost"));
      latchSafety(f.db, null, "recording_failed", safetyFailureCause(new Error("disk I/O error"), "record", null));
    }
    // The failed producer is still running.
    expect(f.db.query("SELECT ended FROM safety_collections WHERE turn_id='voyage'").get()).toEqual({ ended: 0 });
    expect(attemptSafetyRecovery(f.db), "SAFETY_AUTOMATIC_RECOVERY_DRAINS_FAILED_PRODUCERS").toBe(false);
    expect(f.writes.recordingStatus().latched, "SAFETY_UNDRAINED_RECOVERY_KEEPS_THE_LATCH").toBe(true);
    // A turn begun under the latch never holds recovery back.
    await next(f, "siege", null);
    await f.writes.safetyEnd("voyage");
    expect(attemptSafetyRecovery(f.db), "SAFETY_AUTOMATIC_RECOVERY_RUNS_BESIDE_RESTRICTED_TURNS").toBe(true);
    expect(f.writes.recordingStatus().latched).toBe(false);
    expect(f.writes.safety(null, "ithaca").restriction, "SAFETY_DRAINED_RECOVERY_KEEPS_THE_GAP").toBe("restricted");
  } finally { await f.close(); }
});

for (const loss of ["retained", "durable"] as const) test(`a turn begun restricted under an earlier latch drains before a later latch clears: ${loss}`, async () => {
  const f = fixture(); try {
    holdSafetyRecovery(f.db);
    latchSafety(f.db, null, "recording_failed", safetyFailureCause(new Error("the first storm"), "record", null));
    // Begun restricted under the first latch, and still sailing when it clears.
    await next(f, "still-sailing", null);
    expect(attemptSafetyRecovery(f.db), "SAFETY_LATCH_CLEARS_BESIDE_ITS_OWN_RESTRICTED_TURN").toBe(true);
    expect(f.writes.recordingStatus().latched).toBe(false);
    // A second latch while that turn is still open: it predates this one.
    if (loss === "retained") {
      refuseLossNotices(f);
      await f.writes.safetyFail(null as never, new Error("the second storm")).catch(() => {});
      f.db.exec("DROP TRIGGER no_chat_fact; DROP TRIGGER no_brain_fact");
    } else latchSafety(f.db, null, "recording_failed", safetyFailureCause(new Error("the second storm"), "record", null));
    expect(f.writes.recordingStatus().latched).toBe(true);
    expect(f.db.query("SELECT ended FROM safety_collections WHERE turn_id='still-sailing'").get()).toEqual({ ended: 0 });
    expect(attemptSafetyRecovery(f.db), "SAFETY_LATER_LATCH_DRAINS_AN_EARLIER_RESTRICTED_TURN").toBe(false);
    expect(f.writes.recordingStatus().latched, "SAFETY_UNDRAINED_LATER_LATCH_STAYS_SET").toBe(true);
    // A turn begun under the second latch never holds it back.
    await next(f, "new-voyage", null);
    await f.writes.safetyEnd("still-sailing");
    expect(attemptSafetyRecovery(f.db), "SAFETY_LATER_LATCH_CLEARS_BESIDE_ITS_OWN_RESTRICTED_TURN").toBe(true);
    expect(f.writes.recordingStatus().latched).toBe(false);
    // Neither restricted turn's gap is cleared.
    expect(f.db.query("SELECT turn_id,gap FROM safety_collections WHERE turn_id IN ('still-sailing','new-voyage') ORDER BY turn_id").all())
      .toEqual([{ turn_id: "new-voyage", gap: "recording_failed" }, { turn_id: "still-sailing", gap: "recording_failed" }]);
  } finally { await f.close(); }
});

test("status shows the cause this process holds while its loss notice cannot commit", async () => {
  const f = fixture(); try {
    await chat(f, "voyage", "ithaca");
    holdSafetyRecovery(f.db);
    refuseLossNotices(f);
    await f.writes.safetyFail("voyage", new TypeError("exposure transition lost")).catch(() => {});
    const status = f.writes.recordingStatus();
    expect(status).toMatchObject({ latched: true, retained: true });
    expect(status.cause, "SAFETY_STATUS_SHOWS_THE_RETAINED_CAUSE").toMatchObject({ errorClass: "TypeError", message: "exposure transition lost",
      turnId: "voyage", count: 1, durable: false });
    expect(status.since, "SAFETY_STATUS_DATES_THE_RETAINED_CAUSE").toBe(status.cause!.since);
    expect(status.since).toBeGreaterThan(0);
  } finally { await f.close(); }
});

test("spent safety room says what to do instead of asking for a retry", async () => {
  const f = fixture(); try {
    const { bindingId } = await chat(f, "voyage", "ithaca"); await f.writes.safetyEnd("voyage");
    // The chat has used all 128 of its coverage epochs; nothing frees them.
    f.db.query(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<127)
      INSERT INTO safety_collections(id,turn_id,session_id,history_owner_id,generation,backend_id,started_at,ended,acknowledged,start_revision,end_revision)
      SELECT 'epoch_'||x,'turn_'||x,session_id,history_owner_id,generation,'pi',0,1,acknowledged,'0','0' FROM n,safety_collections WHERE id=?`).run(bindingId);
    const refuse = async (turnId: string, sessionId: string | null) => {
      const refused = await f.writes.safetyBegin({ turnId, bindingId: crypto.randomUUID(), sessionId, principalId: "odysseus", backendId: "pi", at: 1 })
        .then(() => null, error => error) as SafetyRecordingUnavailable;
      const frames: { code: string; failure: { errorClass: string; message: string } }[] = [];
      emitTurnError({ sendToClients: (frame: never) => frames.push(frame), reportTurnFailed() {} } as never, { turnId, requestId: `request-${turnId}` } as never, refused);
      return { refused, frame: frames[0]! };
    };
    for (const turnId of ["homecoming", "homecoming-again"]) {
      const { refused, frame } = await refuse(turnId, "ithaca");
      expect(refused.full, "SAFETY_EPOCH_CEILING_IS_A_FULL_CHAT").toBe("chat");
      expect(frame.failure.errorClass).toBe("safety_recording_chat_full");
      expect(refusalReason(frame), "SAFETY_FULL_CHAT_SAYS_START_A_NEW_CHAT").toBe("This chat has no room left for safety records. Nothing was sent; start a new chat to continue.");
      expect(failurePresentation(frame.failure as never), "SAFETY_FULL_CHAT_IS_NOT_RETRYABLE").toMatchObject({ retry: false, explanation: "Nothing was sent. Start a new chat to continue." });
    }
    // A new chat still starts.
    await next(f, "siege", null);
    expect(f.writes.recordingAvailable("siege", null), "SAFETY_FULL_CHAT_LEAVES_NEW_CHATS").toBe(true);
    await f.writes.safetyEnd("siege");
    // The brain's room for first turns not yet in a chat is spent: a new chat cannot help.
    f.db.query(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1024)
      INSERT INTO safety_collections(id,turn_id,session_id,history_owner_id,generation,backend_id,started_at,ended,acknowledged,start_revision,end_revision)
      SELECT 'unbound_'||x,'unbound_turn_'||x,NULL,NULL,'1','pi',0,1,'[]','0','0' FROM n`).run();
    const { refused, frame } = await refuse("wooden-horse", null);
    expect(refused.full, "SAFETY_UNBOUND_CEILING_IS_A_FULL_BRAIN").toBe("brain");
    expect(frame.failure.errorClass).toBe("safety_recording_brain_full");
    expect(refusalReason(frame), "SAFETY_FULL_BRAIN_SAYS_RETRY_WONT_HELP").toBe("This server has no room left for safety records. Nothing was sent, and retrying won't help.");
    expect(failurePresentation(frame.failure as never), "SAFETY_FULL_BRAIN_IS_NOT_RETRYABLE").toMatchObject({ retry: false, report: true });
  } finally { await f.close(); }
});

test("room for turns not yet in a chat is spent for good only when nothing can free it", async () => {
  const f = fixture(); try {
    holdSafetyRecovery(f.db);
    // One first turn is still running, not yet in its chat.
    await next(f, "landfall", null);
    const fill = (from: number, to: number) => f.db.query(`WITH RECURSIVE n(x) AS (VALUES(${from}) UNION ALL SELECT x+1 FROM n WHERE x<${to})
      INSERT INTO safety_collections(id,turn_id,session_id,history_owner_id,generation,backend_id,started_at,ended,acknowledged,start_revision,end_revision)
      SELECT 'unbound_'||x,'unbound_turn_'||x,NULL,NULL,'1','pi',0,1,'[]','0','0' FROM n`).run();
    const begin = (turnId: string) => f.writes.safetyBegin({ turnId, bindingId: crypto.randomUUID(), sessionId: null, principalId: "odysseus", backendId: "pi", at: 1 })
      .then(() => null, error => error as SafetyRecordingUnavailable);
    // Ended unbound collections plus the running one fill the pool.
    fill(1, 1023);
    const waiting = await begin("waiting");
    expect(waiting, "SAFETY_UNBOUND_CEILING_REFUSES").toBeInstanceOf(SafetyRecordingUnavailable);
    expect(waiting, "SAFETY_UNBOUND_ROOM_A_RUNNING_TURN_FREES_IS_RETRYABLE").toMatchObject({ capacity: true, full: null });
    // That turn joins its chat; the same retry now starts, with no limit raised.
    f.db.exec("INSERT INTO sessions(id,created_at,last_active_at) VALUES('ithaca',0,0); INSERT INTO chat_session_owners VALUES('ithaca','odysseus',0)");
    safetyCatalogCreated(f.db, "ithaca", "odysseus", "landfall"); await f.writes.bind("landfall", "ithaca");
    expect(await begin("waiting"), "SAFETY_UNBOUND_RETRY_STARTS_ONCE_ROOM_FREES").toBeNull();
    // Once only ended unbound collections remain, retrying can never help.
    await f.writes.safetyEnd("waiting"); await f.writes.safetyEnd("landfall");
    fill(1024, 1025);
    expect(await begin("wooden-horse"), "SAFETY_UNBOUND_ROOM_NOTHING_FREES_IS_A_FULL_BRAIN").toMatchObject({ capacity: true, full: "brain" });
  } finally { await f.close(); }
});

test("unbound byte room a running first turn holds is retryable; ballast that ended is not", async () => {
  const f = fixture(); try {
    holdSafetyRecovery(f.db);
    await next(f, "landfall", null);
    const unbound = (turnId: string) => (f.db.query("SELECT id FROM safety_collections WHERE turn_id=?").get(turnId) as { id: string }).id;
    const ballast = (id: string, collection: string, bytes: number) => f.db.query(`INSERT INTO safety_records(id,collection_id,sequence,observed_at,kind,occurrence_id,
      source,detector,state,payload,bytes,reserved_rows,reserved_bytes,detail_pruned) VALUES(?,?,'ballast_'||?,0,'occurrence',?,NULL,NULL,'finalized','{}',2,0,?,0)`).run(id, collection, id, id, bytes);
    f.db.query(`INSERT INTO safety_collections(id,turn_id,session_id,history_owner_id,generation,backend_id,started_at,ended,acknowledged,start_revision,end_revision)
      VALUES('hold','hold_turn',NULL,NULL,'1','pi',0,1,'[]','0','0')`).run();
    // The running first turn's own records fill the unbound byte room.
    ballast("cargo", unbound("landfall"), 4194304); ballast("hold_cargo", "hold", 4190000);
    const begin = (turnId: string) => f.writes.safetyBegin({ turnId, bindingId: crypto.randomUUID(), sessionId: null, principalId: "odysseus", backendId: "pi", at: 1 })
      .then(() => null, error => error as SafetyRecordingUnavailable);
    expect(await begin("waiting"), "SAFETY_UNBOUND_BYTES_A_RUNNING_TURN_HOLDS_ARE_RETRYABLE").toMatchObject({ capacity: true, full: null });
    f.db.exec("INSERT INTO sessions(id,created_at,last_active_at) VALUES('ithaca',0,0); INSERT INTO chat_session_owners VALUES('ithaca','odysseus',0)");
    safetyCatalogCreated(f.db, "ithaca", "odysseus", "landfall"); await f.writes.bind("landfall", "ithaca");
    expect(await begin("waiting"), "SAFETY_UNBOUND_BYTE_RETRY_STARTS_ONCE_ROOM_FREES").toBeNull();
    // Ended ballast alone leaves no room: retrying can never help.
    await f.writes.safetyEnd("waiting");
    ballast("more_cargo", "hold", 8388608);
    expect(await begin("wooden-horse"), "SAFETY_ENDED_UNBOUND_BYTES_ARE_A_FULL_BRAIN").toMatchObject({ capacity: true, full: "brain" });
  } finally { await f.close(); }
});

test("room held only by pending writes stays a retryable refusal", () => {
  const refused = new SafetyRecordingUnavailable(false, new SafetyCapacityExhausted("Safety pending capacity exhausted", "turn"));
  expect(refused, "SAFETY_PENDING_ROOM_IS_RETRYABLE").toMatchObject({ capacity: true, full: null });
  // Across the write worker the class arrives as a name and its own fields.
  const revived = Object.assign(new Error("Safety coverage capacity exhausted"), { name: "SafetyCapacityExhausted", scope: "chat" });
  expect(new SafetyRecordingUnavailable(true, revived).full, "SAFETY_FULL_OUTRANKS_PAUSED").toBe("chat");
});
