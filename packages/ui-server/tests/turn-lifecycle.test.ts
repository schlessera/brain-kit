import { expect, test } from "bun:test";
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
  const policy=createGovernancePolicyReader("/nonexistent-odysseus-fixture").load();
  const backend=makeFakeBackend({id:"pi",async startTurn(request){
    now=1700;request.bridge.emit({type:"session_info",sessionId:"ithaca",isNew:true});
    now=1900;request.bridge.emit({type:"result",sessionId:"ithaca",durationMs:200,numTurns:1,isError:false,costUsd:0});
  }});
  const host=new WsHost({registry:createStaticBackendRegistry([backend],"pi"),catalog:createSessionCatalog(()=>db),activity:{store,stream},
    governedTurns:{async begin(){now=1400;return {sandbox:{profile:"strict",noteFacts:{}},policy,async end(){now=2000;return null;}};},refresh(){},async close(){},facts(){return {policyProfile:"strict",policy};}} as unknown as import("../src/brain/governed-turn.js").GovernedTurns});
  try {
    await runSession(host,{authorization:testAuthorization("odysseus"),text:"Plan Ithaca",attachments:[]});
    const record=store.lifecycles()[0]!;
    expect(record).toMatchObject({acceptedAt:1000,governedStartedAt:1000,governedAcquiredAt:1400,backendInvokedAt:1400,
      firstFrameAt:1700,endedAt:2000,sessionId:"ithaca",totalElapsedMs:1000,timeToFirstFrameMs:700,backendStartupMs:300,outcome:"success"});
    expect(record.backendRunId).toBe(record.turnId);
    expect(store.runRollup!(record.turnId)!.durationMs).toBe(200);
  }finally{clock.mockRestore();host.close();stream.close();db.close();}
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
  const authorization=testAuthorization("odysseus"),policy=createGovernancePolicyReader("/nonexistent-odysseus-fixture").load();
  const backend=makeFakeBackend({id:"pi",async startTurn(){entered=true;now=1600;throw Error("Backend startup failed");}});
  const observation: import("@schlessera/brain-ui-sdk/protocol").BudgetObservation = {scope:"turn",costUsd:200,blockUsd:200,warnUsd:100,tokens:null,blockTokens:512000000,unknownRuns:0,warning:true,blocked:true};
  const host=new WsHost({registry:createStaticBackendRegistry([backend],"pi"),catalog:createSessionCatalog(()=>db),activity:{store,stream},
    ...(mode === "budget refusal" ? {budgets:{...createTurnBudgets(db,{resolve:()=>null}),begin(){now=1500;throw new BudgetExceeded(observation,"admission");}}} : {}),
    governedTurns:{async begin(){now=1400;if(mode === "governed refusal")throw Error("Governed admission refused");if(mode === "revoked")authorization.valid=false;
      return {sandbox:{profile:"strict",noteFacts:{}},policy,async end(){return null;}};},refresh(){},async close(){},facts(){return {policyProfile:"strict",policy};}} as unknown as import("../src/brain/governed-turn.js").GovernedTurns});
  try{
    await runSession(host,{authorization,text:"Plan Ithaca",attachments:[]});
    const record=store.lifecycles()[0]!;
    expect(record.backendRunId).toBeNull();expect(record.firstFrameAt).toBeNull();expect(store.snapshotRun(record.turnId)).toBeNull();
    expect(record.totalElapsedMs).toBe(mode === "backend failure" ? 600 : mode === "budget refusal" ? 500 : 400);
    expect(record.outcome).toBe(mode === "revoked" ? "cancelled" : mode === "budget refusal" ? "denied" : "error");
    expect(entered).toBe(mode === "backend failure");
  }finally{clock.mockRestore();host.close();stream.close();db.close();}
});
