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
    failureRecording: { async finish() {} }, held: {}, stops: {}, abortController: new AbortController() } as unknown as TurnRun;
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
  Object.assign(f.run.host, { scope: { finish() { entered.resolve(); return scope.promise; } } });
  f.run.failureRecording.finish = async () => { await final.promise; };
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
  Object.assign(f.run.host, { scope: { finish() { return scope.promise; } } });
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
