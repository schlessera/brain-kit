
import { expect, test } from "bun:test";
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
import { createGeminiConversationProvider } from "../src/voice/gemini-conversation";
import { createGptLiveConversationProvider } from "../src/voice/gpt-live-conversation";
import { StorageSettlementIndeterminate } from "../src/db/settlement";
import { makeFakeBackend } from "./helpers/fake-backend";
import { testPrincipal } from "./helpers/principal";
import { storageDeadlineClock } from "./helpers/storage-deadline-clock";
import * as controls from "./helpers/dialogue-test-writes";

async function until(check: () => boolean) {
  const limit = Date.now() + 2000;
  while (!check()) { if (Date.now() > limit) throw Error("Native deadline checkpoint unavailable"); await Bun.sleep(1); }
}
const checkpoint = () => new Promise<void>(resolve => setImmediate(resolve));

for (const engine of ["gemini", "gpt"] as const) test(`${engine}: held native write ends only the failed epoch within budget without releasing ownership`, async () => {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "WebSocket")!;
  const Native = WebSocket as unknown as new (url: string, options?: Bun.WebSocketOptions) => WebSocket;
  const sockets: Bun.ServerWebSocket<undefined>[] = [], outbound: any[][] = [];
  const server = Bun.serve<undefined>({hostname:"127.0.0.1",port:0,
    fetch(req,s) {if(s.upgrade(req))return;return new Response(null,{status:400});},
    websocket:{open(ws){sockets.push(ws);outbound.push([]);},message(ws,raw){
      const m=JSON.parse(String(raw));outbound[sockets.indexOf(ws)]!.push(m);
      if(m.setup)ws.send(JSON.stringify({setupComplete:{}}));
      if(m.type==="session.start")ws.send(JSON.stringify({type:"session.started",event_id:"s",session:{id:"ithaca-live",model:"gpt-live-1",store:false,delegation:{type:"client"}}}));
      if(m.type==="session.close")ws.send(JSON.stringify({type:"session.closed",reason:"close_requested"}));
    }}});
  Object.defineProperty(globalThis,"WebSocket",{configurable:true,value:class extends Native{static OPEN=1;constructor(_:string,options?:Bun.WebSocketOptions){super(`ws://127.0.0.1:${server.port}`,options);}}});
  const root=mkdtempSync(join(tmpdir(),"odysseus-drain-deadline-")),db=createUiDb(join(root,"ui.db")),writer=openSqliteWriter(db);
  const channel=writer.channel(controls,{});
  const catalog=createSessionCatalog(()=>db,undefined,undefined,{writer,store:createOffloopActivityStore(db,writer),pricing:{resolve:()=>null}});
  const backend=makeFakeBackend({id:"fake"});
  const provider=engine==="gemini"?createGeminiConversationProvider("keyless-odyssey-placeholder"):createGptLiveConversationProvider("keyless-odyssey-placeholder");
  const host=new WsHost({registry:createStaticBackendRegistry([backend],"fake"),catalog,conversationProvider:provider});
  const frames:any[]=[],ws={send:(data:string)=>frames.push(JSON.parse(data))} as WSContext;
  const handlers=createWsHandlers(host,testPrincipal());
  const send=(frame:object)=>handlers.onMessage({data:JSON.stringify(frame)} as MessageEvent,ws);
  const control=new Int32Array(new SharedArrayBuffer(8));
  let hold:Promise<unknown>|undefined,clock:ReturnType<typeof storageDeadlineClock>|undefined;
  try{
    await handlers.onOpen(undefined as never,ws);
    send({type:"client_hello",protocolRev:5,capabilities:{sessionDialogue:true}});
    send({type:"conversation_start",requestId:"ithaca-start",contextualTasks:true,disclosed:host.conversations!.profile(true)});
    await until(()=>frames.some(f=>f.type==="conversation_opened"));
    const first=frames.find(f=>f.type==="conversation_opened");
    hold=channel.call("holdUntilReleased",control);
    await until(()=>Atomics.load(control,1)===1);
    clock=storageDeadlineClock();
    // Actual adapter events and host consumption, paced by observed queue pressure.
    const remote=sockets[0]!;
    for(let i=0;i<257;i++){
      const frame=engine==="gemini"?{serverContent:{inputTranscription:{text:`mast ${i}`}}}:{type:"session.input_transcript.delta",event_id:`mast-${i}`,delta:`mast ${i}`,start_ms:0,end_ms:20};
      remote.send(JSON.stringify(frame));
      await checkpoint();
    }
    await until(()=>frames.some(f=>f.code==="DIALOGUE_PENDING_PRESSURE"));
    const before=frames.filter(f=>f.type==="conversation_event"&&f.event.kind==="unassigned_input_fragment").length;
    expect(before).toBe(0);
    expect(frames.filter(f=>f.type==="conversation_closed")).toHaveLength(0);
    let historyError:unknown,closeError:unknown;
    const history=host.historySettled().catch(e=>{historyError=e;});
    clock.expire();
    await checkpoint();
    expect(frames.some(f=>f.type==="conversation_closed"&&f.epoch===first.epoch),"BOUNDED_FAILED_EPOCH_TERMINAL_WITH_HELD_NATIVE_WRITE").toBe(true);
    expect(frames.find(f=>f.type==="conversation_closed"&&f.epoch===first.epoch).message,"INDETERMINATE_EPOCH_IS_TERMINAL").toContain("could not be confirmed");
    await history;expect(historyError).toBeInstanceOf(StorageSettlementIndeterminate);
    expect(db.query("SELECT COUNT(*) AS n FROM dialogue_records").get()).toEqual({n:0});
    expect((host.dialogue as any).pending.size,"TIMED_OUT_NATIVE_WRITES_REMAIN_OWNED").toBeGreaterThan(0);
    expect([...(host.dialogue as any).queues.values()].reduce((n:number,q:{count:number})=>n+q.count,0)).toBe(256);
    const terminal=frames.length;
    // Replacement waits behind the genuine close transition, then refuses promptly.
    send({type:"conversation_start",requestId:"ithaca-replacement",conversationId:first.conversationId,contextualTasks:true,disclosed:host.conversations!.profile(true)});
    await checkpoint();clock.expire();await checkpoint();
    await until(()=>frames.some(f=>f.type==="conversation_closed"&&f.epoch===2));
    expect(sockets).toHaveLength(1);
    const closing=host.close().catch(e=>{closeError=e;});
    clock.expire();await closing;
    expect(closeError,"HOST_CLOSE_REPORTS_OWNED_INDETERMINATE_STORAGE").toBeInstanceOf(StorageSettlementIndeterminate);
    host.clients.closeFor(testPrincipal().id,1008,"Principal revoked during native drain");
    const observed=frames.slice(terminal).filter(f=>f.type==="conversation_event"||f.type==="dialogue_history");
    Atomics.store(control,0,1);Atomics.notify(control,0);await hold;await host.dialogue.settled();await catalog.settled!();
    expect(db.query("SELECT COUNT(*) AS n FROM dialogue_records").get(),"LATE_NATIVE_WRITES_ACTUALLY_COMMIT").toEqual({n:256});
    expect(frames.slice(terminal).filter(f=>f.type==="conversation_event"||f.type==="dialogue_history"),"LATE_COMMITS_NEVER_PUBLISH_LIVE").toEqual(observed);
    const page=await catalog.dialogueRead!(testPrincipal().id,{ownerId:first.historyOwnerId});
    expect(page!.records).toHaveLength(200);expect(page!.coverage).toBe("partial");
    let refused:unknown;try{await catalog.dialogueRead!("other-principal",{ownerId:first.historyOwnerId});}catch(e){refused=e;}
    expect(refused).toBeInstanceOf(Error);
    let generationRefused:unknown;try{await catalog.dialogueRead!(testPrincipal().id,{ownerId:first.historyOwnerId,generation:page!.generation+1});}catch(e){generationRefused=e;}
    expect(generationRefused,"LATE_COMMIT_RETAINS_GENERATION_FENCE").toBeInstanceOf(Error);
    expect(outbound.flat().some(m=>m.toolResponse||m.type==="session.commentary.append"||m.type==="session.thinking.append"),"NO_EFFECT_REPLAY").toBe(false);
  }finally{
    Atomics.store(control,0,1);Atomics.notify(control,0);await hold;
    clock?.restore();await host.dialogue.settled();await host.close().catch(()=>{});
    await channel.close();await writer.close();db.close();server.stop(true);
    Object.defineProperty(globalThis,"WebSocket",descriptor);rmSync(root,{recursive:true,force:true});
  }
});
