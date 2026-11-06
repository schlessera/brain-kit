/** Ordinary pool refusal must not become an application-wide recorder outage. */
import {expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {BackendBusyError,BackendRequestError,type ServerMessage} from "@schlessera/brain-ui-sdk/server";
import {FIRST_PARTY_FAILURE_CLASSES} from "@schlessera/brain-ui-sdk/protocol";
import type {PiSessionLike} from "../../ui-backend-pi/src/backend-options";
import {createSessionPool} from "../../ui-backend-pi/src/session-pool";
import {createPiTurnRunner} from "../../ui-backend-pi/src/turn-runner";
import {createTurnContext} from "../../ui-backend-pi/src/turn-context";
import {createUiDb} from "../src/db/client";
import {openSqliteWriter} from "../src/db/write-worker";
import {createGovernanceWrites} from "../src/governance/event-writes";
import {createSafetyCollector} from "../src/governance/safety-collector";

for(const refusal of ["aborted","busy","caller","budget"] as const)test(`Pi ${refusal} acquisition preserves refusal and recorder health`,async()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-pi-acquisition-")),db=createUiDb(join(root,"ui.db")),writer=openSqliteWriter(db),writes=createGovernanceWrites(db,writer);
 const controller=new AbortController(),frames:ServerMessage[]=[];let opens=0,notices=0;
 try{
 const bindingId=crypto.randomUUID();await writes.safetyBegin({turnId:"voyage",bindingId,sessionId:null,principalId:"odysseus",backendId:"pi",at:0});
 const collector=createSafetyCollector(db,writes,{turnId:"voyage",bindingId,sessionId:()=>null,backendId:"pi",signal:controller.signal,shellProxied:()=>false});
 const original=refusal==="budget"?Object.assign(new Error("Voyage worker state budget is busy"),{errorClass:FIRST_PARTY_FAILURE_CLASSES.worker_state_busy}):new BackendRequestError("Unknown voyage profile");
 const runtime={async newSession(){opens++;throw original;},async openSession(){opens++;throw original;}};
 const pool=createSessionPool(runtime,false),id="22222222-2222-4222-8222-222222222222";
 if(refusal==="busy")pool.sessions.set(id,{session:{sessionId:id} as PiSessionLike,turnContext:createTurnContext(),running:true});
 if(refusal==="aborted")controller.abort();
 const runner=createPiTurnRunner(pool,{brainPath:root});
 const result=await runner({prompt:"Continue to Ithaca.",...(refusal==="busy"?{sessionId:id}:{}),signal:controller.signal,bridge:{emit:frame=>frames.push(frame),requestPermission:async()=>({behavior:"allow"}),inputSafety:{...collector,async unavailable(){notices++;await collector.unavailable!();}}}}).then(()=>undefined,error=>error);
 expect(db.query("SELECT failed,reason FROM safety_meta").get(),"SAFETY_PI_ORDINARY_REFUSAL_NEVER_FAILS_RECORDER").toEqual({failed:0,reason:null});
 expect(notices).toBe(0);expect(opens).toBe(refusal==="caller"||refusal==="budget"?1:0);
 if(refusal==="busy")expect(result,"SAFETY_PI_BUSY_ERROR_PRESERVED").toBeInstanceOf(BackendBusyError);
 else if(refusal==="caller")expect(result,"SAFETY_PI_CALLER_ERROR_PRESERVED").toBe(original);
 else if(refusal==="budget"){expect(result).toBeUndefined();expect(frames.at(-1)).toMatchObject({type:"error",code:"agent_error",failure:{errorClass:FIRST_PARTY_FAILURE_CLASSES.worker_state_busy}});}
 else{expect(result).toBeUndefined();expect(frames.at(-1)).toMatchObject({type:"error",code:"agent_error",message:"The turn was cancelled before a session was acquired."});}
 await writes.safetyBegin({turnId:"unrelated",bindingId:crypto.randomUUID(),sessionId:null,principalId:"odysseus",backendId:"pi",at:1});
 expect(writes.recordingAvailable("unrelated",null),"SAFETY_PI_ORDINARY_REFUSAL_LEAVES_OTHER_CHATS_AVAILABLE").toBe(true);
 }finally{await writer.close();db.close();rmSync(root,{recursive:true,force:true});}
});
