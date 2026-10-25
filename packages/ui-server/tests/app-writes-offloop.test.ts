import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveGovernancePolicy } from "@schlessera/brain-common/internal/governance-policy";
import { createUiDb } from "../src/db/client.js";
import { openSqliteWriter } from "../src/db/write-worker.js";
import { createActivityRuntime } from "../src/activity/runtime.js";
import { createGovernanceWrites } from "../src/governance/event-writes.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { createTurnScope } from "../src/brain/turn-scope.js";
import { createTurnRecorder } from "../src/activity/recorder.js";
import { createActivityStore } from "../src/activity/store.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { watchWriteSites } from "./helpers/write-sites.js";
import type { Logger } from "@opentelemetry/api-logs";

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "app-writes-odysseus-")), brain = join(root, "brain"), path = join(root, "ui.db");
  mkdirSync(join(brain, ".brain/scratch"), { recursive: true });
  const db = createUiDb(path), writer = openSqliteWriter(db);
  db.query("INSERT INTO sessions(id,title,created_at,last_active_at) VALUES ('ithaca','Voyage',0,0)").run();
  return { root, brain, path, db, writer, async close() { await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}
const quietLog = { emit() {} } as unknown as Logger;
const attribution = { turnId: "voyage", sessionId: null, actor: "interactive" as const, model: null, profile: "governed" as const };

test("governance events commit on the write worker at FULL, never on the app connection", async () => {
  const f = fixture();
  try {
    expect(f.writer.offloop).toBe(true);
    const sites = await watchWriteSites(f.db, f.writer, ["governance_events"]);
    const writes = createGovernanceWrites(f.db, f.writer);
    const recorded = await writes.record({ ...attribution, kind: "scope_cap", payload: { cap: "tool_calls", limit: 3, observed: 3, overshoot: 0, frozen: true, outcome: "paused", source: "policy" } });
    expect(recorded.recorded, "GOVERNANCE_EVENT_COMMITS_ON_WORKER").toBe(true);
    expect(await writes.firstTaint({ ...attribution, kind: "taint", payload: { source: "egress_connection", tool: null, detail: "GET troy.example:443" } }), "GOVERNANCE_TAINT_COMMITS_ON_WORKER").toBe(true);
    await writes.bind("voyage", "ithaca");
    expect(f.db.query("SELECT count(*) AS n FROM governance_events WHERE session_id = 'ithaca'").get(), "GOVERNANCE_BIND_COMMITS_ON_WORKER").toEqual({ n: 2 });
    expect(await writes.roadblocks({ ...attribution, sessionId: "ithaca" }, { startedAt: 0, endedAt: 1, calls: [], usage: [], finalUsage: null, outcomeDetail: null }))
      .toBeGreaterThanOrEqual(0);
    const runtime = createActivityRuntime(f.db, { log: quietLog, writer: f.writer });
    try { await runtime.governance({ ...attribution, kind: "budget_warning", payload: { scope: "turn", unit: "usd", limit: 1, observed: 1, source: "policy" } }); }
    finally { runtime.close(); }
    const log = await sites.log();
    expect(log.length, "GOVERNANCE_WRITES_LOGGED_ON_WORKER").toBeGreaterThanOrEqual(4);
    expect(new Set(log), "GOVERNANCE_WRITES_ONLY_TO_WATCHED_TABLE").toEqual(new Set(["governance_events"]));
    expect((f.db.query("SELECT count(*) AS n FROM governance_events").get() as { n: number }).n).toBe(4);
  } finally { await f.close(); }
});

test("a pending taint narrows admission before its commit lands", async () => {
  const f = fixture();
  try {
    const writes = createGovernanceWrites(f.db, f.writer);
    const committed = writes.firstTaint({ ...attribution, kind: "taint", payload: { source: "egress_connection", tool: null, detail: "GET troy.example:443" } });
    expect(writes.taint("voyage", null)?.source, "GOVERNANCE_PENDING_TAINT_IS_IN_FORCE").toBe("egress_connection");
    await committed;
    expect(writes.taint("voyage", null)!.eventId, "GOVERNANCE_COMMITTED_TAINT_HAS_ITS_ROW").toBeGreaterThan(0);
  } finally { await f.close(); }
});

test("turn scope rows and their cap events commit on the write worker, in submission order with Activity", async () => {
  const f = fixture();
  const native = createNativeJournalFixture(f.brain, f.root);
  const journal = createTurnJournal(f.db, { nativeManager: native.manager, brainPath: f.brain, dbPath: f.path, objectsRoot: join(f.root, "objects"), writer: f.writer });
  const runtime = createActivityRuntime(f.db, { log: quietLog, writer: f.writer });
  try {
    await journal.ready;
    const sites = await watchWriteSites(f.db, f.writer, ["turn_scope", "governance_events", "activity_spans"]);
    const changed: string[] = [];
    const scope = createTurnScope(f.db, { brainPath: f.brain, journal, writer: f.writer, governance: runtime.governanceWrites, connected: () => true,
      changed: turnId => { changed.push((f.db.query("SELECT summary FROM turn_scope WHERE turn_id=?").get(turnId) as { summary: string }).summary); } });
    let stopped = "";
    void runtime.store.startSpan({ spanId: "voyage:root", runId: "voyage", name: "invoke_agent", kind: "turn", origin: "session", sessionId: "ithaca" });
    await scope.begin("voyage", { sessionId: "ithaca", principalId: "athena", origin: "interactive", profile: "governed",
      policy: resolveGovernancePolicy({ schema_version: 1, scope: { max_tool_calls: 1 } }), source: "policy", hardTimeoutMs: 60_000,
      current: () => !stopped, stop: reason => { stopped = reason; } });
    // The cap is reached with no worker to freeze: its event, then the stopped summary.
    scope.toolCall("voyage", "call-1");
    await scope.finish("voyage");
    const log = await sites.log();
    expect(log.slice(0, 2), "SCOPE_ORDER_ACTIVITY_THEN_SCOPE_ROW").toEqual(["activity_spans", "turn_scope"]);
    expect(log.slice(2), "SCOPE_CAP_EVENT_BEFORE_ITS_SUMMARY").toEqual(["governance_events", "turn_scope", "turn_scope", "turn_scope"]);
    expect(stopped, "SCOPE_CAP_STOPS_UNFROZEN_TURN").toContain("could not confirm a running worker");
    const row = f.db.query("SELECT summary, ended_at FROM turn_scope WHERE turn_id='voyage'").get() as { summary: string; ended_at: number | null };
    expect(row.ended_at, "SCOPE_END_COMMITTED").not.toBeNull();
    expect(changed.at(-1), "SCOPE_CHANGED_AFTER_COMMIT").toBe(row.summary);
  } finally { runtime.close(); await journal.close(); await native.close(); await f.close(); }
});

test("a turn's settled() waits for its roadblock commit", async () => {
  const db = createUiDb(":memory:");
  let release!: () => void;
  const held = new Promise<number>(done => { release = () => done(0); });
  const recorder = createTurnRecorder({ store: createActivityStore(db, { writer: "odysseus" }), governanceDb: db,
    governanceWrites: { ...createGovernanceWrites(db), roadblocks: () => held } }, { turnId: "voyage", sessionId: null });
  try {
    recorder.finish("success");
    let settled = false;
    void recorder.settled().then(() => { settled = true; });
    await Bun.sleep(50);
    expect(settled, "RECORDER_SETTLED_WAITS_FOR_ROADBLOCKS").toBe(false);
    release();
    await recorder.settled();
    expect(settled).toBe(true);
  } finally { db.close(); }
});
