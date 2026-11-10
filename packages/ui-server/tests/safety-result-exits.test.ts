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
import { createPermissionGate } from "../../ui-backend-pi/src/permission-gate";
import { createBrainTools } from "../../ui-backend-pi/src/tools";
import { createBrainAccess } from "../../ui-backend-pi/src/brain-access";
import { createTurnContext } from "../../ui-backend-pi/src/turn-context";
import { createPermissionWiring } from "../../ui-backend-claude/src/permission-hooks";
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
  return { db, writes, collector, controller, brain, path: join(root, "ui.db"),
    /** Resolves once the writer has applied every write sent before it. */
    idle: () => writer.idle(),
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

/** The real curated search, run the way the worker runs it once the host allowed it. */
async function searchRuns(f: Voyage, toolCallId: string, input: Record<string, unknown>): Promise<string> {
  const grep = createBrainTools({ brain: createBrainAccess(f.brain), turn: createTurnContext(), exec: {},
    lock: { withKey: async (_key: string, run: () => Promise<unknown>) => run() } } as never).find(tool => tool.name === "grep")!;
  return JSON.stringify((await grep.execute(toolCallId, input as never, f.controller.signal, undefined, undefined as never)).content);
}

/** What stands for a call that ran and was never reported: its obligation, then its chat's gap. */
async function stillOwed(f: Voyage, call: string) {
  // A search of a note records nothing before it runs: only the obligation is left.
  expect(f.chat().unresolvedCount, "SAFETY_UNREPORTED_SEARCH_LEFT_NOTHING_ELSE").toBe(0);
  expect(f.owed(), "SAFETY_LATER_REFUSAL_KEEPS_THE_OBLIGATION").toBe(1);
  await f.writes.safetyEnd("voyage");
  expect(f.failure(), "SAFETY_ALLOWED_UNREPORTED_CALL_IS_A_DURABLE_GAP").toBe("recording_failed");
  expect(f.cause(), "SAFETY_ALLOWED_UNREPORTED_CALL_NAMES_ITS_CALL").toMatchObject({ site: "safetyEnd", message: expect.stringContaining(call) });
  expect(f.chat().restriction, "SAFETY_ALLOWED_UNREPORTED_CALL_RESTRICTS_ITS_CHAT").toBe("restricted");
  expect(f.chat().coverage.state, "SAFETY_ALLOWED_UNREPORTED_CALL_NEVER_LOOKS_COMPLETE").toBe("incomplete");
}

// A refusal proves a call never ran only until the backend let it run. A
// later request for the same call, refused for any reason, proves nothing
// about the search that already ran (#3812).
for (const later of ["replayed", "stopped", "denied", "unrecordable"] as const) test(`a Pi call allowed and run stays owed whatever a later request for it says: ${later}`, async () => {
  const f = await voyage(); try {
    const allowedTools = new Set(["grep"]);
    const turn = { bridge: { inputSafety: f.collector, emit() {}, requestPermission: async () => ({ behavior: "deny", message: "Penelope declines the later request" }) },
      signal: f.controller.signal, enforceAllowedTools: false, noGrantSurface: false };
    const dispatch = createPiWorkerRpcDispatcher({ turn, grants: new Map(), allowedTools, confirmPatterns: [], admitTool() {}, autonomous: false,
      live() { if (f.controller.signal.aborted) throw new Error("Pi worker RPC refused: turn is inactive, cancelled or revoked."); } } as unknown as PiWorkerRpcContext);
    const ask = { type: "rpc", id: 1, method: "permission", toolName: "grep", toolCallId: "call_raft", input: { pattern: "sirens" } } as PiWorkerRpc;
    expect(await dispatch(ask), "SAFETY_PI_CALL_IS_ALLOWED").toEqual({ behavior: "allow" });
    expect(f.owed(), "SAFETY_PI_ALLOWED_CALL_OWES_ITS_RESULT").toBe(1);
    // The worker runs the search; its result never reaches the host.
    expect(await searchRuns(f, ask.toolCallId, ask.input), "SAFETY_PI_ALLOWED_SEARCH_RAN").toContain("Sail past the sirens");
    if (later === "stopped") f.controller.abort(new Error("Odysseus stopped the turn"));
    if (later === "denied") allowedTools.clear();
    // Re-requested with an input whose record is refused: its admission, a
    // rejected begin(), fails before delivery and gaps nothing by itself.
    if (later === "unrecordable") f.db.exec("CREATE TRIGGER refuse_input BEFORE INSERT ON safety_pending BEGIN SELECT RAISE(ABORT,'forced input reservation failure'); END");
    const answer = await dispatch({ ...ask, id: later === "replayed" ? 1 : 2, ...(later === "unrecordable" ? { input: { pattern: "sirens", path: "workspaces/voyage" } } : {}) })
      .catch((error: Error) => error);
    if (later === "unrecordable") f.db.exec("DROP TRIGGER refuse_input");
    if (later === "denied") expect(answer, "SAFETY_PI_LATER_REQUEST_IS_DENIED").toMatchObject({ behavior: "deny" });
    else expect((answer as Error).message, "SAFETY_PI_LATER_REQUEST_IS_REJECTED").toContain(later === "replayed" ? "Replayed pi worker RPC" : "inactive, cancelled or revoked");
    if (later === "unrecordable") expect(f.failure(), "SAFETY_PI_REFUSED_ADMISSION_GAPS_NOTHING_BY_ITSELF").toBeNull();
    await stillOwed(f, "grep (call_raft)");
  } finally { await f.close(); }
});

test("a Pi call the in-process gate let through stays owed when a later admission of it is blocked", async () => {
  const f = await voyage(); try {
    const turn = createTurnContext();
    turn.bridge = { inputSafety: f.collector, emit() {}, requestPermission: async () => ({ behavior: "allow" }) } as never;
    turn.signal = f.controller.signal;
    let admit: ((event: { toolName: string; toolCallId: string; input: unknown }) => Promise<{ block: boolean; reason?: string } | undefined>) | undefined;
    const gate = createPermissionGate({ turn, allowedTools: new Set(["grep"]), confirmPatterns: [] });
    (typeof gate === "function" ? gate : gate.factory)({ on: (event: string, handler: unknown) => { if (event === "tool_call") admit = handler as typeof admit; } } as never);
    const call = { toolName: "grep", toolCallId: "call_raft", input: { pattern: "sirens" } };
    expect(await admit!(call), "SAFETY_PI_GATE_LETS_THE_CALL_RUN").toBeUndefined();
    expect(await searchRuns(f, call.toolCallId, call.input), "SAFETY_PI_GATE_SEARCH_RAN").toContain("Sail past the sirens");
    f.controller.abort(new Error("Odysseus stopped the turn"));
    expect(await admit!(call), "SAFETY_PI_GATE_BLOCKS_THE_LATER_ADMISSION").toMatchObject({ block: true });
    await stillOwed(f, "grep (call_raft)");
  } finally { await f.close(); }
});

test("a Claude call its callback allowed stays owed whatever a later admission of it says", async () => {
  const f = await voyage(); try {
    const wiring = createPermissionWiring({ req: { prompt: "Listen for the sirens.", signal: f.controller.signal,
      bridge: { emit() {}, requestPermission: async () => ({ behavior: "allow" }), inputSafety: f.collector } } as never,
      allowedTools: [], confirmPatterns: [], brainPath: f.brain, childEnv: { PATH: "/usr/bin:/bin" }, log() {},
      turnLock: { acquireForTool: async () => ({ ok: true }), releaseForTool() {} } as never });
    const input = { pattern: "sirens", path: f.brain, output_mode: "content" }, options = { toolUseID: "toolu_sirens", signal: new AbortController().signal } as never;
    // The callback is the runtime's last gate: on its allow the search runs.
    expect((await wiring.canUseTool!("Grep", input, options))?.behavior, "SAFETY_CLAUDE_CALLBACK_ALLOWS_THE_CALL").toBe("allow");
    expect(f.owed(), "SAFETY_CLAUDE_ALLOWED_CALL_OWES_ITS_RESULT").toBe(1);
    // The turn stops before either result hook; the call is admitted again and denied.
    f.controller.abort(new Error("Odysseus stopped the turn"));
    const preToolUse = wiring.hooks!.PreToolUse!.find(group => !group.matcher)!.hooks[0]!;
    const hooked = await preToolUse({ hook_event_name: "PreToolUse", tool_name: "Grep", tool_input: input, tool_use_id: "toolu_sirens" } as never, "toolu_sirens", { signal: new AbortController().signal });
    expect((hooked as { hookSpecificOutput?: { permissionDecision?: string } }).hookSpecificOutput?.permissionDecision, "SAFETY_CLAUDE_LATER_HOOK_DENIES").toBe("deny");
    expect((await wiring.canUseTool!("Grep", input, options))?.behavior, "SAFETY_CLAUDE_LATER_CALLBACK_DENIES").toBe("deny");
    await stillOwed(f, "Grep (toolu_sirens)");
  } finally { await f.close(); }
});

test("a result's last record discharges its call in the same commit, so a host dying after it owes nothing", async () => {
  const f = await voyage(); let release = () => {}, reported: Promise<unknown> | undefined, open = true;
  try {
    await f.collector.begin("call_raft", "grep", { pattern: "sirens" });
    let committed = () => {};
    const recorded = new Promise<void>(resolve => { committed = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
    // Hold the collector the moment the result's exposure has committed.
    const record = f.writes.record;
    f.writes.record = async (...args: Parameters<typeof record>) => { const stored = await record(...args); if (args[0].kind === "taint_exposure") { committed(); await hold; } return stored; };
    reported = refusal(f.collector.result("call_raft", "grep", SEARCH, true));
    await recorded;
    expect(f.db.query("SELECT kind,state FROM safety_records ORDER BY rowid").all(), "SAFETY_RESULT_RECORD_IS_DURABLE").toContainEqual({ kind: "exposure", state: "finalized" });
    expect(f.owed(), "SAFETY_RECORDED_RESULT_IS_DISCHARGED_IN_ITS_OWN_COMMIT").toBe(0);
    // The host dies here, before the collector returns.
    await f.close(); open = false;
    const db = createUiDb(f.path), writer = openSqliteWriter(db);
    holdSafetyRecovery(db);
    try {
      const voyage = db.query("SELECT failure,failure_cause FROM safety_collections WHERE turn_id='voyage'").get() as { failure: string | null; failure_cause: string | null };
      expect(voyage, "SAFETY_RECORDED_RESULT_IS_NO_GAP_AT_BOOT").toEqual({ failure: null, failure_cause: null });
      expect(db.query("SELECT r.detector FROM safety_records r WHERE r.kind='occurrence'").all(), "SAFETY_RECORDED_RESULT_SURVIVES_RESTART").toEqual([{ detector: "tool_search_output" }]);
    } finally { await writer.close(); db.close(); }
  } finally { release(); await reported; if (open) await f.close(); }
});

test("a collection's end waits for a stopped turn's result record already under way", async () => {
  const f = await voyage(); let release = () => {}, reported: Promise<unknown> | undefined;
  try {
    await f.collector.begin("call_raft", "grep", { pattern: "sirens" });
    let reached = () => {};
    const midway = new Promise<void>(resolve => { reached = resolve; }), hold = new Promise<void>(resolve => { release = resolve; });
    // Hold the record halfway: its occurrence committed, its exposure not yet.
    const record = f.writes.record;
    f.writes.record = async (...args: Parameters<typeof record>) => { if (args[0].kind === "taint_exposure") { reached(); await hold; } return record(...args); };
    // Odysseus stops the turn as the result arrives; teardown then ends its collection.
    f.controller.abort(new Error("Odysseus stopped the turn as the result arrived"));
    reported = refusal(f.collector.result("call_raft", "grep", SEARCH, true));
    await midway;
    const ending = f.writes.safetyEnd("voyage");
    // The writer applies its writes in order: had the end been sent, it is applied now.
    await f.idle();
    expect(f.db.query("SELECT ended FROM safety_collections WHERE turn_id='voyage'").get(), "SAFETY_END_WAITS_FOR_A_RECORD_UNDER_WAY").toEqual({ ended: 0 });
    release();
    expect(await reported, "SAFETY_RECORD_UNDER_WAY_COMPLETES").toBeNull();
    await ending;
    expect(f.db.query("SELECT ended FROM safety_collections WHERE turn_id='voyage'").get(), "SAFETY_END_FOLLOWS_THE_RECORD").toEqual({ ended: 1 });
    expect(f.recorded(), "SAFETY_STOPPED_TURN_RESULT_IS_RECORDED").toEqual([{ detector: "tool_search_output" }]);
    // Recorded, so reviewable: the stop leaves no permanent gap of its own.
    expect(f.failure(), "SAFETY_RECORD_UNDER_WAY_AT_THE_END_IS_NO_GAP").toBeNull();
    expect(f.chat().unresolvedCount, "SAFETY_RECORD_UNDER_WAY_AWAITS_REVIEW").toBe(1);
    expect(f.chat().coverage.state, "SAFETY_RECORD_UNDER_WAY_KEEPS_COVERAGE").toBe("complete");
  } finally { release(); await reported; await f.close(); }
});
