import { expect, spyOn, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import type { ActivityTurnHold } from "@schlessera/brain-ui-sdk/protocol";
import type { StartTurnRequest } from "@schlessera/brain-ui-sdk/server";
import { scopeFixture } from "./helpers/scope-fixture";
import { createActivityStore } from "../src/activity/store";
import { createTurnLifecycle } from "../src/activity/turn-lifecycle";

test("three tool holds share exact physical stop and resume evidence across turns without another owner identity", async () => {
  let now = 1000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const f = scopeFixture({}, () => now);
  const first: ActivityTurnHold[] = [], second: ActivityTurnHold[] = [];
  const store = createActivityStore(f.db);
  const voyage = createTurnLifecycle(store, "voyage", "ithaca", now, () => {}, () => now);
  const loom = createTurnLifecycle(store, "loom", "scheria", now, () => {}, () => now);
  const exit = Promise.withResolvers<number>();
  const events: string[] = [];
  const worker = (id: string) => ({ exited: exit.promise, freeze() { events.push(`${id}:stop`); now += 10; return true; },
    resume() { events.push(`${id}:resume`); now += 20; return true; }, kill() {} }) as unknown as Parameters<NonNullable<StartTurnRequest["workerStarted"]>>[0];
  try {
    await f.begin();
    f.db.query("INSERT INTO sessions(id,title,created_at,last_active_at) VALUES ('scheria','Loom',0,0)").run();
    await f.journal.begin("loom", { sessionId: "scheria", actor: "interactive", model: null, profile: "governed", policyHash: null }, () => {});
    await f.scope.begin("loom", { sessionId: "scheria", principalId: "penelope", origin: "interactive", profile: "governed", policy: f.policy,
      source: "policy", hardTimeoutMs: 60000, current: () => true, stop() {} });
    f.journal.evidence?.("voyage", hold => { first.push(hold); voyage.hold(hold); }, () => true);
    f.journal.evidence?.("loom", hold => { second.push(hold); loom.hold(hold); });
    f.scope.workerStarted("voyage", worker("voyage")); f.scope.workerStarted("loom", worker("loom"));
    for (let i = 0; i < 3; i++) {
      f.journal.toolStarted("voyage", `shell-${i}`, "bash", true);
      writeFileSync(join(f.brain, `ithaca-${i}.md`), "Odysseus reaches Ithaca.");
      const held = f.journal.toolEnded("voyage", `shell-${i}`);
      expect(events.slice(-2), "HOLD_STOPS_SYNCHRONOUSLY_BEFORE_RETURNING").toEqual(["voyage:stop", "loom:stop"]);
      await held;
    }
    expect(first, "THREE_TOOL_HOLDS_RECORDED").toHaveLength(3); expect(second).toHaveLength(3);
    expect(first.map(h => [h.cause, h.causeTurnId, h.toolUseId, h.otherTurnsStopped, h.inferenceInFlight, h.changedPaths]))
      .toEqual([0, 1, 2].map(i => ["tool", "voyage", `shell-${i}`, 1, true, 1]));
    expect(second.map(h => [h.causeTurnId, h.toolUseId, h.otherTurnsStopped, h.inferenceInFlight])).toEqual([[null, undefined, 1, false], [null, undefined, 1, false], [null, undefined, 1, false]]);
    expect(first.map(h => h.holdId)).toEqual(second.map(h => h.holdId));
    voyage.finish("success"); loom.finish("success");
    expect(store.lifecycle("voyage")!.holds, "HOLDS_RIDE_THE_EXISTING_TERMINAL_WRITE").toEqual(first);
    expect(store.lifecycle("loom")!.holds).toEqual(second);
    expect(first.map(h => [h.requestedAt, h.stoppedAt, h.resumedAt])).toEqual([[1000, 1010, 1040], [1060, 1070, 1100], [1120, 1130, 1160]]);
    expect(second.map(h => [h.stoppedAt, h.resumedAt])).toEqual([[1020, 1060], [1080, 1120], [1140, 1180]]);
  } finally { exit.resolve(0); await f.close(); clock.mockRestore(); }
});

test("the 15 second observation records a periodic hold and a failed resume stays unknown", async () => {
  const interval = globalThis.setInterval;
  let tick: (() => void) | undefined;
  const intervals = spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, ms: number, ...args: unknown[]) => {
    if (ms === 15000) tick = callback;
    return interval(callback, ms, ...args);
  }) as typeof setInterval);
  const f = scopeFixture();
  const holds: ActivityTurnHold[] = [];
  const exited = Promise.withResolvers<number>();
  try {
    await f.begin();
    f.journal.evidence?.("voyage", hold => holds.push(hold));
    f.scope.workerStarted("voyage", { exited: exited.promise, freeze() { return true; }, resume() { throw Error("resume unavailable"); }, kill() {} } as unknown as Parameters<NonNullable<StartTurnRequest["workerStarted"]>>[0]);
    expect(typeof tick).toBe("function"); tick!(); await f.journal.idle();
    expect(holds, "PERIODIC_HOLD_RECORDED").toHaveLength(1);
    expect(holds[0]).toMatchObject({ cause: "periodic", causeTurnId: null, resumedAt: null, changedPaths: 0 });
    expect(holds[0]!.stoppedAt).toBeGreaterThanOrEqual(holds[0]!.requestedAt);
    expect(f.stopped).toContain("could not resume");
  } finally { exited.resolve(0); await f.close(); intervals.mockRestore(); }
});

test("a hold samples a real inference stream in flight and a later hold sees it settled", async () => {
  const { startEgressProxy } = await import("@schlessera/brain-ui-sdk/internal");
  const { startInferenceRelay } = await import("@schlessera/brain-ui-sdk/internal");
  const { request } = await import("node:http");
  const f = scopeFixture();
  const holds: ActivityTurnHold[] = [];
  const streaming = Promise.withResolvers<void>();
  const workerExit = Promise.withResolvers<number>();
  let output!: ReadableStreamDefaultController<Uint8Array>;
  const upstream = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch() {
    return new Response(new ReadableStream<Uint8Array>({ start(controller) { output = controller; controller.enqueue(new TextEncoder().encode("Ithaca")); streaming.resolve(); } }));
  } });
  const proxy = await startEgressProxy({ mode: "record", allow: [], deny: [], outwardHosts: [], maxBytes: 100000, observe() {} });
  const relay = startInferenceRelay({ upstream: upstream.url.origin, routes: ["/v1/messages"], credentials: {}, egress: proxy });
  let done: Promise<string> | undefined;
  try {
    await f.begin();
    f.journal.evidence?.("voyage", hold => holds.push(hold), () => proxy.inferenceInFlight());
    done = new Promise<string>((resolve, reject) => {
      const req = request({ socketPath: relay.socketPath, method: "POST", path: "/v1/messages" }, response => {
        let body = ""; response.on("data", chunk => { body += chunk; }); response.on("end", () => resolve(body)); response.on("error", reject);
      }); req.on("error", reject); req.end("{}");
    });
    await streaming.promise;
    f.scope.workerStarted("voyage", { exited: workerExit.promise, freeze() { return true; }, resume() { return true; }, kill() {} } as unknown as Parameters<NonNullable<StartTurnRequest["workerStarted"]>>[0]);
    await f.journal.toolEnded("voyage", "shell-stream");
    expect(holds.map(h => h.inferenceInFlight), "HOLD_OVERLAPS_REAL_STREAM").toEqual([true]);
    output.close(); expect(await done).toBe("Ithaca");
    await f.journal.toolEnded("voyage", "shell-after");
    expect(holds.map(h => h.inferenceInFlight)).toEqual([true, false]);
  } finally { workerExit.resolve(0); relay.stop(); proxy.stop(); await done?.catch(() => {}); await upstream.stop(true); await f.close(); }
});

test("a scope cap records the initial freeze and only a confirmed grant resume", async () => {
  let now = 1000;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const f = scopeFixture({ max_tool_calls: 1 }, () => now);
  const holds: ActivityTurnHold[] = [];
  const exited = Promise.withResolvers<number>();
  try {
    await f.begin();
    f.journal.evidence?.("voyage", hold => holds.push(hold));
    f.scope.workerStarted("voyage", { exited: exited.promise, freeze() { now += 10; return true; }, resume() { now += 20; return true; }, kill() {} } as unknown as Parameters<NonNullable<StartTurnRequest["workerStarted"]>>[0]);
    f.scope.toolCall("voyage", "shell-1"); await f.journal.idle();
    const caps = holds.filter(h => h.cause === "scope" && h.causeTurnId === "voyage");
    expect(caps, "SCOPE_CAP_HOLD_RECORDED").toHaveLength(1);
    expect(caps[0]).toMatchObject({ requestedAt: 1000, stoppedAt: 1010, resumedAt: null, changedPaths: 0 });
    expect((await f.scope.decide(f.message("continue"), true)).state).toBe("accepted");
    expect(caps[0]!.resumedAt).toBe(1040);
  } finally { exited.resolve(0); await f.close(); clock.mockRestore(); }
});

async function addLoom(f: ReturnType<typeof scopeFixture>) {
  f.db.query("INSERT INTO sessions(id,title,created_at,last_active_at) VALUES ('scheria','Loom',0,0)").run();
  await f.journal.begin("loom", { sessionId: "scheria", actor: "interactive", model: null, profile: "governed", policyHash: null }, () => {});
  await f.scope.begin("loom", { sessionId: "scheria", principalId: "penelope", origin: "interactive", profile: "governed", policy: f.policy,
    source: "policy", hardTimeoutMs: 60000, current: () => true, stop() {} });
}

test("a late worker resamples inference and updates every affected turn's stopped count", async () => {
  const f = scopeFixture(); const first: ActivityTurnHold[] = [], second: ActivityTurnHold[] = [];
  const exited = Promise.withResolvers<number>(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const checkpoint = f.native.manager.checkpoint;
  let inFlight = false;
  const worker = () => ({ exited: exited.promise, freeze() { return true; }, resume() { return true; }, kill() {} }) as unknown as Parameters<NonNullable<StartTurnRequest["workerStarted"]>>[0];
  try {
    await f.begin(); await addLoom(f);
    f.journal.evidence("voyage", hold => first.push(hold)); f.journal.evidence("loom", hold => second.push(hold), () => inFlight);
    f.scope.workerStarted("voyage", worker());
    f.native.manager.checkpoint = async (...args) => { entered.resolve(); await release.promise; return checkpoint(...args); };
    const holding = f.journal.toolEnded("voyage", "shell-late"); await entered.promise;
    expect(first[0]!.otherTurnsStopped).toBe(0); expect(second[0]!.stoppedAt).toBeNull();
    inFlight = true; f.scope.workerStarted("loom", worker());
    expect(second[0]!.inferenceInFlight, "LATE_FREEZE_RESAMPLES_INFERENCE").toBe(true);
    expect([first[0]!.otherTurnsStopped, second[0]!.otherTurnsStopped], "LATE_FREEZE_REFRESHES_ALL_STOPPED_COUNTS").toEqual([1, 1]);
    release.resolve(); await holding;
    expect(second[0]!.resumedAt).toBeGreaterThanOrEqual(second[0]!.stoppedAt!);
  } finally { release.resolve(); exited.resolve(0); f.native.manager.checkpoint = checkpoint; await f.close(); }
});

test("granting continuation after the paused worker exited never invents a resume", async () => {
  const f = scopeFixture({ max_tool_calls: 1 }); const holds: ActivityTurnHold[] = [];
  const exited = Promise.withResolvers<number>(); let resumes = 0;
  try {
    await f.begin(); f.journal.evidence("voyage", hold => holds.push(hold));
    f.scope.workerStarted("voyage", { exited: exited.promise, freeze() { return true; }, resume() { resumes++; return true; }, kill() {} } as unknown as Parameters<NonNullable<StartTurnRequest["workerStarted"]>>[0]);
    f.scope.toolCall("voyage", "shell-exit"); await f.journal.idle(); exited.resolve(0); await exited.promise;
    expect((await f.scope.decide(f.message("continue"), true)).state).toBe("accepted");
    expect(resumes).toBe(0); expect(holds).toHaveLength(1);
    expect(holds.map(hold => hold.resumedAt), "NO_WORKER_MEANS_NO_RESUME_RECEIPT").toEqual([null]);
    const nextExit = Promise.withResolvers<number>();
    try {
      f.scope.workerStarted("voyage", { exited: nextExit.promise, freeze() { return true; }, resume() { resumes++; return true; }, kill() {} } as unknown as Parameters<NonNullable<StartTurnRequest["workerStarted"]>>[0]);
      await f.journal.observe();
      expect(resumes).toBe(1);
      expect(holds[0]!.resumedAt, "A_LATER_WORKER_CANNOT_COMPLETE_AN_EXPIRED_HOLD").toBeNull();
    } finally { nextExit.resolve(0); }
  } finally { exited.resolve(0); await f.close(); }
});

test("a scope observation shares its cap identity and preserves the triggering tool", async () => {
  const f = scopeFixture({ max_tool_calls: 1 }); const first: ActivityTurnHold[] = [], second: ActivityTurnHold[] = [];
  const exited = Promise.withResolvers<number>();
  const worker = () => ({ exited: exited.promise, freeze() { return true; }, resume() { return true; }, kill() {} }) as unknown as Parameters<NonNullable<StartTurnRequest["workerStarted"]>>[0];
  try {
    await f.begin(); await addLoom(f);
    f.journal.evidence("voyage", hold => first.push(hold)); f.journal.evidence("loom", hold => second.push(hold));
    f.scope.workerStarted("voyage", worker()); f.scope.workerStarted("loom", worker());
    f.scope.toolCall("voyage", "shell-cap"); await f.journal.idle();
    expect(first, "CAP_AND_OBSERVATION_SHARE_ONE_RECORD").toHaveLength(1); expect(second).toHaveLength(1);
    expect(first[0], "CAP_HOLD_RETAINS_TOOL_ATTRIBUTION").toMatchObject({ cause: "scope", causeTurnId: "voyage", toolUseId: "shell-cap", otherTurnsStopped: 1 });
    expect(second[0]).toMatchObject({ holdId: first[0]!.holdId, cause: "scope", causeTurnId: null, otherTurnsStopped: 1 });
    expect(second[0]!.toolUseId).toBeUndefined();
  } finally { exited.resolve(0); await f.close(); }
});

test("a file cap keeps the triggering observation's count through later quiet captures", async () => {
  const f = scopeFixture({ max_files_changed: 1 }); const holds: ActivityTurnHold[] = [];
  const exited = Promise.withResolvers<number>();
  try {
    await f.begin(); f.journal.evidence("voyage", hold => holds.push(hold));
    f.scope.workerStarted("voyage", { exited: exited.promise, freeze() { return true; }, resume() { return true; }, kill() {} } as unknown as Parameters<NonNullable<StartTurnRequest["workerStarted"]>>[0]);
    f.journal.toolStarted("voyage", "shell-files", "bash", true);
    writeFileSync(join(f.brain, "ithaca.md"), "Odysseus returns.\n"); await f.journal.toolEnded("voyage", "shell-files");
    const cap = holds.find(hold => hold.cause === "scope")!;
    expect(cap, "CAP_COUNT_IS_CAPTURED_WHEN_CREATED").toMatchObject({ changedPaths: 1, toolUseId: "shell-files" });
    await f.journal.observe();
    expect(cap.changedPaths, "QUIET_CAPTURE_CANNOT_OVERWRITE_CAP_COUNT").toBe(1);
  } finally { exited.resolve(0); await f.close(); }
});

test("one held settings operation unions changed paths across its final quiet observations", async () => {
  const f = scopeFixture(); const holds: ActivityTurnHold[] = [];
  try {
    await f.begin(); f.journal.evidence("voyage", hold => holds.push(hold));
    await f.journal.observeSettingsPolicy("ithaca-policy", async publish => {
      if (!publish) throw Error("Settings policy publication callback missing");
      await publish(() => { writeFileSync(join(f.brain, "ithaca.md"), "Odysseus returns.\n"); });
    });
    expect(holds).toHaveLength(1);
    expect(holds[0]!.changedPaths, "MULTIPLE_CAPTURES_KEEP_THE_UNION_OF_PATHS").toBe(1);
  } finally { await f.close(); }
});

test("a completed hold cannot acquire a stop from a later overlapping interval", async () => {
  const f = scopeFixture(), holds: ActivityTurnHold[] = [];
  const a = Promise.withResolvers<void>(), b = Promise.withResolvers<void>(), enteredA = Promise.withResolvers<void>(), enteredB = Promise.withResolvers<void>(), exited = Promise.withResolvers<number>();
  const checkpoint = f.native.manager.checkpoint; let calls = 0;
  try {
    await f.begin(); f.journal.evidence("voyage", hold => holds.push(hold));
    f.native.manager.checkpoint = async (...args) => { if (++calls === 1) { enteredA.resolve(); await a.promise; } else { enteredB.resolve(); await b.promise; } return checkpoint(...args); };
    const first = f.journal.toolEnded("voyage", "shell-a"); await enteredA.promise;
    const second = f.journal.toolEnded("voyage", "shell-b"); a.resolve(); await first; await enteredB.promise;
    f.scope.workerStarted("voyage", { exited: exited.promise, freeze() { return true; }, resume() { return true; }, kill() {} });
    expect(holds[0]!.stoppedAt, "COMPLETED_INTERVAL_CANNOT_ACQUIRE_LATER_STOP").toBeNull();
    expect(holds[1]!.stoppedAt).not.toBeNull();
    b.resolve(); await second;
  } finally { a.resolve(); b.resolve(); exited.resolve(0); f.native.manager.checkpoint = checkpoint; await f.close(); }
});

test("a gone process awaiting output cleanup produces no physical hold receipts", async () => {
  const { createWorkerFreezer } = await import("../../ui-sdk/src/server/worker-freezer");
  const f = scopeFixture(), first: ActivityTurnHold[] = [], second: ActivityTurnHold[] = [], exited = Promise.withResolvers<number>();
  const gone = createWorkerFreezer(2_147_483_647);
  try {
    await f.begin(); await addLoom(f);
    f.journal.evidence("voyage", hold => first.push(hold)); f.journal.evidence("loom", hold => second.push(hold));
    f.scope.workerStarted("voyage", { exited: exited.promise, freeze() { return true; }, resume() { return true; }, kill() {} });
    f.scope.workerStarted("loom", { ...gone, exited: exited.promise, kill() {} });
    await f.journal.toolEnded("voyage", "shell-gone");
    expect([second[0]!.stoppedAt, second[0]!.resumedAt, first[0]!.otherTurnsStopped], "EXITED_PROCESS_IS_NOT_A_CONFIRMED_STOP").toEqual([null, null, 0]);
    expect(gone.freeze(), "FREEZER_RETURNS_FALSE_FOR_EXITED_PROCESS").toBe(false);
    expect(gone.resume()).toBe(false);
  } finally { exited.resolve(0); await f.close(); }
});

test("policy writes and targeted retention keep their known causing turn", async () => {
  const f = scopeFixture(), holds: ActivityTurnHold[] = [];
  try {
    await f.begin(); f.journal.evidence("voyage", hold => holds.push(hold));
    await f.journal.observeUserPolicy("voyage", () => { writeFileSync(join(f.brain, "ithaca.md"), "Odysseus returns.\n"); });
    await f.journal.retainBefore("voyage", "ithaca.md");
    expect(holds.map(hold => hold.causeTurnId), "POLICY_AND_RETENTION_HOLDS_KEEP_CAUSING_TURN").toEqual(["voyage", "voyage"]);
  } finally { await f.close(); }
});

test("nested holds do not reuse stop proof after a frozen worker exits", async () => {
  const f = scopeFixture(), holds: ActivityTurnHold[] = [], exited = Promise.withResolvers<number>(), entered = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
  const checkpoint = f.native.manager.checkpoint; let live = true;
  try {
    await f.begin(); f.journal.evidence("voyage", hold => holds.push(hold));
    f.scope.workerStarted("voyage", { exited: exited.promise, freeze() { return live; }, frozen() { return live; }, resume() { return live; }, kill() {} });
    f.native.manager.checkpoint = async (...args) => { entered.resolve(); await release.promise; return checkpoint(...args); };
    const first = f.journal.toolEnded("voyage", "shell-stop"); await entered.promise;
    live = false; const second = f.journal.toolEnded("voyage", "shell-after-exit");
    expect(holds[0]!.stoppedAt).not.toBeNull();
    expect(holds[1]!.stoppedAt, "NESTED_HOLD_RECHECKS_CURRENT_STOP_EVIDENCE").toBeNull();
    release.resolve(); await Promise.all([first, second]);
    expect(holds[0]!.resumedAt).toBeNull();
  } finally { release.resolve(); exited.resolve(0); f.native.manager.checkpoint = checkpoint; await f.close(); }
});


test("a scope cap never offers Continue when every registered worker is already gone", async () => {
  const f = scopeFixture({ max_tool_calls: 1 }), exited = Promise.withResolvers<number>();
  try {
    await f.begin();
    f.scope.workerStarted("voyage", { exited: exited.promise, freeze() { return false; }, resume() { return false; }, kill() {} });
    f.scope.toolCall("voyage", "shell-gone");
    expect(f.receipt(), "GONE_WORKERS_CANNOT_PRODUCE_A_PAUSED_SCOPE").toMatchObject({ frozen: false, state: "stopped" });
    expect((await f.scope.decide(f.message("continue"), true)).state).not.toBe("accepted");
  } finally { exited.resolve(0); await f.close(); }
});

test("a throwing timing probe never fails the hold or prevents its worker resume", async () => {
  const f = scopeFixture(), exited = Promise.withResolvers<number>(); let kills = 0, resumes = 0;
  try {
    await f.begin();
    f.scope.workerStarted("voyage", { exited: exited.promise, freeze() {}, frozen() { throw Error("evidence denied"); }, resume() { resumes++; }, kill() { kills++; } });
    let captureError: unknown;
    try { await f.journal.toolEnded("voyage", "shell-evidence"); } catch (error) { captureError = error; }
    expect(captureError, "TIMING_PROBE_NEVER_CHANGES_HOLD_CONTROL").toBeUndefined();
    expect([kills, resumes, f.stopped], "TIMING_PROBE_NEVER_CHANGES_HOLD_CONTROL").toEqual([0, 1, ""]);
  } finally { exited.resolve(0); await f.close(); }
});

test("a replacement worker cannot complete an earlier hold owned by the exited worker", async () => {
  const f = scopeFixture(), holds: ActivityTurnHold[] = [];
  const oldExit = Promise.withResolvers<number>(), newExit = Promise.withResolvers<number>();
  const a = Promise.withResolvers<void>(), b = Promise.withResolvers<void>(), enteredA = Promise.withResolvers<void>(), enteredB = Promise.withResolvers<void>();
  const checkpoint = f.native.manager.checkpoint; let calls = 0, resumedOld = 0, resumedNew = 0;
  try {
    await f.begin(); f.journal.evidence("voyage", hold => holds.push(hold));
    f.scope.workerStarted("voyage", { exited: oldExit.promise, freeze() { return true; }, resume() { resumedOld++; return true; }, kill() {} });
    f.native.manager.checkpoint = async (...args) => { if (++calls === 1) { enteredA.resolve(); await a.promise; } else { enteredB.resolve(); await b.promise; } return checkpoint(...args); };
    const first = f.journal.toolEnded("voyage", "shell-old"); await enteredA.promise;
    const second = f.journal.toolEnded("voyage", "shell-new"); a.resolve(); await first; await enteredB.promise;
    oldExit.resolve(0); await oldExit.promise; await Promise.resolve();
    f.scope.workerStarted("voyage", { exited: newExit.promise, freeze() { return true; }, resume() { resumedNew++; return true; }, kill() {} });
    b.resolve(); await second;
    expect([resumedOld, resumedNew]).toEqual([0, 1]);
    expect(holds[0]!.resumedAt, "RESUME_MUST_BELONG_TO_THIS_HOLDS_WORKER").toBeNull();
    expect(holds[1]!.resumedAt).not.toBeNull();
  } finally { a.resolve(); b.resolve(); oldExit.resolve(0); newExit.resolve(0); f.native.manager.checkpoint = checkpoint; await f.close(); }
});

test("finished journal participants receive no new holds during remaining teardown", async () => {
  const f = scopeFixture(), first: ActivityTurnHold[] = [], second: ActivityTurnHold[] = [];
  try {
    await f.begin(); await addLoom(f);
    f.journal.evidence("voyage", hold => first.push(hold)); f.journal.evidence("loom", hold => second.push(hold));
    await f.journal.finish("voyage"); await f.scope.finish("voyage"); first.length = 0; second.length = 0;
    expect(f.journal.scopeHold("voyage", Date.now()), "FINISHED_WINDOW_CANNOT_CREATE_SCOPE_HOLD").toBeUndefined();
    writeFileSync(join(f.brain, "ithaca-after.md"), "Odysseus returns.\n");
    await f.journal.toolEnded("loom", "shell-active");
    expect(first, "FINISHED_PARTICIPANTS_CANNOT_ACQUIRE_NEW_HOLDS").toEqual([]);
    expect(second).toHaveLength(1); expect(second[0]!.changedPaths).toBe(1);
  } finally { await f.close(); }
});

test("a shared hold ends at its first owned productive resume, not a later worker call", async () => {
  let now = 1000; const clock = spyOn(Date, "now").mockImplementation(() => now);
  const f = scopeFixture({}, () => now), holds: ActivityTurnHold[] = [], exited = Promise.withResolvers<number>();
  try {
    await f.begin(); f.journal.evidence("voyage", hold => holds.push(hold));
    for (let i = 0; i < 2; i++) f.scope.workerStarted("voyage", { exited: exited.promise,
      freeze() { now += 10; return true; }, resume() { now += 20; return true; }, kill() {} });
    await f.journal.toolEnded("voyage", "shell-shared");
    expect(holds[0], "RESUME_CLOCK_IS_SAMPLED_AT_ITS_OWN_WORKER_BOUNDARY").toMatchObject({ stoppedAt: 1020, resumedAt: 1040 });
  } finally { exited.resolve(0); await f.close(); clock.mockRestore(); }
});
