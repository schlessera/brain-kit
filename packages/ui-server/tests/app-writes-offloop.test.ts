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
import { createTurnBudgets } from "../src/brain/turn-budgets.js";
import * as probe from "./fixtures/write-worker-probe.js";
import { createActivityStore } from "../src/activity/store.js";
import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { watchWriteSites } from "./helpers/write-sites.js";
import type { Logger } from "@opentelemetry/api-logs";
import { createPrincipal } from "../src/db/principals.js";
import { createSessionCatalog } from "../src/ws/session-catalog.js";
import { createSessionProfiles, SessionProfileError } from "../src/ws/session-profiles.js";
import { expectRejection } from "./helpers/expect-rejection.js";
import { createPolicyProposals } from "../src/brain/policy-proposal.js";
import { createSessionRoutes } from "../src/routes/sessions.js";
import { createStaticBackendRegistry } from "../src/agent/backend.js";
import { acceptRequest } from "../src/ws/recovery.js";
import { makeFakeBackend } from "./helpers/fake-backend.js";
import { WsHost } from "../src/ws/host.js";

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

test("turn budget writes commit on the write worker at FULL, after earlier writes, and admission waits for them", async () => {
  const f = fixture();
  const runtime = createActivityRuntime(f.db, { log: quietLog, writer: f.writer });
  try {
    const sites = await watchWriteSites(f.db, f.writer, ["turn_budget_usage", "turn_budget_days", "turn_budget_warnings", "provider_relay_usage", "activity_spans"]);
    const policy = resolveGovernancePolicy({ schema_version: 1, budgets: { turn: { warn_usd: 1, block_usd: 2, block_tokens: 10 } } });
    const budgets = createTurnBudgets(f.db, { resolve: () => ({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, estimate: false, source: "snapshot" }) }, Date.now, f.writer);
    void runtime.store.startSpan({ spanId: "voyage:root", runId: "voyage", name: "invoke_agent", kind: "turn", origin: "session", sessionId: "ithaca" });
    await budgets.begin("voyage", undefined, policy);
    await budgets.bind("voyage", "ithaca");
    const usage = (n: number) => ({ inputTokens: n, perModel: { odysseus: { inputTokens: n } } });
    expect(budgets.listPrice("voyage", usage(1)), "BUDGET_LIST_PRICE_BEFORE_COMMIT").toBe(1);
    expect((await budgets.observe("voyage", usage(1))!).warnings.map(item => item.scope), "BUDGET_OBSERVE_COMMITS_ON_WORKER").toEqual(["turn"]);
    // A slow commit ahead of the report that blocks the turn: admission must not read past it.
    const held = f.writer.channel(probe, { table: "odysseus_log" }); await held.ready;
    const slow = held.call("slow", "Calypso", 300);
    const blocking = budgets.observe("voyage", usage(2))!;
    expect((await budgets.providerAdmission("voyage", policy))?.scope, "BUDGET_ADMISSION_WAITS_FOR_PENDING_WRITES").toBe("turn");
    await slow; await blocking;
    await budgets.warnings("voyage");
    await budgets.backstop("voyage");
    await budgets.observeProvider("voyage", { attemptId: "attempt-1", family: "gemini", operation: "generate", origin: "https://ithaca.invalid", key: "GEMINI_API_KEY",
      model: "odysseus", outcome: "completed", status: 200, usage: { inputTokens: 1 } } as never);
    const log = await sites.log();
    expect(log[0], "BUDGET_AFTER_EARLIER_ACTIVITY_WRITE").toBe("activity_spans");
    expect(new Set(log.slice(1)), "BUDGET_TABLES_WRITTEN_ON_WORKER").toEqual(new Set(["turn_budget_usage", "turn_budget_days", "turn_budget_warnings", "provider_relay_usage"]));
  } finally { runtime.close(); await f.close(); }
});

const CATALOG_TABLES = ["sessions", "session_work", "turn_boundaries", "message_sources", "turn_failures", "session_state_room",
  "claude_session_usage", "claude_usage_turns", "session_worker_profiles", "draft_worker_profiles", "policy_proposals", "activity_spans"];
const profileFacts = { facts: () => ({ policyProfile: "governed" as const, policy: { policy: resolveGovernancePolicy({ schema_version: 1 }), hash: null } }) } as never;

test("session catalog rows, and the profile and proposal rows that reference them, commit on the write worker at FULL, in order", async () => {
  const f = fixture();
  const runtime = createActivityRuntime(f.db, { log: quietLog, writer: f.writer });
  try {
    const athena = createPrincipal(f.db, { authMethod: "password", label: "Athena device", ttlSeconds: 3600 });
    f.db.query("INSERT INTO draft_worker_profiles (principal_id, draft_id, preference, updated_at) VALUES (?, 'troy-draft', 'strict', 0)").run(athena.id);
    f.db.query("INSERT INTO policy_proposals (request_id, turn_id, principal_id, session_id, input_hash, review, created_at) VALUES ('wooden-horse', 'voyage', ?, NULL, 'h', '{}', 0)").run(athena.id);
    const sites = await watchWriteSites(f.db, f.writer, CATALOG_TABLES);
    const pricing = { resolve: () => ({ input: 1, output: 1, cacheRead: 1, cacheWrite: 1, estimate: false, source: "snapshot" as const }) };
    const failures: string[] = [];
    const reporting = { emit: (record: { attributes?: { error?: string } }) => { failures.push(String(record.attributes?.error)); } } as unknown as Logger;
    const catalog = createSessionCatalog(() => f.db, reporting, undefined, { pricing, store: runtime.store, governance: runtime.governanceWrites, writer: f.writer });
    const profiles = createSessionProfiles(f.db, profileFacts, undefined, undefined, { writer: f.writer, catalog });
    const proposals = createPolicyProposals({ root: f.brain, db: f.db, writer: f.writer, lock: { withLock: (_key: string, run: () => unknown) => run() } as never,
      observeUserPolicy: () => {}, recordEvent: () => {} });
    void runtime.store.startSpan({ spanId: "voyage:root", runId: "voyage", name: "invoke_agent", kind: "turn", origin: "session", sessionId: "ithaca" });
    // Everything below is submitted while an earlier commit holds the worker.
    const held = f.writer.channel(probe, { table: "odysseus_log" }); await held.ready;
    const slow = held.call("slow", "Calypso", 300);
    // session_info: the stub, then the rows that reference it.
    catalog.persistSessionStub("troy", "Sail for Troy", "claude-sonnet", "claude");
    void profiles.bind(athena.id, "troy-draft", "troy");
    void profiles.record("troy", "interactive", "governed");
    void proposals.bind("voyage", "troy");
    expect(f.db.query("SELECT 1 FROM sessions WHERE id = 'troy'").get(), "CATALOG_ROW_NOT_COMMITTED_ON_LOOP").toBeNull();
    expect([catalog.hasSession!("troy"), catalog.getStoredBackendId("troy"), catalog.getStoredProviderId("troy")], "CATALOG_PENDING_ROW_READS")
      .toEqual([true, "claude", "claude-sonnet"]);
    expect(profiles.read(athena.id, "session", "troy"), "PROFILE_PENDING_READ").toMatchObject({ preference: "strict", actualProfile: "governed" });
    expect(() => profiles.preference(athena.id, undefined, "troy-draft"), "PROFILE_PENDING_DRAFT_CONSUMED").toThrow("unavailable");
    expect([catalog.acceptWork!("troy", "req-1", "claude"), catalog.acceptWork!("troy", "req-2", null)], "WORK_REVISIONS_AT_ACCEPTANCE").toEqual([1, 2]);
    catalog.dispatchWork!("troy", 2, "turn-2", "claude", 7);
    expect(catalog.latestWork!("troy"), "WORK_PENDING_LATEST").toMatchObject({ revision: 2, requestId: "req-2", turnId: "turn-2", backendId: "claude", startedAt: 7 });
    catalog.recordMessageSource!("troy", "Sail for Troy", "voice-dictate", { turnId: "turn-2", thinkingLevel: "high" });
    catalog.recordEffectiveThinkingLevel!("troy", "turn-2", "medium");
    catalog.recordTurnBoundary!("troy", "claude", { turnId: "turn-2", assistantOrdinal: 0, prefixDigest: "d" });
    catalog.recordTurnFailure!("troy", "claude", { turnId: "turn-2", assistantOrdinal: 0, prefixDigest: "d", failure: { errorClass: "overloaded", message: "Poseidon" } as never });
    catalog.recordStateRoom!("troy", { usedBytes: 1, allowanceBytes: 10, observedAt: 1 } as never);
    catalog.accountClaudeUsage!("troy", "claude", "turn-2", {}, false);
    catalog.persistSession({ type: "result", sessionId: "troy", numTurns: 1, costUsd: 0.5 } as never, "Sail for Troy", null, "claude");
    catalog.saveSessionLabel!("troy", "Troy", "source-1");
    expect(catalog.sessionLabel!("troy"), "LABEL_PENDING_READ").toEqual({ label: "Troy", source: "source-1" });
    catalog.addSessionCost!("troy", 0.25);
    const linked = catalog.recordHandoff!("troy", "h-troy-0001", "ithaca", 3);
    await slow;
    await catalog.settled!();
    expect(failures, "CATALOG_WRITES_COMMIT_ON_WORKER_AT_FULL").toEqual([]);
    expect(await linked, "HANDOFF_LINK_COMMITS_ON_WORKER").toBe(true);
    const log = await sites.log();
    expect(log[0], "CATALOG_AFTER_EARLIER_ACTIVITY_WRITE").toBe("activity_spans");
    const first = (table: string) => log.indexOf(table);
    expect(first("sessions"), "CATALOG_STUB_BEFORE_ITS_REFERENCES").toBeLessThan(first("session_worker_profiles"));
    expect(first("session_worker_profiles"), "CATALOG_PROFILE_BEFORE_PROPOSAL_BIND").toBeLessThan(first("policy_proposals"));
    expect(new Set(log), "CATALOG_TABLES_WRITTEN_ON_WORKER").toEqual(new Set(CATALOG_TABLES));
    const row = f.db.query("SELECT backend_id, provider_id, total_cost_usd, num_turns, label, handoff_id FROM sessions WHERE id = 'troy'").get();
    expect(row, "CATALOG_ROW_COMMITTED").toEqual({ backend_id: "claude", provider_id: "claude-sonnet", total_cost_usd: 0.75, num_turns: 1, label: "Troy", handoff_id: "h-troy-0001" });
    expect(f.db.query("SELECT session_id FROM policy_proposals").get(), "PROPOSAL_BOUND_AFTER_STUB").toEqual({ session_id: "troy" });
    expect(catalog.latestWork!("troy"), "WORK_COMMITTED_LATEST").toMatchObject({ revision: 2, turnId: "turn-2" });
  } finally { runtime.close(); await f.close(); }
});

test("history readers wait for pending catalog writes; a failed acceptance's revision is never issued again", async () => {
  const f = fixture();
  const runtime = createActivityRuntime(f.db, { log: quietLog, writer: f.writer });
  try {
    const catalog = createSessionCatalog(() => f.db, quietLog, undefined, { pricing: { resolve: () => null }, store: runtime.store, writer: f.writer });
    const history = (id: string) => [{ role: "user" as const, content: `Sail for ${id}`, toolCalls: [] }];
    const registry = createStaticBackendRegistry([makeFakeBackend({ id: "claude", sessions: [] }),
      makeFakeBackend({ id: "pi", sessions: [{ id: "troy", title: "Troy", createdAt: 1, lastActiveAt: 1, totalCostUsd: 0, numTurns: 0 }], histories: { troy: history("Troy"), "ithaca-return": history("Ithaca") } })], "claude");
    const routes = createSessionRoutes({ registry, db: f.db, settled: () => catalog.settled!() });
    const held = f.writer.channel(probe, { table: "odysseus_log" }); await held.ready;
    const slow = held.call("slow", "Calypso", 300);
    catalog.persistSessionStub("troy", "Sail for Troy", null, "pi");
    catalog.persistSession({ type: "result", sessionId: "troy", numTurns: 2, costUsd: 0.5 } as never, "Sail for Troy", null, "pi");
    const listed = await (await routes.request("/sessions")).json() as { sessions: Array<{ id: string; totalCostUsd: number }> };
    expect(listed.sessions.find(session => session.id === "troy")?.totalCostUsd, "SESSION_LIST_WAITS_FOR_CATALOG").toBe(0.5);
    await slow;
    // Its own held window: the history route picks the backend from the row.
    const again = held.call("slow", "Calypso", 300);
    catalog.persistSessionStub("ithaca-return", "Sail home", null, "pi");
    const replay = await (await routes.request("/sessions/ithaca-return")).json() as { messages: unknown[] };
    expect(replay.messages, "SESSION_HISTORY_WAITS_FOR_ITS_BACKEND_ROW").toHaveLength(1);
    await again;
  } finally { runtime.close(); await f.close(); }
  const db = createUiDb(":memory:");
  try {
    db.exec("CREATE TRIGGER refuse_odysseus BEFORE INSERT ON session_work WHEN NEW.request_id = 'refused' BEGIN SELECT RAISE(ABORT, 'Scylla'); END");
    const catalog = createSessionCatalog(() => db, quietLog);
    const host = { catalog, coordinator: { unorderedSessions: new Set<string>() } } as never as Parameters<typeof acceptRequest>[0];
    expect(acceptRequest(host, "troy", "refused", null), "WORK_FAILED_ACCEPTANCE_HAS_A_REVISION").toBe(1);
    await catalog.settled!();
    expect(host.coordinator.unorderedSessions.has("troy"), "WORK_FAILED_ACCEPTANCE_UNORDERS").toBe(true);
    expect(acceptRequest(host, "troy", "req-2", null), "WORK_REVISION_NOT_REISSUED").toBe(2);
    await catalog.settled!();
    expect(host.coordinator.unorderedSessions.has("troy"), "WORK_LATER_ACCEPTANCE_ORDERS").toBe(false);
  } finally { db.close(); }
});

test("a failure retained before its session's row commits is stored after it, unless an input invalidated it", async () => {
  const f = fixture();
  try {
    const catalog = createSessionCatalog(() => f.db, quietLog, undefined, { pricing: { resolve: () => null }, store: createActivityStore(f.db, { writer: "odysseus" }), writer: f.writer });
    const failure = { errorClass: "overloaded", message: "Poseidon" } as never;
    const request = { type: "chat_message", text: "Sail for Troy", attachments: [] } as never;
    const held = f.writer.channel(probe, { table: "odysseus_log" }); await held.ready;
    let slow = held.call("slow", "Calypso", 200);
    catalog.persistSessionStub("troy", "Sail for Troy", null, "claude");
    expect(catalog.saveRetryRequest!("troy", "turn-1", "athena", request, "Sail for Troy", failure), "RETRY_ADVERTISED_WHILE_ROW_PENDING").toBe(true);
    await slow; await catalog.settled!();
    expect(catalog.peekRetry!("troy")?.turnId, "RETRY_STORED_AFTER_ITS_ROW").toBe("turn-1");
    slow = held.call("slow", "Calypso", 200);
    catalog.persistSessionStub("troy", "Sail for Troy", null, "claude");
    catalog.saveRetryRequest!("troy", "turn-2", "athena", request, "Sail for Troy", failure);
    catalog.clearRetryRequest!("troy");
    await slow; await catalog.settled!();
    expect(catalog.peekRetry!("troy"), "RETRY_INVALIDATED_BEFORE_IT_WAS_STORED").toBeNull();
  } finally { await f.close(); }
});

test("a replayed history joins the catalog rows submitted before it was read", async () => {
  const f = fixture();
  const runtime = createActivityRuntime(f.db, { log: quietLog, writer: f.writer });
  try {
    const catalog = createSessionCatalog(() => f.db, quietLog, undefined, { pricing: { resolve: () => null }, store: runtime.store, writer: f.writer });
    const backend = makeFakeBackend({ id: "claude", histories: { troy: [{ role: "user", content: "Sail for Troy", toolCalls: [] }] } });
    const host = new WsHost({ registry: createStaticBackendRegistry([backend], "claude"), catalog, maxConcurrentSessions: () => 3 });
    const held = f.writer.channel(probe, { table: "odysseus_log" }); await held.ready;
    const slow = held.call("slow", "Calypso", 300);
    catalog.persistSessionStub("troy", "Sail for Troy", null, "claude");
    catalog.recordMessageSource!("troy", "Sail for Troy", "voice-dictate");
    let replayed: Array<{ source?: string }> = [];
    await host.publishHistory("troy", backend, () => true, messages => { replayed = host.prepareHistory("troy", messages); });
    expect(replayed.map(message => message.source), "HISTORY_JOINS_PENDING_CATALOG_WRITES").toEqual(["voice-dictate"]);
    await slow;
  } finally { runtime.close(); await f.close(); }
});

test("only a session's newest acceptance orders or unorders it", () => {
  const settle: Array<(stored: boolean) => void> = [];
  let next: number | null = 1;
  const host = { catalog: { acceptWork: (_s: string, _r: string | null, _b: string | null, settled?: (stored: boolean) => void) => { settle.push(settled!); return next; } },
    coordinator: { unorderedSessions: new Set<string>() } } as never as Parameters<typeof acceptRequest>[0];
  expect(acceptRequest(host, "troy", "req-1", null)).toBe(1);
  next = null;
  expect(acceptRequest(host, "troy", "req-2", null), "WORK_UNASSIGNED_ACCEPTANCE").toBeUndefined();
  settle[0]!(true);
  expect(host.coordinator.unorderedSessions.has("troy"), "WORK_OLDER_ACCEPTANCE_DOES_NOT_REORDER").toBe(true);
});

test("a local exchange commits on the write worker; still pending, the next prompt takes it once and marks it carried after its record (#2850)", async () => {
  const f = fixture();
  try {
    const catalog = createSessionCatalog(() => f.db, quietLog, undefined, { pricing: { resolve: () => null }, store: createActivityStore(f.db, { writer: "odysseus" }), writer: f.writer });
    const sites = await watchWriteSites(f.db, f.writer, ["local_exchanges"]);
    const exchange = { id: "stats-ithaca", command: "stats", prompt: "Stats", context: "Documents: 3", answer: [] } as never;
    const held = f.writer.channel(probe, { table: "odysseus_log" }); await held.ready;
    const slow = held.call("slow", "Calypso", 300);
    const recorded = catalog.recordLocalExchange!("ithaca", exchange, false);
    expect(f.db.query("SELECT COUNT(*) AS n FROM local_exchanges").get(), "EXCHANGE_NOT_COMMITTED_ON_LOOP").toEqual({ n: 0 });
    expect(catalog.takePendingLocalExchanges!("ithaca").map(item => item.id), "EXCHANGE_PENDING_TAKEN_BY_NEXT_PROMPT").toEqual(["stats-ithaca"]);
    expect(catalog.takePendingLocalExchanges!("ithaca"), "EXCHANGE_TAKEN_ONCE").toEqual([]);
    await slow;
    expect(await recorded, "EXCHANGE_RECORD_SETTLES_STORED").toBe(true);
    await catalog.settled!();
    expect(f.db.query("SELECT delivered_at IS NOT NULL AS carried FROM local_exchanges WHERE exchange_id = 'stats-ithaca'").get(), "EXCHANGE_MARKED_CARRIED_AFTER_ITS_RECORD").toEqual({ carried: 1 });
    expect(catalog.takePendingLocalExchanges!("ithaca"), "EXCHANGE_CARRIED_NOT_TAKEN_AGAIN").toEqual([]);
    expect(new Set(await sites.log()), "EXCHANGE_WRITTEN_ON_WORKER").toEqual(new Set(["local_exchanges"]));
  } finally { await f.close(); }
});

test("a saved worker preference commits on the write worker, and its refusals keep their class and status (#2850)", async () => {
  const f = fixture();
  try {
    const athena = createPrincipal(f.db, { authMethod: "password", label: "Athena device", ttlSeconds: 3600 });
    f.db.query("INSERT INTO session_worker_profiles (session_id, preference, updated_at, updated_by, origin) VALUES ('ithaca', 'governed', 0, 'host', 'voice')").run();
    f.db.query("INSERT INTO sessions(id,title,created_at,last_active_at) VALUES ('troy','Troy',0,0)").run();
    const sites = await watchWriteSites(f.db, f.writer, ["session_worker_profiles", "draft_worker_profiles"]);
    const catalog = createSessionCatalog(() => f.db, quietLog, undefined, { pricing: { resolve: () => null }, store: createActivityStore(f.db, { writer: "odysseus" }), writer: f.writer });
    const profiles = createSessionProfiles(f.db, profileFacts, undefined, undefined, { writer: f.writer, catalog });
    expect((await profiles.save(athena.id, "session", "troy", "strict")).preference, "PROFILE_SAVE_ANSWERS_COMMITTED_ROW").toBe("strict");
    expect((await profiles.save(athena.id, "draft", "troy-draft", "strict")).preference, "PROFILE_DRAFT_SAVE_COMMITS").toBe("strict");
    const refusal = await expectRejection(profiles.save(athena.id, "session", "ithaca", "strict"), SessionProfileError, "PROFILE_REFUSAL_CLASS_KEPT") as SessionProfileError;
    expect(refusal.status, "PROFILE_REFUSAL_STATUS_KEPT").toBe(409);
    expect(new Set(await sites.log()), "PROFILE_SAVES_WRITTEN_ON_WORKER").toEqual(new Set(["session_worker_profiles", "draft_worker_profiles"]));
  } finally { await f.close(); }
});
