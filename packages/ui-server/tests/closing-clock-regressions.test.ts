import { expect, spyOn, test } from "bun:test";
import { createUiDb } from "../src/db/client";
import { createActivityStore } from "../src/activity/store";
import { createTurnLifecycle } from "../src/activity/turn-lifecycle";
import { teardownTurn } from "../src/ws/session-run/teardown";
import type { TurnRun } from "../src/ws/session-run/types";

function fixture() {
  const db = createUiDb(":memory:"), store = createActivityStore(db); let now = 1000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const lifecycle = createTurnLifecycle(store, "turn-ithaca", "ithaca", now, () => {}, () => now);
  const timeout = setTimeout(() => {}, 30000); timeout.unref();
  const run = { host: { dialogue: { retireTurn() {} }, log: { emit() {} } }, slot: { releaseActive() {} },
    turn: { turnId: "turn-ithaca", sessionId: "ithaca" }, current: {}, lifecycle, timeoutHandle: timeout,
    failureRecording: { async finish() { return true; } }, held: {}, stops: {}, abortController: new AbortController() } as unknown as TurnRun;
  return { db, store, lifecycle, run, advance(ms: number) { now += ms; }, close() { clearTimeout(timeout); clock.mockRestore(); db.close(); } };
}
const outcome = { lifecycle: "error", work: "error", cancelledBeforeStart: false } as const;

test("absent cleanup and recorder operations have no successful timing receipts", async () => {
  const f = fixture();
  try {
    await teardownTurn(f.run, outcome);
    expect(f.store.lifecycle("turn-ithaca")!.openSubPhases?.map(step => step.name), "SKIPPED_CLEANUP_IS_ABSENT").toEqual(["failure_recording"]);
    expect(f.store.lifecycle("turn-ithaca")!.recorderSettledAt).toBeNull();
  } finally { f.close(); }
});

test("caught generation and reconciliation failures leave their closing steps incomplete", async () => {
  const f = fixture();
  f.run.held.worktreeGeneration = { id: "argo" } as NonNullable<TurnRun["held"]["worktreeGeneration"]>;
  f.run.held.governedHold = { sandbox: { profile: "strict" }, async end() { f.advance(75); throw Error("reconciliation unavailable"); } } as unknown as NonNullable<TurnRun["held"]["governedHold"]>;
  Object.assign(f.run.host, { referenceWorktreeGenerations: new Map(), referenceWorktrees: {
    async retireGeneration() {}, async closeGeneration() { f.advance(50); throw Error("generation unavailable"); }, async reconcile() { throw Error("must not follow failed close"); },
  } });
  try {
    await teardownTurn(f.run, outcome);
    const steps = f.store.lifecycle("turn-ithaca")!.openSubPhases!;
    expect(steps.filter(step => ["worktree_generation_close", "governed_reconcile"].includes(step.name))
      .map(step => [step.name, step.endedAt]), "FAILED_CLEANUP_IS_NOT_COMPLETE").toEqual([["worktree_generation_close", null], ["governed_reconcile", null]]);
  } finally { f.close(); }
});

test("scope completion records its promise settlement without adding a close-path wait", async () => {
  const f = fixture(); const scope = Promise.withResolvers<void>(), entered = Promise.withResolvers<void>(), final = Promise.withResolvers<void>();
  Object.assign(f.run.host, { scope: { finish() { entered.resolve(); return scope.promise.then(() => true); } } });
  f.run.failureRecording.finish = async () => { await final.promise; return true; };
  let done: Promise<void> | undefined;
  try {
    done = teardownTurn(f.run, outcome); await entered.promise;
    f.lifecycle.mark("failureObservedAt");
    expect(f.store.lifecycle("turn-ithaca")!.openSubPhases?.find(step => step.name === "scope_finish")?.endedAt, "PENDING_SCOPE_HAS_NO_COMPLETION").toBeNull();
    f.advance(300); scope.resolve(); await scope.promise; final.resolve(); await done;
    expect(f.store.lifecycle("turn-ithaca")!.openSubPhases?.find(step => step.name === "scope_finish"))
      .toMatchObject({ startedAt: 1000, endedAt: 1300, elapsedMs: 300 });
  } finally { scope.resolve(); final.resolve(); await done; f.close(); }
});

test("scope writes still pending at the existing terminal boundary remain explicitly unknown", async () => {
  const f = fixture(); const scope = Promise.withResolvers<void>();
  Object.assign(f.run.host, { scope: { finish() { return scope.promise.then(() => true); } } });
  try {
    await teardownTurn(f.run, outcome);
    expect(f.store.lifecycle("turn-ithaca")!.endedAt).toBe(1000);
    expect(f.store.lifecycle("turn-ithaca")!.openSubPhases?.find(step => step.name === "scope_finish")?.endedAt).toBeNull();
    scope.resolve(); await scope.promise;
    expect(f.store.lifecycle("turn-ithaca")!.openSubPhases?.find(step => step.name === "scope_finish")?.endedAt, "LATE_SCOPE_SUCCESS_IS_NOT_GUESSED").toBeNull();
  } finally { scope.resolve(); f.close(); }
});

test("backend failure attributes the first pending egress settlement on the error path", async () => {
  const { WsHost } = await import("../src/ws/host");
  const { runSession } = await import("../src/ws/run-session");
  const { createSessionCatalog } = await import("../src/ws/session-catalog");
  const { createStaticBackendRegistry } = await import("../src/agent/backend");
  const { createActivityStream } = await import("../src/activity/stream");
  const { makeFakeBackend } = await import("./helpers/fake-backend");
  const { testAuthorization } = await import("./helpers/principal");
  const entry = await import("../src/ws/session-run/backend-entry");
  const db = createUiDb(":memory:"), store = createActivityStore(db), stream = createActivityStream(store); let now = 1000;
  const clock = spyOn(Date, "now").mockImplementation(() => now); let settled = false;
  const prepare = spyOn(entry, "prepareRelayedEgress").mockImplementation(async run => {
    run.held.turnEgress = { async settled() { if (!settled) { now += 500; settled = true; } }, stop() {}, recordingFailure() {} } as unknown as NonNullable<TurnRun["held"]["turnEgress"]>;
  });
  const backend = makeFakeBackend({ id: "pi", async startTurn() { now = 1100; throw Error("backend unavailable"); } });
  const host = new WsHost({ registry: createStaticBackendRegistry([backend], "pi"), catalog: createSessionCatalog(() => db), activity: { store, stream } });
  try {
    await runSession(host, { authorization: testAuthorization("odysseus"), text: "Plan Ithaca", attachments: [] });
    expect(store.lifecycles()[0]!.openSubPhases?.filter(step => step.name === "egress_settle").map(step => step.elapsedMs), "ERROR_PATH_KEEPS_FIRST_EGRESS_WAIT").toEqual([500, 0]);
  } finally { prepare.mockRestore(); clock.mockRestore(); host.close(); stream.close(); db.close(); }
});

test("failed scope writes and absent scope admission never report scope completion", async () => {
  const { scopeFixture } = await import("./helpers/scope-fixture");
  for (const admitted of [false, true]) {
    const scope = scopeFixture(), f = fixture();
    try {
      if (admitted) {
        await scope.begin();
        scope.db.exec("CREATE TEMP TRIGGER refuse_scope_updates BEFORE UPDATE ON turn_scope BEGIN SELECT RAISE(FAIL, 'scope storage unavailable'); END");
      }
      Object.assign(f.run.host, { scope: scope.scope }); f.run.turn.turnId = "voyage";
      await teardownTurn(f.run, outcome);
      expect(f.store.lifecycle("turn-ithaca")!.openSubPhases?.find(step => step.name === "scope_finish")?.endedAt,
        "FAILED_OR_UNOPENED_SCOPE_IS_NOT_COMPLETE").toBeNull();
      if (admitted) expect(scope.db.query("SELECT ended_at FROM turn_scope WHERE turn_id='voyage'").get()).toEqual({ ended_at: null });
    } finally { f.close(); await scope.close(); }
  }
});

for (const mode of ["catalog", "history", "timeout"] as const) test(`failed replay ${mode} remains incomplete in closing evidence`, async () => {
  const { FailureReplay } = await import("../src/ws/turn-failures");
  const { makeFakeBackend } = await import("./helpers/fake-backend");
  const f = fixture();
  const backend = makeFakeBackend({ id: "pi", async getHistory() {
    if (mode === "history") throw Error("history unavailable");
    if (mode === "timeout") return new Promise(() => {});
    return [{ role: "assistant", content: "Odysseus returns.", toolCalls: [] }];
  } });
  const replay = new FailureReplay({ recordTurnBoundary() { throw Error("catalog unavailable"); } } as unknown as import("../src/ws/session-catalog").SessionCatalog,
    { emit() {} } as unknown as import("@opentelemetry/api-logs").Logger, 5);
  try {
    Object.assign(f.run, { failureRecording: await replay.begin(backend, undefined, "turn-ithaca", new AbortController().signal) });
    await teardownTurn(f.run, outcome);
    expect(f.store.lifecycle("turn-ithaca")!.openSubPhases?.find(step => step.name === "failure_recording")?.endedAt,
      "FAILED_REPLAY_RECORDING_IS_NOT_COMPLETE").toBeNull();
    await replay.wait("ithaca");
  } finally { f.close(); }
});

test("a failed replay failure write reports false even when its boundary succeeds", async () => {
  const { FailureReplay } = await import("../src/ws/turn-failures");
  const { makeFakeBackend } = await import("./helpers/fake-backend");
  const failure = { message: "Odysseus cannot finish." } as import("@schlessera/brain-ui-sdk/protocol").TurnFailure;
  const replay = new FailureReplay({ recordTurnFailure() { throw Error("failure ledger unavailable"); } } as unknown as import("../src/ws/session-catalog").SessionCatalog,
    { emit() {} } as unknown as import("@opentelemetry/api-logs").Logger);
  const backend = makeFakeBackend({ id: "pi", async getHistory() { return [{ role: "assistant", content: "", toolCalls: [], failure }]; } });
  const recording = await replay.begin(backend, undefined, "turn-ithaca", new AbortController().signal);
  recording.observe("ithaca", failure);
  expect(await recording.finish("ithaca"), "FAILED_FAILURE_WRITE_IS_NOT_SUCCESS").toBe(false);
});

test("teardown unregisters hold evidence even when share cleanup rejects", async () => {
  const f = fixture(), evidence: string[] = [];
  Object.assign(f.run.host, { journal: { async finish() {}, evidence(turnId: string) { evidence.push(turnId); } },
    inboxTools: { shares: { async end() { throw Error("share cleanup unavailable"); } } } });
  try {
    await expect(teardownTurn(f.run, outcome)).rejects.toThrow("share cleanup unavailable");
    expect(evidence, "FAILED_TEARDOWN_RELEASES_EVIDENCE_CALLBACK").toEqual(["turn-ithaca"]);
  } finally { f.close(); }
});

test("a failed index barrier leaves its closing step incomplete", async () => {
  const { WsHost } = await import("../src/ws/host");
  const { runSession } = await import("../src/ws/run-session");
  const { createSessionCatalog } = await import("../src/ws/session-catalog");
  const { createStaticBackendRegistry } = await import("../src/agent/backend");
  const { createActivityStream } = await import("../src/activity/stream");
  const { makeFakeBackend } = await import("./helpers/fake-backend");
  const { testAuthorization } = await import("./helpers/principal");
  const bridge = await import("../src/ws/bridge");
  const barrier = spyOn(bridge, "settleTurnIndex").mockRejectedValue(Error("index unavailable"));
  const db = createUiDb(":memory:"), store = createActivityStore(db), stream = createActivityStream(store);
  const host = new WsHost({ registry: createStaticBackendRegistry([makeFakeBackend({ id: "pi" })], "pi"), catalog: createSessionCatalog(() => db), activity: { store, stream } });
  try {
    await runSession(host, { authorization: testAuthorization("odysseus"), text: "Plan Ithaca", attachments: [] });
    const steps = store.lifecycles()[0]!.openSubPhases?.filter(step => step.name === "index_settle");
    expect(steps?.length).toBeGreaterThan(0);
    expect(steps?.every(step => step.endedAt === null), "FAILED_INDEX_SETTLEMENT_IS_NOT_COMPLETE").toBe(true);
  } finally { barrier.mockRestore(); host.close(); stream.close(); db.close(); }
});

test("authority revoked during billing still times reached failure cleanup", async () => {
  const { WsHost } = await import("../src/ws/host");
  const { runSession } = await import("../src/ws/run-session");
  const { createSessionCatalog } = await import("../src/ws/session-catalog");
  const { createStaticBackendRegistry } = await import("../src/agent/backend");
  const { createActivityStream } = await import("../src/activity/stream");
  const { makeFakeBackend } = await import("./helpers/fake-backend");
  const { testAuthorization } = await import("./helpers/principal");
  const billing = await import("../src/ws/session-run/billing");
  const authorization = testAuthorization("odysseus");
  const revoke = spyOn(billing, "resolveRunBilling").mockImplementation(async () => { authorization.valid = false; return undefined; });
  const db = createUiDb(":memory:"), store = createActivityStore(db), stream = createActivityStream(store);
  const host = new WsHost({ registry: createStaticBackendRegistry([makeFakeBackend({ id: "pi" })], "pi"), catalog: createSessionCatalog(() => db), activity: { store, stream } });
  try {
    await runSession(host, { authorization, text: "Plan Ithaca", attachments: [] });
    const step = store.lifecycles()[0]!.openSubPhases?.find(step => step.name === "failure_recording");
    expect(step?.endedAt, "BILLING_REVOCATION_RECORDS_REACHED_CLEANUP").toBeNumber();
  } finally { revoke.mockRestore(); host.close(); stream.close(); db.close(); }
});

test("real catalog write failure is reflected by replay completion despite its logged catch", async () => {
  const { FailureReplay } = await import("../src/ws/turn-failures");
  const { createSessionCatalog } = await import("../src/ws/session-catalog");
  const { makeFakeBackend } = await import("./helpers/fake-backend");
  const db = createUiDb(":memory:");
  db.exec("INSERT INTO sessions(id,title,created_at,last_active_at) VALUES ('ithaca','Voyage',0,0)");
  db.exec("CREATE TEMP TRIGGER refuse_failure BEFORE INSERT ON turn_failures BEGIN SELECT RAISE(FAIL, 'failure storage unavailable'); END");
  const catalog = createSessionCatalog(() => db);
  const failure = { message: "Odysseus cannot finish." } as import("@schlessera/brain-ui-sdk/protocol").TurnFailure;
  const backend = makeFakeBackend({ id: "pi", async getHistory() { return [{ role: "assistant", content: "", toolCalls: [], failure }]; } });
  const replay = new FailureReplay(catalog, { emit() {} } as unknown as import("@opentelemetry/api-logs").Logger);
  try {
    const recording = await replay.begin(backend, undefined, "turn-ithaca", new AbortController().signal);
    recording.observe("ithaca", failure);
    expect(await recording.finish("ithaca"), "REAL_CATALOG_FAILURE_CANNOT_COMPLETE_REPLAY_STEP").toBe(false);
    await catalog.settled?.();
    expect(db.query("SELECT count(*) AS count FROM turn_failures").get()).toEqual({ count: 0 });
  } finally { db.close(); }
});

test("pending catalog writes do not add a wait or claim completion", async () => {
  const { FailureReplay } = await import("../src/ws/turn-failures");
  const { makeFakeBackend } = await import("./helpers/fake-backend");
  const stored = Promise.withResolvers<boolean>();
  const replay = new FailureReplay({ recordTurnBoundary() { return stored.promise; } } as unknown as import("../src/ws/session-catalog").SessionCatalog,
    { emit() {} } as unknown as import("@opentelemetry/api-logs").Logger);
  const backend = makeFakeBackend({ id: "pi", async getHistory() { return [{ role: "assistant", content: "Odysseus returns.", toolCalls: [] }]; } });
  try {
    const recording = await replay.begin(backend, undefined, "turn-ithaca", new AbortController().signal);
    expect(await recording.finish("ithaca"), "PENDING_CATALOG_WRITE_IS_UNCONFIRMED_WITHOUT_NEW_WAIT").toBe(false);
  } finally { stored.resolve(true); }
});

test("scope finalization reports the real outcome of both database writes", async () => {
  const { scopeFixture } = await import("./helpers/scope-fixture");
  for (const fail of [false, true]) {
    const scope = scopeFixture();
    try {
      await scope.begin();
      if (fail) scope.db.exec("CREATE TEMP TRIGGER refuse_scope_final BEFORE UPDATE ON turn_scope BEGIN SELECT RAISE(FAIL, 'scope storage unavailable'); END");
      expect(await scope.scope.finish("voyage"), "SCOPE_FINAL_WRITES_REPORT_ACTUAL_SUCCESS").toBe(!fail);
      expect(await scope.scope.finish("unopened"), "UNOPENED_SCOPE_IS_NOT_SUCCESS").toBe(false);
    } finally { await scope.close(); }
  }
});


test("a disappeared scope row cannot produce successful finalization", async () => {
  const { scopeFixture } = await import("./helpers/scope-fixture");
  const scope = scopeFixture();
  try {
    await scope.begin(); scope.db.exec("DELETE FROM turn_scope WHERE turn_id='voyage'");
    expect(await scope.scope.finish("voyage"), "MISSING_SCOPE_ROW_CANNOT_CONFIRM_FINAL_WRITES").toBe(false);
  } finally { await scope.close(); }
});

test("reader hold expiry does not poison later successful failure recording", async () => {
  const { FailureReplay } = await import("../src/ws/turn-failures");
  const { makeFakeBackend } = await import("./helpers/fake-backend");
  let boundaries = 0;
  const replay = new FailureReplay({ recordTurnBoundary() { boundaries++; return true; } } as unknown as import("../src/ws/session-catalog").SessionCatalog,
    { emit() {} } as unknown as import("@opentelemetry/api-logs").Logger, 5);
  const backend = makeFakeBackend({ id: "pi", async getHistory() { return [{ role: "assistant", content: "Odysseus returns.", toolCalls: [] }]; } });
  const recording = await replay.begin(backend, undefined, "turn-ithaca", new AbortController().signal);
  recording.resulted("ithaca"); await replay.wait("ithaca");
  expect(await recording.finish("ithaca"), "READER_HOLD_EXPIRY_IS_NOT_RECORDING_FAILURE").toBe(true);
  expect(boundaries).toBe(1);
});

test("catalog confirmation proves the requested turn and failure survived an ignored conflict", async () => {
  const { createSessionCatalog } = await import("../src/ws/session-catalog");
  const db = createUiDb(":memory:"), catalog = createSessionCatalog(() => db);
  db.exec("INSERT INTO sessions(id,title,created_at,last_active_at) VALUES ('ithaca','Voyage',0,0)");
  const boundary = { turnId: "turn-first", assistantOrdinal: 0, prefixDigest: "ithaca-digest" };
  const failure = { message: "Odysseus cannot finish." } as import("@schlessera/brain-ui-sdk/protocol").TurnFailure;
  try {
    expect(await catalog.recordTurnBoundary?.("ithaca", "pi", boundary)).toBe(true);
    expect(await catalog.recordTurnBoundary?.("ithaca", "pi", boundary)).toBe(true);
    expect(await catalog.recordTurnBoundary?.("ithaca", "pi", { ...boundary, turnId: "turn-second" }), "CONFLICT_IS_NOT_THIS_TURNS_BOUNDARY").toBe(false);
    expect(await catalog.recordTurnFailure?.("ithaca", "pi", { ...boundary, failure })).toBe(true);
    expect(await catalog.recordTurnFailure?.("ithaca", "pi", { ...boundary, failure })).toBe(true);
    expect(await catalog.recordTurnFailure?.("ithaca", "pi", { ...boundary, turnId: "turn-second", failure }), "CONFLICT_IS_NOT_THIS_TURNS_FAILURE").toBe(false);
    expect(await catalog.recordTurnFailure?.("ithaca", "pi", { ...boundary, failure: { ...failure, message: "A different failure." } }), "IGNORED_FAILURE_PAYLOAD_IS_NOT_CONFIRMATION").toBe(false);
  } finally { await catalog.settled?.(); db.close(); }
});

test("backend exit confirmation uses one clock read even across a ticking millisecond", async () => {
  const { WsHost } = await import("../src/ws/host");
  const { runSession } = await import("../src/ws/run-session");
  const { createSessionCatalog } = await import("../src/ws/session-catalog");
  const { createStaticBackendRegistry } = await import("../src/agent/backend");
  const { createActivityStream } = await import("../src/activity/stream");
  const { makeFakeBackend } = await import("./helpers/fake-backend");
  const { testAuthorization } = await import("./helpers/principal");
  let now = 1000; const clock = spyOn(Date, "now").mockImplementation(() => ++now);
  const db = createUiDb(":memory:"), store = createActivityStore(db), stream = createActivityStream(store);
  const host = new WsHost({ registry: createStaticBackendRegistry([makeFakeBackend({ id: "pi" })], "pi"), catalog: createSessionCatalog(() => db), activity: { store, stream } });
  try {
    await runSession(host, { authorization: testAuthorization("odysseus"), text: "Plan Ithaca", attachments: [] });
    const step = store.lifecycles()[0]!.openSubPhases?.find(step => step.name === "backend_exit");
    expect(step, "BACKEND_EXIT_IS_ONE_ZERO_WIDTH_OBSERVATION").toBeDefined();
    expect(step!.endedAt, "BACKEND_EXIT_IS_ONE_ZERO_WIDTH_OBSERVATION").toBe(step!.startedAt); expect(step!.elapsedMs).toBe(0);
  } finally { clock.mockRestore(); host.close(); stream.close(); db.close(); }
});

test("failed egress recording leaves settlement incomplete on success and backend-error paths", async () => {
  const { WsHost } = await import("../src/ws/host"), { runSession } = await import("../src/ws/run-session");
  const { createSessionCatalog } = await import("../src/ws/session-catalog"), { createStaticBackendRegistry } = await import("../src/agent/backend");
  const { createActivityStream } = await import("../src/activity/stream"), { makeFakeBackend } = await import("./helpers/fake-backend");
  const { testAuthorization } = await import("./helpers/principal"), entry = await import("../src/ws/session-run/backend-entry");
  for (const backendError of [false, true]) {
    const db = createUiDb(":memory:"), store = createActivityStore(db), stream = createActivityStream(store);
    const prepare = spyOn(entry, "prepareRelayedEgress").mockImplementation(async run => {
      run.held.turnEgress = { async settled() {}, stop() {}, recordingFailure() { return Error("egress audit failed"); } } as unknown as NonNullable<TurnRun["held"]["turnEgress"]>;
    });
    const backend = makeFakeBackend({ id: "pi", async startTurn() { if (backendError) throw Error("backend failed"); } });
    const host = new WsHost({ registry: createStaticBackendRegistry([backend], "pi"), catalog: createSessionCatalog(() => db), activity: { store, stream } });
    try {
      await runSession(host, { authorization: testAuthorization("odysseus"), text: "Plan Ithaca", attachments: [] });
      const steps = store.lifecycles()[0]!.openSubPhases!.filter(step => step.name === "egress_settle");
      expect(steps.length).toBeGreaterThan(0);
      expect(steps.every(step => step.endedAt === null), "FAILED_EGRESS_RECORDING_CANNOT_COMPLETE_SETTLEMENT").toBe(true);
    } finally { prepare.mockRestore(); host.close(); stream.close(); db.close(); }
  }
});

test("a throwing lifecycle clock leaves marks missing without escaping its callbacks", () => {
  const f = fixture(); let fail = false;
  try {
    const lifecycle = createTurnLifecycle(f.store, "turn-loom", "ithaca", 1000, () => {}, () => { if (fail) throw Error("clock failed"); return 1000; });
    const end = lifecycle.timer("closing")("unfinished"); fail = true;
    expect(() => { end(); lifecycle.timer("closing")("missing"); lifecycle.backendExit(); lifecycle.mark("failureObservedAt"); lifecycle.finish("error"); }, "TIMING_CLOCK_FAILURE_NEVER_ESCAPES").not.toThrow();
    fail = false; lifecycle.finish("error");
    expect(f.store.lifecycle("turn-loom")!.openSubPhases).toEqual([{ phase: "closing", name: "unfinished", startedAt: 1000, endedAt: null, elapsedMs: 0 }]);
  } finally { f.close(); }
});

test("a diagnostic-only egress failure probe cannot fail teardown", async () => {
  const f = fixture();
  f.run.held.turnEgress = { async settled() {}, stop() {}, recordingFailure() { throw Error("diagnostic unavailable"); } } as unknown as NonNullable<TurnRun["held"]["turnEgress"]>;
  try {
    let error: unknown;
    try { await teardownTurn(f.run, outcome); } catch (caught) { error = caught; }
    expect(error, "DIAGNOSTIC_EGRESS_PROBE_CANNOT_FAIL_TEARDOWN").toBeUndefined();
    expect(f.store.lifecycle("turn-ithaca")!.openSubPhases!.find(step => step.name === "egress_settle")!.endedAt).toBeNull();
  } finally { f.close(); }
});
