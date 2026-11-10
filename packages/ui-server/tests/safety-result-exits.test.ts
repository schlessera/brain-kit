/** Every exit between a tool running and its result's record either records
 * the result or leaves its chat a permanent gap, in both backends (#3812).
 * Every call `begin()` admits owes its result until the record is durable or
 * the backend refuses the call; one still owed when its collection ends, or
 * at boot, is a gap. The installed Claude runtime's replay of a stopped
 * turn's result, and its skipped result hooks, are proved in
 * `safety-result-retention.test.ts`; these drive the remaining exits against
 * the real host ledger. Keyless and offline. */
import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Agent } from "@earendil-works/pi-agent-core";
import { createUiDb } from "../src/db/client";
import { openSqliteWriter } from "../src/db/write-worker";
import { createGovernanceWrites } from "../src/governance/event-writes";
import { createSafetyCollector } from "../src/governance/safety-collector";
import { safetyCatalogCreated } from "../src/governance/safety-store";
import { createPiWorkerRpcDispatcher, type PiWorkerRpc, type PiWorkerRpcContext } from "../../ui-backend-pi/src/worker-rpc";
import { installPiToolSafety } from "../../ui-backend-pi/src/tool-safety";
import { holdSafetyRecovery } from "./helpers/hold-safety-recovery";

/** A search that names a workspace note: only its result's record carries the taint. */
const SEARCH = "workspaces/voyage/raft.md:1: Sail past the sirens.";

/** Settles `work` on the normal event loop: a pending `expect().rejects` waits
 * synchronously and never sees the write worker's reply. */
const refusal = (work: Promise<unknown>) => work.then(() => null, (error: unknown) => error as Error);

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

async function voyage() {
  const root = mkdtempSync(join(tmpdir(), "odysseus-safety-exits-")); roots.push(root);
  const brain = join(root, "brain"); mkdirSync(join(brain, "workspaces/voyage"), { recursive: true });
  writeFileSync(join(brain, "workspaces/voyage/raft.md"), "Sail past the sirens.\n");
  const db = createUiDb(join(root, "ui.db")), writer = openSqliteWriter(db), writes = createGovernanceWrites(db, writer);
  holdSafetyRecovery(db);
  const bindingId = crypto.randomUUID(), controller = new AbortController();
  await writes.safetyBegin({ turnId: "voyage", bindingId, sessionId: null, principalId: "odysseus", backendId: "pi", at: 0 });
  db.exec("INSERT INTO sessions(id,created_at,last_active_at) VALUES('ithaca',0,0); INSERT INTO chat_session_owners VALUES('ithaca','odysseus',0)");
  safetyCatalogCreated(db, "ithaca", "odysseus", "voyage"); await writes.bind("voyage", "ithaca");
  const collector = createSafetyCollector(db, writes, { turnId: "voyage", bindingId, backendId: "pi", sessionId: () => "ithaca", brainPath: brain,
    shellProxied: () => false, signal: controller.signal, stop: error => controller.abort(error) });
  await collector.ready("pi", 1);
  return { db, writes, collector, controller, path: join(root, "ui.db"),
    failure: () => (db.query("SELECT failure FROM safety_collections WHERE turn_id='voyage'").get() as { failure: string | null }).failure,
    recorded: () => db.query(`SELECT r.detector FROM safety_records r JOIN safety_collections c ON c.id=r.collection_id
      WHERE c.turn_id='voyage' AND r.kind='occurrence'`).all(),
    cause: () => JSON.parse((db.query("SELECT failure_cause FROM safety_collections WHERE turn_id='voyage'").get() as { failure_cause: string | null }).failure_cause ?? "null"),
    owed: () => (db.query("SELECT COUNT(*) n FROM safety_obligations").get() as { n: number }).n,
    chat: () => writes.safety(null, "ithaca"),
    async close() { await writer.close(); db.close(); } };
}
type Voyage = Awaited<ReturnType<typeof voyage>>;

/** The host side of a Pi worker whose turn has stopped. */
function dispatcher(f: Voyage) {
  return createPiWorkerRpcDispatcher({ turn: { bridge: { inputSafety: f.collector } },
    live() { if (f.controller.signal.aborted) throw new Error("Pi worker RPC refused: turn is inactive, cancelled or revoked."); },
    executed: (msg: PiWorkerRpc) => ({ name: msg.toolName, host: false, lock: false, phases: new Set() }),
    canFinalizeSafety: () => false } as unknown as PiWorkerRpcContext);
}
const report = (id: number, toolCallId: string, input: Record<string, unknown>): PiWorkerRpc =>
  ({ type: "rpc", id, method: "safetyResult", toolName: "grep", toolCallId, input }) as PiWorkerRpc;

test("a result reaching a turn that stopped and ended leaves its chat a permanent gap", async () => {
  const f = await voyage(); try {
    await f.collector.begin("toolu_raft", "Grep", { pattern: "sirens" });
    // Odysseus stops the turn; it ends before the runtime reports the search.
    f.controller.abort(new Error("Odysseus stopped the turn"));
    await f.writes.safetyEnd("voyage");
    expect(await refusal(f.collector.result("toolu_raft", "Grep", SEARCH, true)), "SAFETY_LATE_RESULT_IS_REFUSED").toBeInstanceOf(Error);
    expect(f.failure(), "SAFETY_LATE_RESULT_IS_A_DURABLE_GAP").toBe("recording_failed");
    expect(f.chat().restriction, "SAFETY_LATE_RESULT_RESTRICTS_ITS_CHAT").toBe("restricted");
    expect(f.chat().coverage.state, "SAFETY_LATE_RESULT_NEVER_LOOKS_COMPLETE").toBe("incomplete");
  } finally { await f.close(); }
});

for (const timing of ["after", "queued"] as const) test(`a result whose call was refused before delivery is never let through unrecorded: ${timing}`, async () => {
  const f = await voyage(); try {
    // The web input's record is refused before the tool runs: that refusal alone leaves no gap.
    f.db.exec("CREATE TRIGGER refuse_input BEFORE INSERT ON safety_pending BEGIN SELECT RAISE(ABORT,'forced input reservation failure'); END");
    const begun = refusal(f.collector.begin("toolu_aeolus", "WebFetch", { url: "https://example.com/aeolus" }));
    // A runtime that ran the call anyway reports its result, at once or later:
    // it cannot be recorded against an input that never was.
    const reported = timing === "queued" ? refusal(f.collector.result("toolu_aeolus", "WebFetch", "The bag of winds is open.", true)) : undefined;
    expect(await begun).toBeInstanceOf(Error);
    f.db.exec("DROP TRIGGER refuse_input");
    if (timing === "after") expect(f.failure(), "SAFETY_REFUSED_INPUT_LEAVES_NO_GAP").toBeNull();
    const result = await (reported ?? refusal(f.collector.result("toolu_aeolus", "WebFetch", "The bag of winds is open.", true)));
    expect(f.failure(), "SAFETY_RESULT_AFTER_REFUSED_BEGIN_IS_A_GAP").toBe("recording_failed");
    expect(result?.message).toContain("no admitted operation");
    expect(f.chat().coverage.state).toBe("incomplete");
  } finally { await f.close(); }
});

test("a Pi result reaching a stopped turn is still recorded", async () => {
  const f = await voyage(); try {
    await f.collector.begin("call_raft", "grep", { pattern: "sirens" });
    f.controller.abort(new Error("Odysseus stopped the turn"));
    // The worker is refused once the result is recorded, so it stops.
    expect((await refusal(dispatcher(f)(report(1, "call_raft", { output: SEARCH, segments: [SEARCH] }))))?.message).toContain("inactive, cancelled or revoked");
    expect(f.recorded(), "SAFETY_PI_STOPPED_RESULT_IS_RECORDED").toEqual([{ detector: "tool_search_output" }]);
    expect(f.chat().restriction, "SAFETY_PI_STOPPED_RESULT_RESTRICTS_ITS_CHAT").toBe("restricted");
  } finally { await f.close(); }
});

for (const kind of ["malformed", "replayed"] as const) test(`a Pi result report refused before its record leaves its chat a permanent gap: ${kind}`, async () => {
  const f = await voyage(); try {
    await f.collector.begin("call_raft", "grep", { pattern: "sirens" });
    const dispatch = dispatcher(f);
    if (kind === "malformed") expect((await refusal(dispatch(report(1, "call_raft", { output: 7 }))))?.message).toBe("Malformed safety result");
    else {
      await f.collector.begin("call_raft_again", "grep", { pattern: "rocks" });
      expect(await dispatch(report(2, "call_raft_again", { output: "" }))).toEqual({ ok: true });
      expect((await refusal(dispatch(report(2, "call_raft", { output: SEARCH }))))?.message).toBe("Replayed pi worker RPC");
    }
    expect(f.failure(), "SAFETY_PI_REFUSED_REPORT_IS_A_DURABLE_GAP").toBe("recording_failed");
    expect(f.chat().coverage.state, "SAFETY_PI_REFUSED_REPORT_NEVER_LOOKS_COMPLETE").toBe("incomplete");
  } finally { await f.close(); }
});

test("a Pi result is still reported when the session's own after-hook fails", async () => {
  const f = await voyage(); try {
    await f.collector.begin("call_raft", "grep", { pattern: "sirens" });
    let stopped = 0;
    const agent = { afterToolCall: async () => { throw new Error("the session's after-hook failed"); }, abort() {} } as unknown as Agent;
    installPiToolSafety(agent, { permission: async () => ({ behavior: "allow" }), stop: () => { stopped++; },
      result: (name, id, content) => f.collector.result(id, name, content.filter(p => p.type === "text").map(p => (p as { text: string }).text).join("\n"), true) }, () => false);
    expect((await refusal(agent.afterToolCall!({ toolCall: { name: "grep", id: "call_raft" }, result: { content: [{ type: "text", text: SEARCH }] } } as never, undefined)))?.message)
      .toBe("the session's after-hook failed");
    expect(f.recorded(), "SAFETY_PI_RESULT_SURVIVES_A_FAILED_AFTER_HOOK").toEqual([{ detector: "tool_search_output" }]);
    expect(stopped, "SAFETY_PI_FAILED_AFTER_HOOK_STOPS_THE_WORKER").toBe(1);
  } finally { await f.close(); }
});

test("a call admitted and never reported leaves its chat a permanent gap when its collection ends", async () => {
  const f = await voyage(); try {
    // A runtime that ran the search but never reported it: no result hook,
    // no worker report. Only the call's admission stands for its result.
    await f.collector.begin("call_raft", "grep", { pattern: "sirens" });
    expect(f.owed(), "SAFETY_ADMITTED_CALL_OWES_ITS_RESULT").toBe(1);
    await f.writes.safetyEnd("voyage");
    expect(f.failure(), "SAFETY_OWED_RESULT_IS_A_DURABLE_GAP").toBe("recording_failed");
    expect(f.cause(), "SAFETY_OWED_RESULT_NAMES_ITS_CALL").toMatchObject({ site: "safetyEnd", turnId: "voyage", message: expect.stringContaining("grep (call_raft)") });
    expect(f.owed(), "SAFETY_ENDED_COLLECTION_OWES_NOTHING_MORE").toBe(0);
    expect(f.chat().restriction, "SAFETY_OWED_RESULT_RESTRICTS_ITS_CHAT").toBe("restricted");
    expect(f.chat().coverage.state, "SAFETY_OWED_RESULT_NEVER_LOOKS_COMPLETE").toBe("incomplete");
  } finally { await f.close(); }
});

test("a call the backend refuses owes nothing, and a recorded result discharges its call", async () => {
  const f = await voyage(); try {
    await f.collector.begin("call_raft", "grep", { pattern: "sirens" });
    await f.collector.begin("call_oar", "grep", { pattern: "oar" });
    // The gate refuses the first call after admitting it: it never runs.
    await f.collector.refused!("call_raft");
    // A refused call stays refused: a parallel admission cannot reopen it.
    expect(String((await refusal(f.collector.begin("call_raft", "grep", { pattern: "sirens" })))?.message), "SAFETY_REFUSED_CALL_STAYS_REFUSED").toContain("refused");
    expect(f.controller.signal.aborted, "SAFETY_REFUSED_CALL_DOES_NOT_STOP_ITS_TURN").toBe(false);
    await f.collector.result("call_oar", "grep", "", true);
    expect(f.owed(), "SAFETY_REFUSED_AND_RECORDED_CALLS_OWE_NOTHING").toBe(0);
    await f.writes.safetyEnd("voyage");
    expect(f.failure(), "SAFETY_REFUSED_CALL_LEAVES_NO_GAP").toBeNull();
    expect(f.chat().coverage.state, "SAFETY_DISCHARGED_CALLS_KEEP_COVERAGE").toBe("complete");
  } finally { await f.close(); }
});

test("a call refused when its edited input cannot be recorded owes nothing", async () => {
  const f = await voyage(); try {
    await f.collector.begin("call_aeolus", "WebFetch", { url: "https://example.com/aeolus" });
    expect(f.owed(), "SAFETY_ADMITTED_FETCH_OWES_ITS_RESULT").toBe(1);
    // An approval edits the call; recording the edited input is refused, so
    // the backend refuses the call, which never runs.
    f.db.exec("CREATE TRIGGER refuse_input BEFORE INSERT ON safety_pending BEGIN SELECT RAISE(ABORT,'forced input reservation failure'); END");
    expect(await refusal(f.collector.begin("call_aeolus", "WebFetch", { url: "https://example.com/zephyr" })), "SAFETY_UNRECORDED_EDIT_REFUSES_THE_CALL").toBeInstanceOf(Error);
    f.db.exec("DROP TRIGGER refuse_input");
    expect(f.owed(), "SAFETY_REFUSED_EDIT_OWES_NOTHING").toBe(0);
    await f.writes.safetyEnd("voyage");
    expect(f.failure(), "SAFETY_REFUSED_EDIT_LEAVES_NO_GAP").toBeNull();
  } finally { await f.close(); }
});

test("a call whose admission cannot be recorded never runs, owes nothing and leaves no gap", async () => {
  const f = await voyage(); try {
    f.db.exec("CREATE TRIGGER refuse_obligation BEFORE INSERT ON safety_obligations BEGIN SELECT RAISE(ABORT,'forced obligation failure'); END");
    const begun = await refusal(f.collector.begin("call_raft", "grep", { pattern: "sirens" }));
    f.db.exec("DROP TRIGGER refuse_obligation");
    // Refused before the tool ran: the backend refuses the call.
    expect((begun as { code?: string } | null)?.code, "SAFETY_UNRECORDED_ADMISSION_REFUSES_THE_CALL").toBe("safety_recording_unavailable");
    expect(f.owed(), "SAFETY_UNRECORDED_ADMISSION_OWES_NOTHING").toBe(0);
    await f.writes.safetyEnd("voyage");
    expect(f.failure(), "SAFETY_UNRECORDED_ADMISSION_LEAVES_NO_GAP").toBeNull();
  } finally { await f.close(); }
});

test("a call still owed when the host dies leaves its chat a permanent gap at boot", async () => {
  const f = await voyage();
  await f.collector.begin("call_oar", "grep", { pattern: "oar" });
  await f.collector.result("call_oar", "grep", "", true);
  await f.collector.begin("call_raft", "grep", { pattern: "sirens" });
  expect(f.owed(), "SAFETY_ONLY_THE_UNREPORTED_CALL_IS_OWED").toBe(1);
  // The process dies mid-search: nothing ends the collection.
  await f.close();
  const db = createUiDb(f.path), writer = openSqliteWriter(db), writes = createGovernanceWrites(db, writer);
  holdSafetyRecovery(db);
  try {
    const voyage = db.query("SELECT failure,failure_cause,gap FROM safety_collections WHERE turn_id='voyage'").get() as { failure: string | null; failure_cause: string; gap: string | null };
    expect(voyage.failure, "SAFETY_OWED_AT_RESTART_IS_A_DURABLE_GAP").toBe("recording_failed");
    // It names the call still owed, not the one already recorded.
    expect(JSON.parse(voyage.failure_cause), "SAFETY_OWED_AT_RESTART_NAMES_ITS_CALL").toMatchObject({ site: "boot-obligation", turnId: "voyage", message: "A tool result was never recorded: grep (call_raft)" });
    expect(voyage.gap, "SAFETY_RESTART_STILL_CLASSIFIES_THE_OPEN_COLLECTION").toBe("host_restart_unknown");
    expect((db.query("SELECT COUNT(*) n FROM safety_obligations").get() as { n: number }).n, "SAFETY_BOOT_LEAVES_NOTHING_OWED").toBe(0);
    const chat = writes.safety(null, "ithaca");
    expect(chat.restriction, "SAFETY_OWED_AT_RESTART_RESTRICTS_ITS_CHAT").toBe("restricted");
    expect(chat.coverage.epochs.find(epoch => epoch.reason === "recording_failed"), "SAFETY_OWED_AT_RESTART_IS_A_RECORDING_GAP").toBeDefined();
  } finally { await writer.close(); db.close(); }
});
