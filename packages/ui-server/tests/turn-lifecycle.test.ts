import packageInfo from "@schlessera/brain-ui-server/package.json" with { type: "json" };
import * as perfHooks from "node:perf_hooks";
import { expect, spyOn, test } from "bun:test";
import { createUiDb } from "../src/db/client.js";
import { createActivityStore } from "../src/activity/store.js";
import { createTurnLifecycle } from "../src/activity/turn-lifecycle.js";
import { createTurnRecorder } from "../src/activity/recorder.js";
import { createActivityRoutes } from "../src/routes/activity.js";

test("enclosing milestones retain admission and preserve backend duration and one usage rollup", async () => {
  const db = createUiDb(":memory:");
  try {
    const store = createActivityStore(db); let now = 1000;
    const lifecycle = createTurnLifecycle(store,"turn-ithaca","ithaca",now,()=>{},()=>now);
    now=1100; lifecycle.mark("dequeuedAt");
    lifecycle.mark("governedStartedAt"); now=1300; lifecycle.mark("governedAcquiredAt");
    lifecycle.mark("budgetStartedAt"); now=1400; lifecycle.mark("budgetAdmittedAt");
    lifecycle.mark("journalStartedAt"); now=1700; lifecycle.mark("journalBeganAt");
    lifecycle.mark("backendInvokedAt"); now=2100; lifecycle.firstFrame(null);
    store.startSpan({spanId:"backend",runId:"turn-ithaca",name:"invoke_agent",kind:"turn",origin:"session",startedAt:2100});
    lifecycle.linkBackend("turn-ithaca");
    store.endSpan("backend",{outcome:"success",endedAt:2600,usage:{inputTokens:10,outputTokens:5,costUsd:0.02}});
    store.rollupRun("turn-ithaca");
    now=2700; lifecycle.finish("success");
    const record=store.lifecycle("turn-ithaca")!;
    expect(record).toMatchObject({acceptedAt:1000,endedAt:2700,firstFrameAt:2100,totalElapsedMs:1700,timeToFirstFrameMs:1100,
      queueWaitMs:100,governedAdmissionMs:200,budgetAdmissionMs:100,journalBeginMs:300,backendStartupMs:400,backendRunId:"turn-ithaca"});
    expect(store.runRollup!("turn-ithaca")!.durationMs).toBe(500);
    expect(db.query("SELECT COUNT(*) AS n FROM activity_run_rollups").get()).toEqual({n:1});
    const response=await createActivityRoutes({db,store}).request("/activity/runs/turn-ithaca");
    expect((await response.json()).lifecycle).toEqual(record);
    expect(store.lifecycleChangesSince(0).at(-1)).toMatchObject({lifecycle:record});
  } finally { db.close(); }
});

for (const outcome of ["denied","cancelled","error"] as const) test(`${outcome} before backend frame keeps actual incomplete admission and no backend run`,async()=>{
  const db=createUiDb(":memory:");
  try {
    const store=createActivityStore(db); let now=1000;
    const lifecycle=createTurnLifecycle(store,"turn-loom","ithaca",now,()=>{},()=>now);
    lifecycle.mark("governedStartedAt"); now=1300; lifecycle.mark("failureObservedAt"); now=1350; lifecycle.finish(outcome,"Stopped during admission");
    const recorder=createTurnRecorder({store},{turnId:"turn-loom",sessionId:"ithaca",lifecycle});
    recorder.finish(outcome === "denied" ? "error" : outcome);
    expect(store.lifecycle("turn-loom")).toMatchObject({outcome,totalElapsedMs:350,governedAdmissionMs:300,governedAcquiredAt:null,
      backendRunId:null,firstFrameAt:null,budgetAdmissionMs:null,backendStartupMs:null});
    expect(store.snapshotRun("turn-loom")).toBeNull();
    expect(store.runRollup!("turn-loom")).toBeNull();
    const response=await createActivityRoutes({db,store}).request("/activity/runs/turn-loom");
    expect(response.status).toBe(200);
    lifecycle.mark("firstFrameAt",1600); lifecycle.finish("success");
    expect(store.lifecycle("turn-loom")!.outcome).toBe(outcome);
  } finally {db.close();}
});

test("restart recovers admission-only records, historical runs stay unknown, late observations cannot reopen",()=>{
  const db=createUiDb(":memory:");
  try {
    const store=createActivityStore(db); const live=createTurnLifecycle(store,"turn-loom","ithaca",Date.now()-200,()=>{});
    live.mark("governedStartedAt");
    expect(store.sweepOwnOrphans()).toBe(1);
    expect(store.lifecycle("turn-loom")).toMatchObject({outcome:"interrupted",backendRunId:null,firstFrameAt:null});
    live.firstFrame("turn-loom");live.finish("success");
    expect(store.lifecycle("turn-loom")!.outcome).toBe("interrupted");
    expect(store.lifecycle("historical")).toBeNull();
  }finally{db.close();}
});

test("recording and stream failures never break the observed turn",()=>{
  const db=createUiDb(":memory:");const store=createActivityStore(db);db.close();
  const record=createTurnLifecycle(store,"turn-loom",null,1000,()=>{throw Error("stream unavailable");},()=>1200);
  expect(()=>{record.mark("governedStartedAt");record.firstFrame(null);record.finish("error");}).not.toThrow();
});


test("real dispatch records delayed governed admission and first frame, and links only actual backend execution", async () => {
  const { WsHost } = await import("../src/ws/host.js");
  const { runSession } = await import("../src/ws/run-session.js");
  const { createSessionCatalog } = await import("../src/ws/session-catalog.js");
  const { createStaticBackendRegistry } = await import("../src/agent/backend.js");
  const { createActivityStream } = await import("../src/activity/stream.js");
  const { createGovernancePolicyReader } = await import("../src/brain/governance-policy.js");
  const { makeFakeBackend } = await import("./helpers/fake-backend.js");
  const { testAuthorization } = await import("./helpers/principal.js");
  const { spyOn } = await import("bun:test");
  const db=createUiDb(":memory:"), store=createActivityStore(db), stream=createActivityStream(store);
  let now=1000; const clock=spyOn(Date,"now").mockImplementation(()=>now);
  const monotonic=spyOn(performance,"now").mockImplementation(()=>now);
  const policy=createGovernancePolicyReader("/nonexistent-odysseus-fixture").load();
  const backend=makeFakeBackend({id:"pi",async startTurn(request){
    const end = request.startupTiming?.start("host_probe"); now=1500; end?.();
    request.startupTiming?.worker("resources", 37);
    request.startupTiming?.missing("mcp_connect:brain");
    now=1600; request.startupTiming?.received();
    now=1650; request.startupTiming?.worker("cli_time_to_request", 18);
    now=1700;request.bridge.emit({type:"session_info",sessionId:"ithaca",isNew:true});
    now=1900;request.bridge.emit({type:"result",sessionId:"ithaca",durationMs:200,numTurns:1,isError:false,costUsd:0});
  }});
  const host=new WsHost({registry:createStaticBackendRegistry([backend],"pi"),catalog:createSessionCatalog(()=>db),activity:{store,stream},
    governedTurns:{async begin(...args:unknown[]){const timing=args[5] as ((name:string)=>()=>void)|undefined;const end=timing?.("gate_acquire");now=1400;end?.();return {sandbox:{profile:"strict",areas:[],noteFacts:{}},policy,async end(){now=2000;return null;}};},refresh(){},async close(){},async bindSession(){},async exposures(){return [];},facts(){return {policyProfile:"strict",policy};}} as unknown as import("../src/brain/governed-turn.js").GovernedTurns});
  try {
    await runSession(host,{authorization:testAuthorization("odysseus"),text:"Plan Ithaca",attachments:[]});
    const record=store.lifecycles()[0]!;
    expect(record.subPhases?.filter(step => step.phase === "governed"),"DISPATCH_PASSES_THE_GOVERNED_STEP_TIMER").toEqual([{phase:"governed",name:"gate_acquire",startedAt:1000,endedAt:1400,elapsedMs:400}]);
    expect(record.openSubPhases?.filter(step => step.phase === "backend"),"DISPATCH_PERSISTS_BACKEND_STEPS").toEqual([
      {phase:"backend",name:"host_probe",startedAt:1400,endedAt:1500,elapsedMs:100},
      {phase:"backend",name:"first_relay_request",startedAt:1400,endedAt:1600,elapsedMs:200},
      {phase:"backend",name:"resources",startedAt:1500,endedAt:1500,elapsedMs:37,timeBase:"worker",workerElapsedMs:37},
      {phase:"backend",name:"cli_time_to_request",startedAt:1650,endedAt:1650,elapsedMs:18,timeBase:"worker",workerElapsedMs:18},
    ]);
    expect(record.backendMissingEvidence).toEqual(["mcp_connect:brain"]);
    expect(record.firstRelayRequestAt).toBe(1600);
    expect(record).toMatchObject({acceptedAt:1000,governedStartedAt:1000,governedAcquiredAt:1400,backendInvokedAt:1400,
      firstFrameAt:1700,endedAt:2000,sessionId:"ithaca",totalElapsedMs:1000,timeToFirstFrameMs:700,backendStartupMs:300,outcome:"success"});
    expect(record.admissionLoad?.atBackendStart?.cpuCount).toBeGreaterThan(0);
    expect(record.queueWaitMs).toBeNull();
    expect(record.backendRunId).toBe(record.turnId);
    expect(store.runRollup!(record.turnId)!.durationMs).toBe(200);
  }finally{monotonic.mockRestore();clock.mockRestore();host.close();stream.close();db.close();}
});


for (const mode of ["governed refusal","backend failure","revoked","budget refusal"] as const) test(`actual dispatch retains ${mode} before first frame`,async()=>{
  const { WsHost } = await import("../src/ws/host.js");
  const { runSession } = await import("../src/ws/run-session.js");
  const { createSessionCatalog } = await import("../src/ws/session-catalog.js");
  const { createStaticBackendRegistry } = await import("../src/agent/backend.js");
  const { createActivityStream } = await import("../src/activity/stream.js");
  const { createGovernancePolicyReader } = await import("../src/brain/governance-policy.js");
  const { BudgetExceeded, createTurnBudgets } = await import("../src/brain/turn-budgets.js");
  const { makeFakeBackend } = await import("./helpers/fake-backend.js");
  const { testAuthorization } = await import("./helpers/principal.js");
  const { spyOn } = await import("bun:test");
  const db=createUiDb(":memory:"),store=createActivityStore(db),stream=createActivityStream(store);
  let now=1000,entered=false;const clock=spyOn(Date,"now").mockImplementation(()=>now);
  const monotonic=spyOn(performance,"now").mockImplementation(()=>now);
  const authorization=testAuthorization("odysseus"),policy=createGovernancePolicyReader("/nonexistent-odysseus-fixture").load();
  const backend=makeFakeBackend({id:"pi",async startTurn(){entered=true;now=1600;throw Error("Backend startup failed");}});
  const observation: import("@schlessera/brain-ui-sdk/protocol").BudgetObservation = {scope:"turn",costUsd:200,blockUsd:200,warnUsd:100,tokens:null,blockTokens:512000000,unknownRuns:0,warning:true,blocked:true};
  const host=new WsHost({registry:createStaticBackendRegistry([backend],"pi"),catalog:createSessionCatalog(()=>db),activity:{store,stream},
    ...(mode === "budget refusal" ? {budgets:{...createTurnBudgets(db,{resolve:()=>null}),begin(){now=1500;throw new BudgetExceeded(observation,"admission");}}} : {}),
    governedTurns:{async begin(){now=1400;if(mode === "governed refusal")throw Error("Governed admission refused");if(mode === "revoked")authorization.valid=false;
      return {sandbox:{profile:"strict",areas:[],noteFacts:{}},policy,async end(){return null;}};},refresh(){},async close(){},async bindSession(){},async exposures(){return [];},facts(){return {policyProfile:"strict",policy};}} as unknown as import("../src/brain/governed-turn.js").GovernedTurns});
  try{
    await runSession(host,{authorization,text:"Plan Ithaca",attachments:[]});
    const record=store.lifecycles()[0]!;
    expect(record.backendRunId).toBeNull();expect(record.firstFrameAt).toBeNull();expect(store.snapshotRun(record.turnId)).toBeNull();
    expect(record.totalElapsedMs).toBe(mode === "backend failure" ? 600 : mode === "budget refusal" ? 500 : 400);
    expect(record.outcome).toBe(mode === "revoked" ? "cancelled" : mode === "budget refusal" ? "denied" : "error");
    expect(entered).toBe(mode === "backend failure");
    if (mode === "backend failure") expect(record.openSubPhases?.find(step => step.name === "backend_exit"))
      .toMatchObject({ phase: "closing", startedAt: 1600, endedAt: 1600, elapsedMs: 0 });
  }finally{monotonic.mockRestore();clock.mockRestore();host.close();stream.close();db.close();}
});

test("REST lifecycle detail cannot pair an older row with a newer floor", async () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db);
  const life = createTurnLifecycle(store, "ithaca-rest-race", "ithaca", 1000, () => {}, () => 1200);
  const view = { ...store, lifecycle(id: string) { const row = store.lifecycle(id); life.finish("success"); return row; },
    lifecycleSnapshot(id: string) { life.finish("success"); return store.lifecycleSnapshot!(id); } };
  try {
    const response = await createActivityRoutes({ db, store: view }).request("/activity/runs/ithaca-rest-race");
    const detail = await response.json();
    expect(detail.lifecycle, "REST_LIFECYCLE_ROW_AND_FLOOR_ARE_CONSISTENT").toEqual(store.lifecycle("ithaca-rest-race"));
    expect(detail.lifecycleSeq).toBe(store.runHighWaterSeq("lifecycle:ithaca-rest-race"));
  } finally { db.close(); }
});

test("restart lifecycle close uses persisted observations after a backward wall-clock correction", async () => {
  const { spyOn } = await import("bun:test");
  const db = createUiDb(":memory:"), store = createActivityStore(db);
  let now = 1000; const life = createTurnLifecycle(store, "ithaca-restart-clock", "ithaca", now, () => {}, () => now);
  life.mark("backendInvokedAt"); now = 1200; life.startupTiming.start("host_probe")(); now = 1300; life.firstFrame(null);
  const clock = spyOn(Date, "now").mockReturnValue(900);
  try {
    store.sweepOwnOrphans();
    expect(store.lifecycle("ithaca-restart-clock"), "RECOVERY_CLOSE_USES_PERSISTED_CLOCK_BASIS").toMatchObject({ endedAt: 1300, totalElapsedMs: 300, outcome: "interrupted" });
  } finally { clock.mockRestore(); db.close(); }
});

test("build identity validates revision and retains runtime evidence with terminal milestones", () => {
  const db = createUiDb(":memory:");
  try {
    const store = createActivityStore(db); let now = 1000;
    const live = createTurnLifecycle(store, "turn-build", "ithaca", now, () => {}, () => now, "odysseus", { buildRevision: "ithaca+4278" });
    expect(store.lifecycle("turn-build"), "BUILD_IDENTITY_STAMPED_AT_ACCEPT").toMatchObject({ packageVersion: packageInfo.version, buildRevision: "ithaca+4278" });
    live.runtimeVersion("2.1.343");
    const end = live.timer("closing")("journal_finish"); now = 1400; end(); live.finish("success");
    const clientTiming = { sendToFirstHostFrameMs: 10 };
    expect(store.writeClientReceipt?.("turn-build", "odysseus", clientTiming), "BUILD_IDENTITY_KEEPS_RECEIPT_OWNERSHIP").toBe(true);
    now = 1500; live.mark("recorderSettledAt"); now = 1600; live.mark("idleEmittedAt");
    expect(store.lifecycle("turn-build")?.clientTiming, "OWNER_RECEIPT_SURVIVES_TRAILING_HOST_CLOCK_WRITES").toEqual(clientTiming);
    const raw = db.query("SELECT record FROM activity_turn_lifecycles WHERE turn_id=?").get("turn-build") as { record: string };
    expect(JSON.parse(raw.record), "CLIENT_RECEIPT_STAYS_OUTSIDE_HOST_CLOCK_RECORD").not.toHaveProperty("clientTiming");
    expect(store.lifecycle("turn-build")).toMatchObject({ runtimeVersion: "2.1.343", endedAt: 1400, recorderSettledAt: 1500, idleEmittedAt: 1600,
      openSubPhases: [{ phase: "closing", name: "journal_finish", startedAt: 1000, endedAt: 1400, elapsedMs: 400 }] });
    for (const [i, revision] of [undefined, "", "contains spaces", "x".repeat(65), "ithaca\n", "ithaca/secret"].entries()) {
      createTurnLifecycle(store, `turn-invalid-${i}`, null, now, () => {}, () => now, undefined, { buildRevision: revision });
      expect(store.lifecycle(`turn-invalid-${i}`)!.buildRevision).toBeUndefined();
    }
  } finally { db.close(); }
});

test("real dispatch attributes a queued index delay and final observation only to their closing steps", async () => {
  const { WsHost } = await import("../src/ws/host.js");
  const { runSession } = await import("../src/ws/run-session.js");
  const { createSessionCatalog } = await import("../src/ws/session-catalog.js");
  const { createStaticBackendRegistry } = await import("../src/agent/backend.js");
  const { createActivityStream } = await import("../src/activity/stream.js");
  const { createGovernancePolicyReader } = await import("../src/brain/governance-policy.js");
  const { makeFakeBackend } = await import("./helpers/fake-backend.js");
  const { testAuthorization } = await import("./helpers/principal.js");
  const { spyOn } = await import("bun:test");
  const bridges = await import("../src/ws/bridge.js");
  const db = createUiDb(":memory:"), store = createActivityStore(db), stream = createActivityStream(store);
  let now = 1000, pending = true, finished = false;
  const clock = spyOn(Date, "now").mockImplementation(() => now);
  const monotonic = spyOn(performance, "now").mockImplementation(() => now);
  const makeBridge = bridges.makeBridge;
  const setup = spyOn(bridges, "makeBridge").mockImplementation(async (...args) => {
    const bridge = await makeBridge(...args);
    bridges.applyIndexReads({ host: args[0], signal: new AbortController().signal }, bridge,
      { pending: () => pending, async barrier() { now += 500; pending = false; } } as import("../src/brain/index-batch.js").IndexBatch, undefined);
    return bridge;
  });
  const policy = createGovernancePolicyReader("/nonexistent-odysseus-fixture").load();
  const backend = makeFakeBackend({ id: "pi", async startTurn(req) {
    req.bridge.emit({ type: "session_info", sessionId: "ithaca", isNew: true });
    now = 1100; req.bridge.emit({ type: "result", sessionId: "ithaca", durationMs: 100, numTurns: 1, isError: false, costUsd: 0 });
  } });
  const host = new WsHost({ registry: createStaticBackendRegistry([backend], "pi"), catalog: createSessionCatalog(() => db), activity: { store, stream },
    governedTurns: { async begin() { return { sandbox: { profile: "strict", noteFacts: {}, areas: [] }, policy, async end() { return null; } }; }, refresh() {}, async close() {}, async bindSession() {}, async exposures() { return []; }, facts() { return { policyProfile: "strict", policy }; } } as unknown as import("../src/brain/governed-turn.js").GovernedTurns,
    journal: { async begin() {}, restrictedCheckouts() { return []; }, async finish(_id: string, timing?: import("../src/activity/turn-lifecycle.js").PhaseTimer) {
      if (finished) return; finished = true;
      const end = timing?.("final_observation"); now += 300; end?.();
    }, async bindSession() {}, summary() { return { state: "unknown" }; } } as unknown as import("../src/brain/turn-journal.js").TurnJournal });
  try {
    await runSession(host, { authorization: testAuthorization("odysseus"), text: "Plan Ithaca", attachments: [] });
    const record = store.lifecycles()[0]!;
    expect(record.openSubPhases?.filter(s => s.phase === "closing" && ["index_settle", "final_observation"].includes(s.name)), "CLOSING_DELAYS_ARE_ATTRIBUTED")
      .toEqual([{ phase: "closing", name: "index_settle", pending: true, indexSettle: { queuedPaths: 0, updates: 0, firstAlreadyRunning: false, updateMs: 0, lastOutcome: null }, startedAt: 1100, endedAt: 1600, elapsedMs: 500 },
        { phase: "closing", name: "final_observation", startedAt: 1600, endedAt: 1900, elapsedMs: 300 }]);
    expect(record.openSubPhases?.filter(s => s.name === "journal_finish").map(s => s.elapsedMs)).toEqual([300, 0]);
    expect(record).toMatchObject({ endedAt: 1900, recorderSettledAt: 1900, idleEmittedAt: 1900 });
  } finally { setup.mockRestore(); monotonic.mockRestore(); clock.mockRestore(); host.close(); stream.close(); db.close(); }
});

test("identical terminal replay emits no new change while a new trailing receipt does", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db);
  try {
    const life = createTurnLifecycle(store, "turn-replay", "ithaca", 1000, () => {}, () => 1100);
    life.finish("success"); const terminal = store.lifecycle("turn-replay")!;
    const count = () => (db.query("SELECT count(*) AS count FROM activity_changes").get() as { count: number }).count;
    const before = count(); store.writeLifecycle(terminal);
    expect(count(), "IDENTICAL_TERMINAL_REPLAY_IS_SILENT").toBe(before);
    store.writeLifecycle({ ...terminal, recorderSettledAt: 1200 });
    expect(count()).toBe(before + 1);
    store.writeLifecycle({ ...terminal, recorderSettledAt: 1200 });
    expect(count(), "IDENTICAL_TRAILING_RECEIPT_IS_SILENT").toBe(before + 1);
    store.writeLifecycle({ ...terminal, recorderSettledAt: 9999, idleEmittedAt: 1300 });
    expect(store.lifecycle("turn-replay")).toMatchObject({ recorderSettledAt: 1200, idleEmittedAt: 1300 });
  } finally { db.close(); }
});

test("admission load records a blocked loop and freezes at backend invocation", async () => {
  const db = createUiDb(":memory:");
  const monitor = spyOn(perfHooks, "monitorEventLoopDelay");
  try {
    const store = createActivityStore(db);
    const lifecycle = createTurnLifecycle(store, "ithaca-load", null, Date.now(), () => {});
    lifecycle.mark("dequeuedAt");
    await Bun.sleep(35);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60);
    await Bun.sleep(20);
    lifecycle.mark("backendInvokedAt");
    const load = store.lifecycle("ithaca-load")!.admissionLoad;
    expect(load?.eventLoopMaxMs, "ADMISSION_BLOCKED_LOOP_MAXIMUM").toBeGreaterThanOrEqual(55);
    expect(load?.eventLoopP99Ms).toBeGreaterThan(0);
    expect(load?.atDequeue?.cpuCount).toBeGreaterThan(0);
    expect(load?.atBackendStart?.load1).toBeGreaterThanOrEqual(0);
    const histogram = monitor.mock.results[0]!.value!;
    expect(histogram.enable(), "MONITOR_DISABLED_AT_BACKEND_START").toBe(true);
    histogram.disable();
    lifecycle.finish("success");
    expect(store.lifecycle("ithaca-load")!.admissionLoad).toEqual(load);
  } finally { monitor.mockRestore(); db.close(); }
});

test("terminal hold accounting counts shared stops once and partitions overlapping evidence", () => {
  const db = createUiDb(":memory:"), store = createActivityStore(db);
  try {
    const lifecycle = createTurnLifecycle(store, "ithaca-stops", null, 0, () => {}, () => 200);
    const hold = (stoppedAt: number | null, resumedAt: number | null, inferenceInFlight: boolean | null) =>
      lifecycle.hold({ holdId: "loom", cause: "periodic", causeTurnId: null, requestedAt: 12, stoppedAt, resumedAt, inferenceInFlight, changedPaths: null, otherTurnsStopped: 0 });
    hold(10, 30, false); hold(10, 30, false); hold(50, 65, true); hold(60, 70, null); hold(85, null, false);
    lifecycle.finish("success");
    expect(store.lifecycle("ithaca-stops")!.stoppedTime).toEqual({ totalMs: 40, intervals: 3, sharedHolds: 1, openHolds: 1,
      inferenceMs: 15, noInferenceMs: 20, unknownMs: 5 });
    const empty = createTurnLifecycle(store, "ithaca-empty", null, 0, () => {}, () => 200);
    for (const cause of ["begin", "finish"] as const) empty.hold({ holdId: cause, cause, causeTurnId: "ithaca-empty", requestedAt: 0,
      stoppedAt: null, resumedAt: null, changedPaths: null, otherTurnsStopped: 0, inferenceInFlight: null });
    empty.finish("success");
    expect(store.lifecycle("ithaca-empty")!.stoppedTime).toEqual({ totalMs: 0, intervals: 0, sharedHolds: 0, openHolds: 0,
      inferenceMs: 0, noInferenceMs: 0, unknownMs: 0 });
  } finally { db.close(); }
});
