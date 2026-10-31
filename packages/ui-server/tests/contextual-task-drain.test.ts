
import { expect, spyOn, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client";
import { openSqliteWriter } from "../src/db/write-worker";
import { createSessionCatalog } from "../src/ws/session-catalog";
import { createOffloopActivityStore } from "../src/activity/store-writes";
import { createStaticBackendRegistry } from "../src/agent/backend";
import { WsHost } from "../src/ws/host";
import { createWsHandlers } from "../src/ws/connection";
import type { WSContext } from "../src/ws/clients";
import { makeFakeBackend } from "./helpers/fake-backend";
import { fakeLiveProvider, SILENCE } from "./helpers/live-conversation";
import { testPrincipal } from "./helpers/principal";
import * as controls from "./helpers/dialogue-test-writes";

async function until(check:()=>boolean) {
  const deadline=Date.now()+2000;
  while(!check()){if(Date.now()>deadline)throw Error("Contextual storage fixture did not reach checkpoint");await Bun.sleep(1);}
}
const checkpoint=()=>new Promise<void>(resolve=>setImmediate(resolve));

test("a real contextual task persistence failure drains its owner without waiting for an unrelated held native write",async()=>{
  const root=mkdtempSync(join(tmpdir(),"odysseus-contextual-drain-")),db=createUiDb(join(root,"ui.db")),writer=openSqliteWriter(db);
  const catalog=createSessionCatalog(()=>db,undefined,undefined,{writer,store:createOffloopActivityStore(db,writer),pricing:{resolve:()=>null}});
  const control=writer.channel(controls,{}),gate=new Int32Array(new SharedArrayBuffer(8));
  const live=fakeLiveProvider({contextualTasks:"supported"});
  let finish!:()=>void,started=false;
  const backend=makeFakeBackend({id:"fake",startTurn:async req=>{
    started=true;req.bridge.emit({type:"session_info",sessionId:"voyage",isNew:true});
    await new Promise<void>(resolve=>{finish=resolve;});
    req.bridge.emit({type:"result",sessionId:"voyage",outcome:"success",durationMs:1,numTurns:1,isError:false});
  }});
  const host=new WsHost({registry:createStaticBackendRegistry([backend],"fake"),catalog,conversationProvider:live.provider});
  const frames:any[]=[],ws={send:(data:string)=>frames.push(JSON.parse(data))} as WSContext;
  const handlers=createWsHandlers(host,testPrincipal());
  const send=(frame:object)=>handlers.onMessage({data:JSON.stringify(frame)} as MessageEvent,ws);
  let held:Promise<unknown>|undefined,armed=false;
  const descriptor=Object.getOwnPropertyDescriptor(Worker.prototype,"postMessage")!,native=Worker.prototype.postMessage;
  const observe=spyOn(Worker.prototype,"postMessage").mockImplementation(function(this:Worker,...args:[message:unknown,options?:StructuredSerializeOptions|Transferable[]]){
    const message=args[0] as {kind?:string;name?:string;args?:unknown[]};
    const result=Reflect.apply(native,this,args);
    const receipt=message.args?.[1] as {state?:string}|undefined;
    if(!armed&&message.kind==="call"&&message.name==="conversationTask"&&receipt?.state==="completed"){
      armed=true;
      // The genuine failed INSERT is first in FIFO. This hold and unrelated
      // append are posted before its failure acknowledgement reaches the host.
      held=control.call("holdUntilReleased",gate);
      host.dialogue.voice("pylos",{kind:"voice",conversationId:"pylos",epoch:1,providerId:"fake-live",event:{kind:"unassigned_input_fragment",sequence:0,text:"The unrelated sail observation.",timing:{kind:"unavailable"}}},()=>{});
    }
    return result;
  });
  try{
    await handlers.onOpen(undefined as never,ws);
    send({type:"client_hello",protocolRev:5,capabilities:{sessionDialogue:true}});
    send({type:"conversation_start",requestId:"contextual-start",contextualTasks:true,disclosed:host.conversations!.profile(true)});
    await until(()=>frames.some(f=>f.type==="conversation_opened"));
    const first=frames.find(f=>f.type==="conversation_opened"),session=live.sessions[0]!;
    send({type:"conversation_audio",conversationId:first.conversationId,epoch:first.epoch,utteranceId:"mast",sequence:0,rate:16000,pcm:SILENCE});
    await until(()=>session.audio.length===1);
    session.emit({kind:"unassigned_input_fragment",sequence:0,text:"Find the Ithaca note.",sessionInterval:{startMs:0,endMs:20}});
    session.emit({kind:"work_requested",handle:"mast-task"});
    await until(()=>started);await host.historySettled();
    await host.dialogue.open({conversationId:"pylos",principalId:testPrincipal().id,epoch:1,providerId:"fake-live"});
    await control.call("refuseCompletedTask");
    finish();
    await until(()=>frames.some(f=>f.code==="DIALOGUE_STORAGE"));
    await checkpoint();
    expect(armed).toBe(true);expect(Atomics.load(gate,1)).toBe(1);
    expect(db.query("SELECT COUNT(*) AS n FROM dialogue_records WHERE owner_id='pylos'").get()).toEqual({n:0});
    expect(frames.some(f=>f.type==="conversation_closed"&&f.conversationId===first.conversationId),"CONTEXTUAL_TASK_FAILURE_DRAIN_IGNORES_HELD_OTHER_OWNER").toBe(true);
    expect(db.query("SELECT json_extract(receipt,'$.state') AS state FROM conversation_tasks").get(),"ACTUAL_FAILED_COMPLETION_DID_NOT_PERSIST").toEqual({state:"running"});
    expect(live.sessions).toHaveLength(1);
  }finally{
    finish?.();Atomics.store(gate,0,1);Atomics.notify(gate,0);await held;
    observe.mockRestore();Object.defineProperty(Worker.prototype,"postMessage",descriptor);
    await Promise.allSettled([...host.turnTasks]);await host.dialogue.settled();
    await host.close().catch(()=>{});await control.close();await writer.close();db.close();rmSync(root,{recursive:true,force:true});
  }
});
