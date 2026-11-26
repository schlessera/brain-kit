/**
 * Every host-side owner of a turn's abort signal names why it stopped the
 * turn (#4565): only the real time limit reads as a timeout. Each test stops
 * an Odysseus turn through one owner's own code path and reads what the turn
 * recorded (its Activity run, its frames), not the classifier alone.
 */
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostStopOutcomeDetail, type ServerMessage } from "@schlessera/brain-ui-sdk/protocol";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createActivityStore } from "../src/activity/store";
import { createActivityStream } from "../src/activity/stream";
import { createTurnRecorder } from "../src/activity/recorder";
import { createUiDb } from "../src/db/client";
import { createPrincipal } from "../src/db/principals";
import { openSqliteWriter } from "../src/db/write-worker";
import { createGovernanceWrites } from "../src/governance/event-writes";
import { HOST_STOP_REASONS } from "../src/ws/host-stop";
import { WsHost, type WsHostOptions } from "../src/ws/host";
import { runSession } from "../src/ws/run-session";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { watchdogMs } from "../../../scripts/test-deadlines.js";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testAuthorization } from "./helpers/principal";

/** What the Claude runtime writes into a tool it interrupts. */
const RUNTIME_REFUSAL = "The user doesn't want to take this action right now. STOP what you are doing and wait for the user to tell you how to proceed.";

const cleanups: Array<() => void | Promise<void>> = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

/**
 * A turn that starts a tool, lets `trigger` stop it, then ends the way the
 * Claude runtime ends an interrupted turn: the tool's refusal text, a
 * cancelled status and a cancelled result.
 */
function interruptedTurn(trigger: (request: StartTurnRequest) => void | Promise<void>) {
  return makeFakeBackend({ id: "claude", capabilities: { askUser: true }, async startTurn(request) {
    const { bridge, signal } = request;
    bridge.emit({ type: "session_info", sessionId: "ithaca", isNew: true });
    bridge.emit({ type: "tool_use_start", toolUseId: "loom", toolName: "Bash" });
    await Promise.resolve(trigger(request)).catch(() => {});
    // Watchdog only: every owner below aborts within milliseconds.
    if (!signal.aborted) await new Promise<void>((resolve, reject) => {
      const watchdog = setTimeout(() => reject(new Error("the turn was never stopped")), watchdogMs(10_000));
      signal.addEventListener("abort", () => { clearTimeout(watchdog); resolve(); }, { once: true });
    });
    bridge.emit({ type: "tool_result", toolUseId: "loom", output: RUNTIME_REFUSAL, isError: true });
    bridge.emit({ type: "status", status: "cancelled" });
    bridge.emit({ type: "result", sessionId: "ithaca", outcome: "cancelled", isError: false, durationMs: 1, numTurns: 1 });
  } });
}

type Fixture = { readonly db: ReturnType<typeof createUiDb>; readonly writes: ReturnType<typeof createGovernanceWrites>; readonly store: ReturnType<typeof createActivityStore> };

async function stoppedTurn(backend: ReturnType<typeof interruptedTurn>, options: (fixture: Fixture) => Partial<WsHostOptions> = () => ({})) {
  const root = mkdtempSync(join(tmpdir(), "odysseus-host-stop-")), db = createUiDb(join(root, "ui.db"));
  const writer = openSqliteWriter(db), writes = createGovernanceWrites(db, writer);
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  const store = createActivityStore(db);
  const host = new WsHost({ registry: createStaticBackendRegistry([backend], "claude"), catalog: createSessionCatalog(() => db),
    isPrincipalAuthorized: id => id === principal.id, turnTimeoutMs: 30_000,
    activity: { store, stream: createActivityStream(store) },
    ...options({ db, writes, store }) });
  cleanups.push(() => { rmSync(root, { recursive: true, force: true }); }, () => db.close(), () => writer.close(), () => host.close());
  const frames: ServerMessage[] = [];
  const ws = { send(text: string) { frames.push(JSON.parse(text) as ServerMessage); } };
  host.clients.add(ws, principal.id);
  await runSession(host, { authorization: testAuthorization(principal.id), text: "Weave the shroud", attachments: [] });
  const result = frames.find(frame => frame.type === "result") as Extract<ServerMessage, { type: "result" }> | undefined;
  const turnId = (result as { turnId?: string } | undefined)?.turnId;
  if (!result || !turnId) throw new Error(`no scoped result: ${JSON.stringify(frames)}`);
  // The run's root span, which its recorder ends with the turn's outcome.
  const run = store.getSpan(`${turnId}:turn`);
  return {
    run: { outcome: run?.outcome, reason: run?.outcomeReason },
    toolSpan: store.getSpan("loom"),
    toolOutput: store.snapshotRun(turnId)?.events.find(event => event.spanId === "loom" && event.eventType === "tool_output")?.payload,
    policyConfirm: store.snapshotRun(turnId)?.events.find(event => event.eventType === "policy_confirm")?.payload as { decision?: string } | undefined,
    result,
    tool: frames.find(frame => frame.type === "tool_result" && frame.toolUseId === "loom") as Extract<ServerMessage, { type: "tool_result" }>,
    status: frames.find(frame => frame.type === "status" && frame.status === "cancelled") as Extract<ServerMessage, { type: "status" }>,
  };
}

/** A stopped turn records its owner's cause, and says so on its frames. */
function expectHostStop(turn: Awaited<ReturnType<typeof stoppedTurn>>, cause: keyof typeof HOST_STOP_REASONS, label: string) {
  expect(turn.run, `${label}_RECORDS_ITS_CAUSE`).toEqual({ outcome: "error", reason: HOST_STOP_REASONS[cause] });
  expect(turn.result.outcomeDetail, `${label}_RESULT_NAMES_CAUSE`).toBe(hostStopOutcomeDetail(cause));
  expect(turn.status.detail, `${label}_STATUS_NOT_TIMEOUT`).toBe("Stopped by the host");
  // Display label only: the model received the runtime's text as written.
  expect(turn.tool, `${label}_TOOL_SHOWN_AS_HOST_STOP`).toMatchObject({ output: RUNTIME_REFUSAL, hostStop: cause });
  // Activity's tool span says the host stopped it, not that the user refused it.
  expect(turn.toolSpan, `${label}_TOOL_SPAN_NAMES_HOST_STOP`).toMatchObject({ outcome: "error", outcomeReason: HOST_STOP_REASONS[cause] });
  expect(turn.toolOutput, `${label}_TOOL_OUTPUT_EVENT_NAMES_HOST_STOP`).toBe(HOST_STOP_REASONS[cause]);
}

test("the real time limit still records a timeout", async () => {
  const turn = await stoppedTurn(interruptedTurn(() => {}), () => ({ turnTimeoutMs: 20 }));
  expect(turn.run.outcome, "TIMEOUT_RECORDS_TIMEOUT").toBe("timeout");
  expect(turn.result.outcomeDetail).toBe("host_timeout");
  expect(turn.status.detail).toBe("Turn timed out");
  expect(turn.tool.hostStop, "TIMEOUT_TOOL_NOT_HOST_STOP").toBeUndefined();
});

test("the Activity recorder's safety stop records safety recording", async () => {
  // The recorder stops a turn whose untrusted input it cannot record.
  const backend = interruptedTurn(({ bridge }) => {
    bridge.emit({ type: "tool_use_start", toolUseId: "fetch", toolName: "WebFetch" });
    bridge.emit({ type: "tool_use_complete", toolUseId: "fetch", toolName: "WebFetch", input: { url: "https://ithaca.invalid/notice" } });
    bridge.emit({ type: "tool_result", toolUseId: "fetch", output: "A fictional harbour notice.", isError: false });
  });
  // Without governance writes the taint commits through `governance` at once.
  const turn = await stoppedTurn(backend, ({ db, store }) => ({ activity: { store, stream: createActivityStream(store), governanceDb: db,
    governance: () => { throw new Error("fixture governance write failure"); } } }));
  expectHostStop(turn, "safety_recording", "RECORDER");
});

test("the safety hooks' stop records safety recording", async () => {
  let writes: ReturnType<typeof createGovernanceWrites> | undefined;
  const backend = interruptedTurn(async ({ bridge }) => {
    // The collector stops the turn when an obligation cannot be reserved.
    const obliged = writes!.safetyOblige;
    writes!.safetyOblige = (() => Promise.reject(new Error("fixture obligation failure"))) as typeof obliged;
    await bridge.inputSafety!.ready("claude", 1);
    try { await bridge.inputSafety!.begin("fetch", "WebFetch", { url: "https://ithaca.invalid/notice" }); }
    finally { writes!.safetyOblige = obliged; }
  });
  const turn = await stoppedTurn(backend, fixture => {
    writes = fixture.writes;
    return { activity: { store: fixture.store, stream: createActivityStream(fixture.store), governanceDb: fixture.db, governanceWrites: fixture.writes } };
  });
  expectHostStop(turn, "safety_recording", "SAFETY_HOOKS");
});

test("a failed journal tool record records the change journal", async () => {
  const journal = {
    toolStarted() {}, toolEnded: () => Promise.reject(new Error("fixture journal failure")),
    bindSession: () => Promise.resolve(), finish: () => Promise.resolve(), isHeld: () => false, idle: () => Promise.resolve(),
    summary: () => ({ state: "off" }),
  };
  const backend = interruptedTurn(({ bridge }) => { bridge.emit({ type: "tool_result", toolUseId: "loom-read", output: "Penelope's loom", isError: false }); });
  const turn = await stoppedTurn(backend, () => ({ journal: journal as never }));
  expectHostStop(turn, "change_journal", "JOURNAL_EMISSION");
});

test("a failed inbox share binding records the inbox share", async () => {
  const inboxTools = { forTurn: () => undefined, shares: {
    start: () => Promise.resolve(), end: () => Promise.resolve(), bind: () => Promise.reject(new Error("fixture share failure")),
  } };
  // The Actor runs the turn started stop for the host's reason, not a timeout.
  const apifyStops: string[] = [];
  const apify = { stop: async (_turn: unknown, reason: string) => { apifyStops.push(reason); return []; } };
  const turn = await stoppedTurn(interruptedTurn(() => {}), () => ({ inboxTools: inboxTools as never, apify: apify as never }));
  expectHostStop(turn, "inbox_share", "SHARE_BINDING");
  expect(apifyStops, "APIFY_RUNS_STOP_FOR_HOST_STOP").toEqual(["host_stop"]);
});

test("a host stop closes the question its backend was waiting on, with its own cause", async () => {
  const bind = Promise.withResolvers<void>();
  let answer: unknown;
  const backend = interruptedTurn(async ({ bridge }) => {
    const asked = bridge.askUser!("harbour", [{ question: "Which harbour first?", header: "Harbour", multiSelect: false,
      options: [{ label: "Ithaca", description: "Home" }, { label: "Pylos", description: "Nestor's court" }] }]);
    // The share binding fails while the question is open.
    bind.reject(new Error("fixture share failure"));
    answer = await asked.then(() => null, error => error);
  });
  const inboxTools = { forTurn: () => undefined, shares: { start: () => Promise.resolve(), end: () => Promise.resolve(), bind: () => bind.promise } };
  const turn = await stoppedTurn(backend, () => ({ inboxTools: inboxTools as never }));
  expect((answer as Error | null)?.message, "PENDING_QUESTION_CLOSED_WITH_HOST_CAUSE").toBe(HOST_STOP_REASONS.inbox_share);
  expectHostStop(turn, "inbox_share", "SHARE_DURING_QUESTION");
});

test("a confirmation pending when the host stopped the turn records the host stop, not a timeout", async () => {
  const inboxTools = { forTurn: () => undefined, shares: { start: () => Promise.resolve(), end: () => Promise.resolve(), bind: () => Promise.reject(new Error("fixture share failure")) } };
  const backend = makeFakeBackend({ id: "claude", async startTurn({ bridge, signal }) {
    bridge.emit({ type: "session_info", sessionId: "ithaca", isNew: true });
    if (!signal.aborted) await new Promise<void>(resolve => signal.addEventListener("abort", () => resolve(), { once: true }));
    // The runtime reports the confirmation it was waiting on as it unwinds.
    bridge.activity?.({ kind: "policy_confirm", toolUseId: "push", payload: { tool: "Bash", input: "git push origin main", inputTruncated: false,
      rule: { list: "commands.confirm", index: 0, pattern: "^git push" }, decision: "timed_out", policyHash: null } });
    bridge.emit({ type: "result", sessionId: "ithaca", outcome: "cancelled", isError: false, durationMs: 1, numTurns: 1 });
  } });
  const turn = await stoppedTurn(backend as never, () => ({ inboxTools: inboxTools as never }));
  expect(turn.policyConfirm?.decision, "PENDING_CONFIRM_RECORDS_HOST_STOP").toBe("host_stopped");
});

test("a backend cannot claim a host stop the host did not make", async () => {
  const backend = makeFakeBackend({ id: "claude", async startTurn({ bridge }) {
    bridge.emit({ type: "session_info", sessionId: "ithaca", isNew: true });
    bridge.emit({ type: "tool_use_start", toolUseId: "loom", toolName: "Bash" });
    bridge.emit({ type: "tool_result", toolUseId: "loom", output: "bash: unweave: command not found", isError: true, hostStop: "safety_recording" } as never);
    bridge.activity?.({ kind: "policy_confirm", toolUseId: "push", payload: { tool: "Bash", input: "git push origin main", inputTruncated: false,
      rule: { list: "commands.confirm", index: 0, pattern: "^git push" }, decision: "host_stopped", policyHash: null } });
    bridge.emit({ type: "result", sessionId: "ithaca", outcome: "cancelled", outcomeDetail: "host_stop:safety_recording", isError: false, durationMs: 1, numTurns: 1 });
  } });
  const turn = await stoppedTurn(backend as never);
  expect(turn.tool.hostStop, "BACKEND_TOOL_HOST_STOP_DROPPED").toBeUndefined();
  expect(turn.tool.output).toBe("bash: unweave: command not found");
  expect(turn.result.outcomeDetail, "BACKEND_HOST_STOP_DETAIL_DROPPED").toBeUndefined();
  expect(turn.toolSpan?.outcomeReason).toBe("bash: unweave: command not found");
  expect(turn.policyConfirm?.decision, "BACKEND_HOST_STOPPED_DECISION_DROPPED").toBe("declined");
});

test("a recorder fed frames directly never takes a frame's own host-stop claim", () => {
  // Autonomous and handoff runs hand backend frames to their recorder without the bridge.
  const db = createUiDb(":memory:");
  try {
    const store = createActivityStore(db, { writer: "test" });
    const recorder = createTurnRecorder({ store }, { turnId: "suitors", sessionId: null });
    recorder.observeFrame({ type: "tool_use_start", toolUseId: "bow", toolName: "Bash" } as never);
    recorder.observeFrame({ type: "tool_result", toolUseId: "bow", output: "bash: string: command not found", isError: true, hostStop: "change_journal" } as never);
    expect(store.getSpan("bow")?.outcomeReason, "DIRECT_FRAME_HOST_STOP_IGNORED").toBe("bash: string: command not found");
    recorder.observeActivity({ kind: "policy_confirm", toolUseId: "bow", payload: { tool: "Bash", input: "git push origin main", inputTruncated: false,
      rule: { list: "commands.confirm", index: 0, pattern: "^git push" }, decision: "host_stopped", policyHash: null } });
    recorder.observeFrame({ type: "result", sessionId: "ithaca", outcome: "cancelled", outcomeDetail: "host_stop:change_journal", isError: false, durationMs: 1, numTurns: 1 } as never);
    recorder.finish("error");
    const confirm = store.snapshotRun("suitors")?.events.find(event => event.eventType === "policy_confirm")?.payload as { decision?: string } | undefined;
    expect(confirm?.decision, "DIRECT_ACTIVITY_HOST_STOPPED_DECLINED").toBe("declined");
    expect((store.getSpan("suitors:turn")?.attrs as Record<string, unknown> | undefined)?.["outcome.detail"], "DIRECT_RESULT_HOST_STOP_DETAIL_DROPPED").toBeUndefined();
  } finally { db.close(); }
});
