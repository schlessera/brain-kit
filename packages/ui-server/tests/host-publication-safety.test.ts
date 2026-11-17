/** Actual authoritative-file effects after healthy backend admission. */
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyedLock, type BackendBridge } from "@schlessera/brain-ui-sdk/server";
import { createPermissionWiring } from "../../ui-backend-claude/src/permission-hooks";
import { createTurnContext } from "../../ui-backend-pi/src/turn-context";
import { createPermissionGate } from "../../ui-backend-pi/src/permission-gate";
import { createUiDb } from "../src/db/client";
import { createPrincipal } from "../src/db/principals";
import { openSqliteWriter } from "../src/db/write-worker";
import { createGovernanceWrites } from "../src/governance/event-writes";
import { createEffectiveSafety } from "../src/governance/effective-safety";
import { createSafetyCollector } from "../src/governance/safety-collector";
import { safetyCatalogCreated } from "../src/governance/safety-store";
import { occurrence } from "../src/governance/occurrence";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { createActivityStore } from "../src/activity/store";
import { createActivityStream } from "../src/activity/stream";
import { WsHost } from "../src/ws/host";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { makeFakeBackend } from "./helpers/fake-backend";
import { createBridgeContext } from "../src/ws/bridge-capabilities/context";
import { createPermissions } from "../src/ws/bridge-capabilities/permissions";
import { createApplication } from "../src/ws/bridge-capabilities/application";
import type { RunningTurn } from "../src/ws/turns";
import { makeBridge } from "../src/ws/bridge";
import { createPolicyProposals } from "../src/brain/policy-proposal";
import { handleToolApproval } from "../src/ws/handlers/tool-permission";
import * as heldWriter from "./fixtures/held-publication-writer";

async function fixture(backendId: "claude" | "pi" = "claude") {
  const root = mkdtempSync(join(tmpdir(), "odysseus-publication-safety-")), db = createUiDb(join(root, "ui.db"));
  const writer = openSqliteWriter(db), writes = createGovernanceWrites(db, writer), bindingId = crypto.randomUUID();
  const principal = createPrincipal(db, { authMethod: "password", label: "Odysseus", ttlSeconds: 3600 });
  await writes.safetyBegin({ turnId: "voyage", bindingId, sessionId: null, principalId: principal.id, backendId, at: 0 });
  db.query("INSERT INTO sessions(id,created_at,last_active_at,backend_id) VALUES('ithaca',0,0,?)").run(backendId);
  db.query("INSERT INTO chat_session_owners VALUES('ithaca',?,0)").run(principal.id);
  safetyCatalogCreated(db, "ithaca", principal.id, "voyage"); await writes.bind("voyage", "ithaca");
  const controller = new AbortController();
  const collector = createSafetyCollector(db, writes, { turnId: "voyage", bindingId, sessionId: () => "ithaca", backendId,
    signal: controller.signal, shellProxied: () => true, brainPath: root });
  await collector.ready(backendId, 1);
  const safety = createEffectiveSafety(db, { turnId: "voyage", sessionId: () => "ithaca", policyHash: null, writes,
    authority: () => ({ current: true, epoch: "0" }) });
  return { root, db, writer, writes, bindingId, principal, controller, collector, safety,
    async close() { await writer.close(); db.close(); rmSync(root, { recursive: true, force: true }); } };
}

for (const adverse of [false, true]) test(`extra: direct application final lock wait fences shared recorder loss (${adverse})`, async () => {
  const f=await fixture();
  const entered=Promise.withResolvers<void>(), release=Promise.withResolvers<void>();
  const backend=makeFakeBackend({id:"claude"});
  const store=createActivityStore(f.db);
  const host=new WsHost({brainPath:f.root,registry:createStaticBackendRegistry([backend],"claude"),catalog:createSessionCatalog(()=>f.db),
    isPrincipalAuthorized:id=>id===f.principal.id,
    applicationPlanner:{async planAdd(){throw new Error("not used");},async index(){}},
    activity:{store,stream:createActivityStream(store),governanceDb:f.db,governanceWrites:f.writes}});
  const authorization=host.coordinator.openAuthorization({principalId:f.principal.id,valid:true,expiresAt:Number.MAX_SAFE_INTEGER});
  const turn={turnId:"voyage",principalId:f.principal.id,authorization,startedAt:1,sessionId:"ithaca",abortController:f.controller,queue:[]} as unknown as RunningTurn;
  const ctx=createBridgeContext(host,turn,{promptText:"Return to Ithaca",backendId:"claude"});
  const bridge={emit(){},admissionSafety:f.safety} as unknown as BackendBridge;
  Object.assign(bridge,createPermissions(ctx,()=>bridge));
  const app=createApplication(ctx,()=>bridge,f.root,{available:["write"],autoAllowed:["write"],
    lock:{async withLock(_key:any,body:any){entered.resolve();await release.promise;return body();}} as never},{});
  Object.assign(bridge,app.slice);
  let work:Promise<any>|undefined;
  try {
    // The backend gate and collector have completed in the healthy state.
    await f.collector.begin("application-call","mcp__brain-ui__write_file",{path:"notes/raft.md"});
    expect(f.safety.read().recordingAvailable).toBe(true);
    work=bridge.applyBrain!({operation:"write",path:"notes/raft.md",content:"Odysseus returns to Ithaca.\n",expectedBaseHash:null});
    await entered.promise;
    if(adverse) await createGovernanceWrites(f.db,f.writer).safetyFail("another-turn");
    expect(f.safety.read().recordingAvailable).toBe(!adverse);
    release.resolve(); const result=await work;
    expect(existsSync(join(f.root,"notes/raft.md")),"DIRECT_APPLICATION_LAST_WAIT_MUST_FENCE_SHARED_RECORDER_LOSS").toBe(!adverse);
    expect(result.ok).toBe(!adverse);
  } finally {release.resolve();await work;authorization.release();host.close();await f.close();}
});


for(const backendId of ["claude","pi"] as const) for(const adverse of [false,true]) test(`extra composed ${backendId}: application post-gate lock health (${adverse})`,async()=>{
  const f=await fixture(backendId), entered=Promise.withResolvers<void>(), release=Promise.withResolvers<void>();
  const backend=makeFakeBackend({id:backendId}),store=createActivityStore(f.db);
  const host=new WsHost({brainPath:f.root,registry:createStaticBackendRegistry([backend],backendId),catalog:createSessionCatalog(()=>f.db),
    isPrincipalAuthorized:id=>id===f.principal.id,
    applicationPlanner:{async planAdd(){throw new Error("not used");},async index(){}},
    activity:{store,stream:createActivityStream(store),governanceDb:f.db,governanceWrites:f.writes}});
  const authorization=host.coordinator.openAuthorization({principalId:f.principal.id,valid:true,expiresAt:Number.MAX_SAFE_INTEGER});
  const turn={turnId:"voyage",principalId:f.principal.id,authorization,startedAt:1,sessionId:"ithaca",abortController:f.controller,queue:[]} as unknown as RunningTurn;
  const lock=host.workerLock;
  (host as any).workerLock=Object.assign(Object.create(lock),{withLock:async(key:any,body:any,options:any)=>lock.withLock(key,async()=>{entered.resolve();await release.promise;return body();},options)});
  const bridge=await makeBridge(host,turn,{promptText:"Return to Ithaca",backendId,applicationPolicy:{available:["write"],autoAllowed:["write"],lock}});
  bridge.inputSafety=f.collector;
  const input={operation:"write" as const,path:"notes/composed-raft.md",content:"Odysseus repairs the raft.\n",expectedBaseHash:null};
  const name=backendId==="claude"?"mcp__brain-ui__write_file":"write_file";
  let work:Promise<any>|undefined;
  try {
    if(backendId==="claude") {
      const wiring=createPermissionWiring({req:{prompt:"Return to Ithaca",bridge,signal:f.controller.signal,workerSandbox:{brain:f.root,profile:"governed"} as never},
        allowedTools:[name],confirmPatterns:[],brainPath:f.root,turnLock:{async acquireForTool(){return {ok:true};},releaseForTool(){}} as never,childEnv:{},log(){}});
      const outputs=await Promise.all(wiring.hooks!.PreToolUse!.filter(group=>!group.matcher||new RegExp(group.matcher).test(name)).flatMap(group=>group.hooks)
        .map(hook=>hook({hook_event_name:"PreToolUse",tool_name:name,tool_input:input,tool_use_id:"composed-application"} as never,"composed-application",{signal:f.controller.signal})));
      expect(outputs.filter(o=>"hookSpecificOutput" in o&&o.hookSpecificOutput&&"permissionDecision" in o.hookSpecificOutput&&o.hookSpecificOutput.permissionDecision==="deny")).toEqual([]);
    } else {
      let gate:any;const extension=createPermissionGate({turn:{...createTurnContext(),bridge,signal:f.controller.signal},allowedTools:new Set([name]),confirmPatterns:[]});
      const factory=typeof extension==="function"?extension:extension.factory;await factory({on(_event:any,fn:any){gate=fn;}} as never);
      expect(await gate({toolName:name,toolCallId:"composed-application",input})).toBeUndefined();
    }
    expect(bridge.admissionSafety!.read().recordingAvailable).toBe(true);
    const authorityEpoch = bridge.admissionSafety!.read().authorityEpoch;
    work=bridge.applyBrain!(input);await entered.promise;
    if(adverse)await createGovernanceWrites(f.db,f.writer).safetyFail("another-turn");
    expect(bridge.admissionSafety!.read().recordingAvailable).toBe(!adverse);
    expect(bridge.admissionSafety!.read().authorityEpoch, "RECORDING_HEALTH_DOES_NOT_ROTATE_PRINCIPAL_EPOCH").toBe(authorityEpoch);
    expect(f.controller.signal.aborted).toBe(false);
    release.resolve();const result=await work;
    expect(existsSync(join(f.root,input.path)),"COMPOSED_APPLICATION_POST_GATE_LOCK_MUST_FENCE_SHARED_HEALTH").toBe(!adverse);
    expect(result.ok).toBe(!adverse);
  }finally{release.resolve();await work;authorization.release();host.close();await f.close();}
});

for(const backendId of ["claude","pi"] as const) for(const adverse of [true]) test(`extra composed ${backendId}: application post-gate pending input (${adverse})`,async()=>{
  const f=await fixture(backendId), entered=Promise.withResolvers<void>(), release=Promise.withResolvers<void>();
  const backend=makeFakeBackend({id:backendId}),store=createActivityStore(f.db);
  const host=new WsHost({brainPath:f.root,registry:createStaticBackendRegistry([backend],backendId),catalog:createSessionCatalog(()=>f.db),
    isPrincipalAuthorized:id=>id===f.principal.id,
    applicationPlanner:{async planAdd(){throw new Error("not used");},async index(){}},
    activity:{store,stream:createActivityStream(store),governanceDb:f.db,governanceWrites:f.writes}});
  const authorization=host.coordinator.openAuthorization({principalId:f.principal.id,valid:true,expiresAt:Number.MAX_SAFE_INTEGER});
  const turn={turnId:"voyage",principalId:f.principal.id,authorization,startedAt:1,sessionId:"ithaca",abortController:f.controller,queue:[]} as unknown as RunningTurn;
  const lock=host.workerLock;
  (host as any).workerLock=Object.assign(Object.create(lock),{withLock:async(key:any,body:any,options:any)=>lock.withLock(key,async()=>{entered.resolve();await release.promise;return body();},options)});
  const bridge=await makeBridge(host,turn,{promptText:"Return to Ithaca",backendId,applicationPolicy:{available:["write"],autoAllowed:["write"],lock}});
  bridge.inputSafety=f.collector;
  const input={operation:"write" as const,path:"notes/composed-raft.md",content:"Odysseus repairs the raft.\n",expectedBaseHash:null};
  const name=backendId==="claude"?"mcp__brain-ui__write_file":"write_file";
  let work:Promise<any>|undefined, held:Promise<unknown>|undefined, pending:Promise<unknown>|undefined; const writerRelease=new Int32Array(new SharedArrayBuffer(4));
  try {
    if(backendId==="claude") {
      const wiring=createPermissionWiring({req:{prompt:"Return to Ithaca",bridge,signal:f.controller.signal,workerSandbox:{brain:f.root,profile:"governed"} as never},
        allowedTools:[name],confirmPatterns:[],brainPath:f.root,turnLock:{async acquireForTool(){return {ok:true};},releaseForTool(){}} as never,childEnv:{},log(){}});
      const outputs=await Promise.all(wiring.hooks!.PreToolUse!.filter(group=>!group.matcher||new RegExp(group.matcher).test(name)).flatMap(group=>group.hooks)
        .map(hook=>hook({hook_event_name:"PreToolUse",tool_name:name,tool_input:input,tool_use_id:"composed-application"} as never,"composed-application",{signal:f.controller.signal})));
      expect(outputs.filter(o=>"hookSpecificOutput" in o&&o.hookSpecificOutput&&"permissionDecision" in o.hookSpecificOutput&&o.hookSpecificOutput.permissionDecision==="deny")).toEqual([]);
    } else {
      let gate:any;const extension=createPermissionGate({turn:{...createTurnContext(),bridge,signal:f.controller.signal},allowedTools:new Set([name]),confirmPatterns:[]});
      const factory=typeof extension==="function"?extension:extension.factory;await factory({on(_event:any,fn:any){gate=fn;}} as never);
      expect(await gate({toolName:name,toolCallId:"composed-application",input})).toBeUndefined();
    }
    expect(bridge.admissionSafety!.read().recordingAvailable).toBe(true);
    const authorityEpoch = bridge.admissionSafety!.read().authorityEpoch;
    work=bridge.applyBrain!(input);await entered.promise;
    const channel=f.writer.channel(heldWriter,{});await channel.ready;
    expect(await channel.call<number>("level")).toBe(2);
    const writerEntered=new Int32Array(new SharedArrayBuffer(4));held=channel.call("hold",writerEntered,writerRelease);
    const waiting=Atomics.waitAsync(writerEntered,0,0,5000);if(waiting.async)await waiting.value;expect(Atomics.load(writerEntered,0)).toBe(1);
    pending=f.writes.firstTaint({kind:"taint",turnId:"voyage",sessionId:"ithaca",actor:"interactive",model:null,profile:null,
      payload:{source:"web_fetch",tool:"WebFetch",detail:null,occurrence:occurrence(f.bindingId,"tool_web_input","queued-input","finalized")}});
    expect(bridge.admissionSafety!.read().recordingAvailable).toBe(!adverse);
    expect(bridge.admissionSafety!.read().authorityEpoch, "RECORDING_HEALTH_DOES_NOT_ROTATE_PRINCIPAL_EPOCH").toBe(authorityEpoch);
    expect(f.controller.signal.aborted).toBe(false);
    release.resolve();const result=await work;
    expect(existsSync(join(f.root,input.path)),"COMPOSED_APPLICATION_POST_GATE_LOCK_MUST_FENCE_PENDING_INPUT").toBe(!adverse);
    expect(result.ok).toBe(!adverse);
  }finally{release.resolve();Atomics.store(writerRelease,0,1);Atomics.notify(writerRelease,0);await Promise.allSettled([held,pending]);await work;authorization.release();host.close();await f.close();}
});

for(const adverse of [false,true]) test(`extra composed policy: final publication lock health (${adverse})`,async()=>{
  const f=await fixture(),entered=Promise.withResolvers<void>(),release=Promise.withResolvers<void>(),raised=Promise.withResolvers<void>();
  const path=join(f.root,"context/policies/governance.md"),original="---\nschema_version: 1\nprofiles:\n  interactive: governed\n---\nOdysseus reviews the policy.\n",proposed=original.replace("interactive: governed","interactive: strict");
  mkdirSync(join(f.root,"context/policies"),{recursive:true});writeFileSync(path,original);
  const keyLock=createKeyedLock();
  const service=createPolicyProposals({root:f.root,db:f.db,writer:f.writer,
    lock:{withLock:(key,body,options)=>keyLock.withLock(key,async()=>{entered.resolve();await release.promise;return body();},options)},
    observeUserPolicy:(_id,write)=>write(),recordEvent:(review,turn)=>f.writes.record({kind:"policy_change",turnId:turn.turnId,sessionId:turn.sessionId(),actor:"user",model:null,profile:null,
      payload:{requestId:review.requestId,baseHash:review.baseHash,proposedHash:review.proposedHash,sections:review.sections,outcome:"updated"}})});
  const backend=makeFakeBackend({id:"claude"}),store=createActivityStore(f.db);
  const host=new WsHost({brainPath:f.root,registry:createStaticBackendRegistry([backend],"claude"),catalog:createSessionCatalog(()=>f.db),isPrincipalAuthorized:id=>id===f.principal.id,
    policyProposals:service,activity:{store,stream:createActivityStream(store),governanceDb:f.db,governanceWrites:f.writes}});
  const authorization=host.coordinator.openAuthorization({principalId:f.principal.id,valid:true,expiresAt:Number.MAX_SAFE_INTEGER});
  const turn={turnId:"voyage",principalId:f.principal.id,authorization,startedAt:1,sessionId:"ithaca",abortController:f.controller,queue:[]} as unknown as RunningTurn;
  const ws={send(text:string){if(JSON.parse(text).type==="tool_approval_request")raised.resolve();}};host.clients.add(ws,f.principal.id);
  const bridge=await makeBridge(host,turn,{promptText:"Return to Ithaca",backendId:"claude"});bridge.inputSafety=f.collector;
  let work:Promise<any>|undefined;
  try{
    await f.collector.begin("policy-health","mcp__brain-ui__propose_policy_change",{content:proposed,rationale:"Use strict from the next turn."});
    expect(bridge.admissionSafety!.read().recordingAvailable).toBe(true);
    const authorityEpoch = bridge.admissionSafety!.read().authorityEpoch;
    work=bridge.proposePolicyChange!("policy-health",{content:proposed,rationale:"Use strict from the next turn."});
    await Promise.race([raised.promise,work.then(result=>{throw new Error(`Policy completed without a card: ${JSON.stringify(result)}`);})]);
    await handleToolApproval({host,ws,requireEcho:true,connection:{principal:f.principal,authorization}} as never,{type:"tool_approval",toolUseId:"policy-health",turnId:"voyage",channel:"card"});
    await Promise.race([entered.promise,work.then(result=>{throw new Error(`Policy completed before lock: ${JSON.stringify(result)}`);})]);
    if(adverse)await f.writes.safetyFail("another-turn");
    expect(bridge.admissionSafety!.read().recordingAvailable).toBe(!adverse);
    expect(bridge.admissionSafety!.read().authorityEpoch, "RECORDING_HEALTH_DOES_NOT_ROTATE_PRINCIPAL_EPOCH").toBe(authorityEpoch);
    release.resolve();const result=await work;
    expect(readFileSync(path,"utf8"),"POLICY_FINAL_LOCK_MUST_FENCE_SHARED_RECORDER_LOSS").toBe(adverse ? original : proposed);
    expect(result.state).toBe(adverse ? "refused" : "updated");
  }finally{release.resolve();host.close();await work;authorization.release();await f.close();}
});
