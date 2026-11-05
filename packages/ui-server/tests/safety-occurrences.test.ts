import { expectRejection } from "./helpers/expect-rejection";
import { INGESTION_DETECTOR_MANIFEST } from "../src/activity/ingestion-taint";
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client";
import { openSqliteWriter } from "../src/db/write-worker";
import { createGovernanceWrites } from "../src/governance/event-writes";
import { occurrence } from "../src/governance/occurrence";
import { untrustedMarkOperations } from "../src/files/untrusted-marks";
import { recordGovernanceEvent } from "../src/governance/events";
import { createPrincipal } from "../src/db/principals";
import { retireChat } from "../src/ws/chat-lifecycle";
import * as probe from "./fixtures/write-worker-probe";
import { queryGovernanceEvents } from "../src/governance/events";
import { createActivityStore } from "../src/activity/store";
import { createTurnRecorder } from "../src/activity/recorder";

const meta = { sessionId: "ithaca", turnId: "voyage", actor: "interactive" as const, model: null, profile: "governed" as const };
const trigger = (key: string) => ({ ...meta, kind: "taint" as const, dedupeKey: key,
  payload: { source: "web_fetch" as const, tool: "WebFetch", detail: null } });

// Uses a real second SQLite connection and native write worker, then reopens
// the same WAL database. Later occurrences from one source remain independent.
test("later same-source occurrences survive concurrent worker submissions and restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-safety-")), path = join(root, "ui.db");
  let db = createUiDb(path), writer = openSqliteWriter(db);
  try {
    db.query("INSERT INTO sessions(id,created_at,last_active_at) VALUES ('ithaca',0,0)").run();
    const writes = createGovernanceWrites(db, writer);
    await Promise.all([writes.firstTaint(trigger("A")), writes.firstTaint(trigger("B")), writes.firstTaint(trigger("C"))]);
    await writes.firstTaint(trigger("C"));
    // Excluding A from this detail view must still leave independently named B/C.
    // This is collection proof, not a safe-decision/effective-projection test.
    const remaining = queryGovernanceEvents(db, { sessionId: "ithaca", kinds: ["taint"], limit: 100 }).slice(1);
    expect(remaining.length, "SAFETY_LATER_OCCURRENCES_RETAINED").toBe(2);
    await writer.close(); db.close();
    db = createUiDb(path); writer = openSqliteWriter(db);
    expect(queryGovernanceEvents(db, { sessionId: "ithaca", kinds: ["taint"], limit: 100 }), "SAFETY_RESTART_RETAINS_EVERY_OCCURRENCE").toHaveLength(3);
  } finally { await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("recorder retains input, every returned path and explicit marks independently", async () => {
  const db = createUiDb(":memory:");
  db.query("INSERT INTO sessions(id,created_at,last_active_at) VALUES ('ithaca',0,0)").run();
  const writes = createGovernanceWrites(db);
  untrustedMarkOperations(db).mark("workspaces/voyage/a.md", null, 0);
  untrustedMarkOperations(db).mark("notice.md", null, 0);
  const recorder = createTurnRecorder({ store: createActivityStore(db, { writer: "test" }), governanceDb: db,
    governanceWrites: writes, governance: event => writes.record(event), brainPath: "/srv/ithaca" },
  { turnId: "voyage", sessionId: "ithaca", profile: "governed" });
  try {
    recorder.observeFrame({ type: "tool_use_start", sessionId: "ithaca", toolUseId: "search", toolName: "Grep" });
    recorder.observeFrame({ type: "tool_use_complete", sessionId: "ithaca", toolUseId: "search", toolName: "Grep", input: { path: "workspaces", pattern: "Ithaca" } });
    recorder.observeFrame({ type: "tool_result", sessionId: "ithaca", toolUseId: "search", output: "workspaces/voyage/a.md:1: Ithaca\nworkspaces//voyage/a.md:2: Ithaca\n.brain-ui/inbox/notice.md:2: Ithaca\nnotice.md:1: Ithaca\n... results omitted", isError: false });
    await recorder.settled();
    expect(queryGovernanceEvents(db, { sessionId: "ithaca", kinds: ["taint"], limit: 100 }).map(e => e.payload.source), "SAFETY_INPUT_CANNOT_HIDE_OUTPUT").toEqual(["workspace_read", "workspace_read", "user_marked", "staged_share", "user_marked", "legacy_unknown"]);
    recorder.observeFrame({ type: "tool_result", sessionId: "ithaca", toolUseId: "search", output: "workspaces/voyage/a.md:1: Ithaca", isError: false });
    await recorder.settled();
    expect(queryGovernanceEvents(db, { sessionId: "ithaca", kinds: ["taint"], limit: 100 }), "SAFETY_REDELIVERED_RESULT_DOES_NOT_DUPLICATE").toHaveLength(6);
    recorder.finish("success"); await recorder.settled();
  } finally { db.close(); }
});


test("host keys deduplicate exact occurrences and reject changed retries", async () => {
  const db = createUiDb(":memory:"), writes = createGovernanceWrites(db);
  const event = { ...trigger("A"), dedupeKey: undefined, payload: { ...trigger("A").payload,
    occurrence: occurrence("voyage-epoch", "tool_web_input", "host-operation") } };
  try {
    expect(await writes.firstTaint(event)).toBe(true);
    expect(await writes.firstTaint(event), "SAFETY_EXACT_RETRY_DEDUPLICATES").toBe(false);
    await expectRejection(writes.firstTaint({ ...event, payload: { ...event.payload, source: "web_search" } }),"Conflicting occurrence retry");
    expect(writes.taint("voyage", null), "SAFETY_FAILED_RETRY_CANNOT_LOOSEN_ADMISSION").not.toBeNull();
    expect(queryGovernanceEvents(db, { turnId: "voyage", kinds: ["taint"], limit: 100 })).toHaveLength(1);
  } finally { db.close(); }
});

test("unbound taint survives retention and binding is once-only across worker restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-binding-")), path = join(root, "ui.db");
  let db = createUiDb(path), writer = openSqliteWriter(db);
  try {
    let writes = createGovernanceWrites(db, writer);
    await writes.firstTaint({ ...trigger("early"), sessionId: null, at: 0 });
    await writes.record({ ...meta, turnId: "later", kind: "strict_fallback", at: 90 * 86400000 + 1,
      payload: { reason: "symlink", path: "workspaces/voyage" } });
    expect(queryGovernanceEvents(db, { turnId: "voyage", kinds: ["taint"], limit: 100 }), "SAFETY_UNBOUND_NEVER_TIME_EVICTED").toHaveLength(1);
    db.query("INSERT INTO sessions(id,created_at,last_active_at) VALUES ('ithaca',0,0),('troy',0,0)").run();
    expect(await writes.bind("voyage", "ithaca")).toBe(1);
    await writer.close(); db.close();
    db = createUiDb(path); writer = openSqliteWriter(db); writes = createGovernanceWrites(db, writer);
    await expectRejection(writes.bind("voyage", "troy"),"Conflicting turn binding");
    await expectRejection(writes.firstTaint({ ...trigger("late"), sessionId: null }),"collection ended");
    expect(queryGovernanceEvents(db, { sessionId: "ithaca", kinds: ["taint"], limit: 100 }), "SAFETY_RESTART_RETAINS_BINDING_WITHOUT_ACCEPTING_LATE_INPUT").toHaveLength(1);
  } finally { await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("a retired bound session refuses named and session-less late callbacks after restart", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-retired-safety-")), path = join(root, "ui.db");
  let db = createUiDb(path), writer = openSqliteWriter(db);
  try {
    db.query("INSERT INTO sessions(id,created_at,last_active_at) VALUES ('ithaca',0,0)").run();
    const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 60 });
    db.query("INSERT INTO chat_session_owners(session_id,principal_id,created_at) VALUES ('ithaca',?,0)").run(principal.id);
    const writes = createGovernanceWrites(db, writer);
    await writes.firstTaint(trigger("before-retirement"));
    expect(retireChat(db, { operationId: "retire-ithaca", principalId: principal.id, target: { sessionId: "ithaca" },
      expected: { backendId: null, generation: 1 }, removableBackends: [], at: Date.now() }).status).toBe("retired");
    await writer.close(); db.close();
    db = createUiDb(path); writer = openSqliteWriter(db);
    const later = createGovernanceWrites(db, writer);
    await expectRejection(later.firstTaint({ ...trigger("late-retired"), sessionId: null }),"retired");
    expect(() => recordGovernanceEvent(db, trigger("named-retired"))).toThrow("retired");
    await expectRejection(later.bind("voyage", "ithaca"),"retired");
    // Governance is retained under its existing independent audit owner.
    expect(queryGovernanceEvents(db, { sessionId: "ithaca", kinds: ["taint"], limit: 100 })).toHaveLength(1);
  } finally { await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("native worker failure stays restrictive after pending entries settle", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-safety-failure-")), db = createUiDb(join(root, "ui.db"));
  db.exec("CREATE TRIGGER refuse_taint BEFORE INSERT ON governance_events WHEN NEW.kind='taint' BEGIN SELECT RAISE(ABORT,'fixture recording failure'); END");
  const writer = openSqliteWriter(db), writes = createGovernanceWrites(db, writer);
  try {
    await expectRejection(writes.firstTaint(trigger("failed")),"fixture recording failure");
    await writer.idle();
    expect(writes.taint("voyage", "ithaca"), "SAFETY_FAILED_WRITE_STAYS_RESTRICTIVE").not.toBeNull();
    expect(() => writes.firstTaint(trigger("retry"))).toThrow("requires recovery");
  } finally { await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});

test("bounded native pending writes stop the producer before accepting record 257", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-safety-capacity-")), db = createUiDb(join(root, "ui.db"));
  db.query("INSERT INTO sessions(id,created_at,last_active_at) VALUES ('ithaca',0,0)").run();
  const writer = openSqliteWriter(db), writes = createGovernanceWrites(db, writer);
  try {
    const channel = writer.channel(probe, { table: "safety_probe" });
    const entered = new Int32Array(new SharedArrayBuffer(4));
    const hold = channel.call("slow", "held", 200, entered);
    const waiting = Atomics.waitAsync(entered, 0, 0, 5000); if (waiting.async) await waiting.value;
    expect(Atomics.load(entered, 0)).toBe(1);
    const pending = Array.from({ length: 256 }, (_, i) => writes.firstTaint(trigger(`queued-${i}`)));
    expect(() => writes.firstTaint(trigger("overflow")), "SAFETY_PENDING_QUEUE_IS_BOUNDED").toThrow("capacity exceeded");
    expect(writes.taint("voyage", "ithaca"), "SAFETY_CAPACITY_STAYS_RESTRICTIVE").not.toBeNull();
    await hold; await Promise.all(pending);
    expect(queryGovernanceEvents(db, { sessionId: "ithaca", kinds: ["taint"], limit: 300 })).toHaveLength(256);
  } finally { await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); }
});


test("the collector discloses its versioned shell and opaque-transport exclusions", () => {
  expect(INGESTION_DETECTOR_MANIFEST.version).toBe(1);
  expect(INGESTION_DETECTOR_MANIFEST.exclusions).toContain("proxied_shell_local_read");
  expect(INGESTION_DETECTOR_MANIFEST.exclusions).toContain("opaque_tunnel_inner_protocol");
});
