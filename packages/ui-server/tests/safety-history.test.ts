import { recordGovernanceEvent } from "../src/governance/events";
import { occurrence } from "../src/governance/occurrence";
import { expect,test } from "bun:test";
import { createPrincipal,revokePrincipal } from "../src/db/principals";
import { SafetyHistory } from "../src/governance/safety-history";
import { pruneSafetyDetail,recoverSafetyCollections } from "../src/governance/safety-store";
import { retireChat } from "../src/ws/chat-lifecycle";
import { cleanChatStore } from "../src/ws/chat-store-cleanup";
import { safetyPageSchema,parseServerMessage } from "@schlessera/brain-ui-sdk/schemas";
import { createSafetyStore } from "../../ui-react/src/stores/safety-state";
import { safetyHistoryFixture } from "./helpers/safety-history-fixture";
import type { SafetyPage } from "@schlessera/brain-ui-sdk/protocol";

async function page(response:Response):Promise<SafetyPage>{expect(response.status).toBe(200);return safetyPageSchema.parse(await response.json());}

test("authenticated HTTP snapshot pins aggregate/highwater while independent A/B/C verdicts append",async()=>{
  const f=await safetyHistoryFixture();try{
    const [a,b,c]=[await f.add("A"),await f.add("B"),await f.add("C")];
    const first=await page(await f.get("?limit=1"));expect(first.projection.unresolvedCount,"PAGE_AGGREGATE_INDEPENDENT").toBe(3);expect(first.snapshotComplete).toBe(false);
    const value={version:1 as const,session:first.projection.session!,occurrenceId:a.id,expectedEvidenceRevision:first.highWater,verdict:"safe" as const},actor={principalId:f.principal.id,channel:"owner_history" as const};
    const prepared=await f.writes.safetyPrepareReview(value,actor);expect((await f.writes.safetyCommitReview(prepared.requestId!,value,actor)).stage).toBe("verdict_committed");
    const d=await f.add("D");
    const second=await page(await f.get(`?limit=1&cursor=${first.nextCursor}`));expect(second.projection).toEqual(first.projection);expect(second.highWater).toBe(first.highWater);
    const third=await page(await f.get(`?limit=1&cursor=${second.nextCursor}`));expect(third.snapshotComplete).toBe(true);
    expect([first,second,third].flatMap(p=>p.records.map(r=>r.id))).toEqual([a.id,b.id,c.id]);
    expect(await page(await f.get(`?limit=1&cursor=${first.nextCursor}`))).toEqual(second);
    const current=await page(await f.get());expect(current.projection.unresolvedCount).toBe(3);expect(current.records.map(r=>r.id)).toContain(d.id);
    const decisions=current.records.filter(r=>r.kind==="safe_decision");expect(decisions).toHaveLength(1);expect(decisions[0]?.occurrenceId).toBe(a.id);
    expect(f.starts(),"READ_NEVER_STARTS_WORK").toBe(0);
  }finally{await f.close();}
});

test("real WS replay and contiguous updates survive duplicate/reordered delivery without count reduction",async()=>{
  const f=await safetyHistoryFixture();try{
    await f.add("A");const initial=await page(await f.get());const client=await f.connect();
    client.send({type:"safety_read",version:1,requestId:"replay",target:{sessionId:"ithaca"}});
    const frame=await client.until(m=>m.type==="safety_history");if(frame.type!=="safety_history")throw new Error("Missing page");expect(frame.page.records).toEqual(initial.records);
    expect(parseServerMessage(JSON.stringify(frame)).ok).toBe(true);
    client.send({type:"safety_subscribe",version:1,requestId:"subscription",identity:frame.page.identity,afterRevision:frame.page.highWater,snapshotId:frame.page.snapshotId});
    const updates:import("@schlessera/brain-ui-sdk/protocol").SafetyUpdate[]=[];
    const through=async(count:number)=>{for(;;){const frame=await client.until(m=>m.type==="safety_update");if(frame.type!=="safety_update")throw new Error("Missing update");updates.push(frame.update);if(frame.update.projection.unresolvedCount===count&&frame.update.projection.pendingCount===0)return frame.update;}};
    // A poll that reads a new row before its write's local pending latch clears
    // reports pendingCount 1; the next poll at the same revision reports 0, and
    // that changed projection closes the subscription with gap (#3723). Every
    // read, the subscription's own and the sweep's included, waits behind the
    // hold until the write and its latch have settled.
    const settledAdd=async(name:string)=>{const quiet=f.hold();try{await f.add(name);}finally{quiet.release();}};
    await settledAdd("B");f.history.poll();const one=await through(2);
    await settledAdd("C");f.history.poll();const two=await through(3);
    const store=createSafetyStore();store.getState().reset(true);store.getState().begin("replay");expect(store.getState().page("replay",frame.page)).toBe(true);
    for(const update of updates)expect(store.getState().update(update)).toBe(true);
    expect(store.getState().update(one)).toBe(true);
    expect(store.getState().projection?.unresolvedCount,"REORDER_CANNOT_REDUCE_AGGREGATE").toBe(3);
    expect(store.getState().update(two)).toBe(true);
    expect(store.getState().projection?.unresolvedCount,"REORDER_CANNOT_REDUCE_AGGREGATE").toBe(3);expect(Object.keys(store.getState().records)).toHaveLength(3);
    const reconnect=await f.connect();reconnect.send({type:"safety_read",version:1,requestId:"restart",target:{sessionId:"ithaca"}});
    const recovered=await reconnect.until(m=>m.type==="safety_history");expect(recovered.type==="safety_history"&&recovered.page.projection.unresolvedCount).toBe(3);
  }finally{await f.close();}
});

test("first-turn provisional binding retains exact occurrence identity without duplicate markers",async()=>{
  const f=await safetyHistoryFixture(false);try{
    const a=await f.add("A"),target={turnId:"voyage",bindingId:f.bindingId};const early=await f.history.read(f.principal,target);
    expect(early.identity).toEqual(target);expect(early.records[0]?.id).toBe(a.id);
    await f.bind();const adopted=await f.history.read(f.principal,target);expect(adopted.identity).toHaveProperty("sessionId","ithaca");expect(adopted.records).toEqual(early.records);
    const state=createSafetyStore();state.getState().reset(true);state.getState().begin("early");state.getState().page("early",early);state.getState().begin("bound");state.getState().page("bound",adopted);
    expect(Object.keys(state.getState().records)).toEqual([a.id]);
  }finally{await f.close();}
});

test("cursor scope, expiry after wait, principal revocation and retirement fence late authenticated reads",async()=>{
  const f=await safetyHistoryFixture();try{
    await f.add("A");await f.add("B");const first=await page(await f.get("?limit=1"));
    // Another owner login reads the chat (#3952), but a cursor stays its own login's.
    const otherLogin=createPrincipal(f.db,{authMethod:"password",label:"Odysseus at Ithaca",ttlSeconds:3600});
    expect((await f.get(`?cursor=${first.nextCursor}`,await f.cookieFor(otherLogin))).status,"CURSOR_SCOPE_IS_ONE_LOGIN").toBe(409);
    // Another account's principal sees nothing of the chat.
    const agent=createPrincipal(f.db,{authMethod:"delegated",createdBy:f.principal.id,label:"Mentor",ttlSeconds:3600});
    expect((await f.get(`?cursor=${first.nextCursor}`,await f.cookieFor(agent))).status,"CURSOR_SCOPE_FOREIGN_ACCOUNT").toBe(404);
    const held=f.hold(),pending=f.get(`?cursor=${first.nextCursor}`);await held.arrived;f.advance(300001);held.release();
    expect((await pending).status,"CURSOR_DELIVERY_CLOCK").toBe(409);
    const revoked=f.hold(),late=f.get();await revoked.arrived;revokePrincipal(f.db,f.principal.id,Date.now());revoked.release();
    const response=await late;expect(response.status,"READ_DELIVERY_RECHECKS_AUTH").toBe(401);expect(JSON.stringify(await response.json())).not.toContain("occurrence");
  }finally{await f.close();}
  const g=await safetyHistoryFixture();try{
    await g.add("A");const held=g.hold(),late=g.get();await held.arrived;
    const result=retireChat(g.db,{operationId:"retire",principalId:g.principal.id,target:{sessionId:"ithaca"},expected:{backendId:"claude",generation:1},removableBackends:["claude"],at:Date.now()});expect(result.status).toBe("retired");held.release();
    expect((await late).status,"READ_RETIREMENT_FENCE").toBe(404);
    if(result.status==="retired")cleanChatStore(g.db,result.lifecycleId,"projections",Date.now());
    await expect(g.add("late")).rejects.toThrow();expect((await g.get()).status).toBe(404);
  }finally{await g.close();}
});

test("unknown proxy operation, bounded redaction, detail pruning, legacy gaps and reader restart remain honest",async()=>{
  const f=await safetyHistoryFixture();try{
    const a=await f.add("A",true),b=await f.add("B",true);const first=await page(await f.get("?limit=1"));
    expect(first.records[0]).toMatchObject({id:a.id,kind:"occurrence",operationId:null,provenance:null});
    expect(JSON.stringify(first)).not.toMatch(/credential|private\?|secret|Git/);expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(262144);
    pruneSafetyDetail(f.db,Number.MAX_SAFE_INTEGER);expect((await f.get(`?cursor=${first.nextCursor}`)).status).toBe(409);
    const pruned=await page(await f.get());expect(pruned.detailPruned).toBe(true);expect(pruned.records.map(r=>r.id)).toEqual([a.id,b.id]);expect(pruned.projection.unresolvedCount).toBe(2);
    recoverSafetyCollections(f.db);const restarted=new SafetyHistory(f.db,()=>true,()=>f.writer.idle());
    await expect(restarted.read(f.principal,{sessionId:"ithaca"},first.nextCursor)).rejects.toThrow("expired");
    const after=await restarted.read(f.principal,{sessionId:"ithaca"});expect(after.projection.coverage.state).toBe("incomplete");expect(after.projection.restriction).toBe("restricted");
    restarted.close();expect(f.db.query("SELECT COUNT(*) n FROM safety_decisions").get()).toEqual({n:0});expect(f.starts()).toBe(0);
  }finally{await f.close();}
});

test("partial and out-of-order pages cannot claim normal; gaps require resync and old clients have no read capability",async()=>{
  const f=await safetyHistoryFixture();try{
    await f.add("A");await f.add("B");const first=await page(await f.get("?limit=1")),last=await page(await f.get(`?cursor=${first.nextCursor}`));
    const store=createSafetyStore();expect(store.getState().status).toBe("unavailable");expect(store.getState().normal).toBe(false);
    store.getState().reset(true);store.getState().begin("snapshot");expect(store.getState().page("snapshot",last),"OUT_OF_ORDER_FINAL_PAGE_REFUSED").toBe(false);
    expect(store.getState().page("snapshot",first)).toBe(true);expect(store.getState().normal,"PARTIAL_NEVER_NORMAL").toBe(false);
    expect(store.getState().page("snapshot",last)).toBe(true);
    const gap={version:1 as const,identity:last.identity,fromRevision:String(BigInt(last.highWater)+1n),toRevision:String(BigInt(last.highWater)+2n),projection:{...last.projection,evidenceRevision:String(BigInt(last.highWater)+2n)},records:[]};
    expect(store.getState().update(gap),"UPDATE_GAP_NEEDS_SNAPSHOT").toBe(false);expect(store.getState().normal).toBe(false);
    store.getState().reset();expect(store.getState().page("snapshot",last)).toBe(false);
    const ws=await f.connect();ws.send({type:"client_hello",protocolRev:2});ws.send({type:"safety_read",version:1,requestId:"old",target:{sessionId:"ithaca"}});
    ws.send({type:"ping",probeId:"barrier"});await ws.until(m=>m.type==="pong");expect(ws.frames.some(m=>m.type==="safety_history")).toBe(false);
  }finally{await f.close();}
});

test("revision and frame bounds force resync; changed generations cannot reuse snapshots",async()=>{
  const f=await safetyHistoryFixture();try{
    const before=await page(await f.get());
    // Seed the immutable reader bound in one transaction; other cases run
    // the production off-loop writer for recording/verdict durability.
    f.db.transaction(()=>{for(let i=0;i<101;i++)recordGovernanceEvent(f.db,{kind:"taint",turnId:"voyage",sessionId:"ithaca",at:0,actor:"interactive",model:null,profile:"governed",payload:{source:"web_fetch",tool:"WebFetch",detail:"Bounded fixture",occurrence:occurrence(f.bindingId,"tool_web_input",`signal_${i}`,"finalized")}});}).immediate();
    await expect(f.history.delta(f.principal,before.identity,before.highWater,before.snapshotId)).rejects.toThrow("capacity");
    const first=await page(await f.get("?limit=1"));
    f.db.query("INSERT INTO dialogue_owners(id,principal_id,session_id,generation,coverage,created_at) VALUES(?,?,?,2,'complete',0)").run((first.identity as {historyOwnerId:string}).historyOwnerId,f.principal.id,"ithaca");
    expect((await f.get(`?cursor=${first.nextCursor}`)).status).toBe(409);
  }finally{await f.close();}
});

test("final delivery rechecks retirement after the awaited snapshot has already completed",async()=>{
  const f=await safetyHistoryFixture();const original=f.history.read.bind(f.history);try{
    await f.add("A");
    f.history.read=async(...args)=>{
      const result=await original(...args);
      const retired=retireChat(f.db,{operationId:"delivery-retire",principalId:f.principal.id,target:{sessionId:"ithaca"},expected:{backendId:"claude",generation:1},removableBackends:["claude"],at:Date.now()});
      expect(retired.status).toBe("retired");return result;
    };
    const response=await f.get();expect(response.status,"FINAL_DELIVERY_REFUSES_RETIRED_SNAPSHOT").toBe(404);
    expect(JSON.stringify(await response.json())).not.toContain("projection");
  }finally{f.history.read=original;await f.close();}
});

test("real WS pending read and subscription publish no evidence after principal revocation",async()=>{
  const f=await safetyHistoryFixture();try{
    await f.add("A");const client=await f.connect(),held=f.hold();
    client.send({type:"safety_read",version:1,requestId:"held",target:{sessionId:"ithaca"}});await held.arrived;
    revokePrincipal(f.db,f.principal.id,Date.now());held.release();await f.writer.idle();
    // Observe actual socket closure after the same host revocation path used
    // by logout; queued reads must be unable to publish before or after it.
    const closed=new Promise<void>(resolve=>client.ws.addEventListener("close",()=>resolve(),{once:true}));
    await f.host.revokePrincipals([f.principal.id],1008,"Sessions invalidated");await closed;
    expect(client.frames.some(m=>m.type==="safety_history"||m.type==="safety_update"),"WS_REVOKED_READ_HAS_NO_EVIDENCE").toBe(false);
  }finally{await f.close();}
});

test("zero unresolved aggregate still cannot claim normal from a partial page; reads reject forged mutations",async()=>{
  const f=await safetyHistoryFixture();try{
    const a=await f.add("A"),b=await f.add("B"),actor={principalId:f.principal.id,channel:"owner_history" as const};
    for(const id of [a.id,b.id]){const p=await page(await f.get()),body={version:1 as const,session:p.projection.session!,occurrenceId:id,expectedEvidenceRevision:p.highWater,verdict:"safe" as const};
      const receipt=await f.writes.safetyPrepareReview(body,actor);expect((await f.writes.safetyCommitReview(receipt.requestId!,body,actor)).stage).toBe("verdict_committed");}
    const partial=await page(await f.get("?limit=1"));expect(partial.projection.restriction).toBe("normal");expect(partial.snapshotComplete).toBe(false);
    const store=createSafetyStore();store.getState().reset(true);store.getState().begin("normal");store.getState().page("normal",partial);
    expect(store.getState().normal,"PARTIAL_ZERO_COUNT_IS_NOT_NORMAL").toBe(false);
    const before=f.db.query("SELECT COUNT(*) n FROM safety_decisions").get();
    const ws=await f.connect();ws.send({type:"safety_read",version:1,requestId:"forged",target:{sessionId:"ithaca"},verdict:"safe"});
    const refused=await ws.until(m=>m.type==="error");expect(refused.type==="error"&&refused.code).toBe("PARSE_ERROR");
    expect(f.db.query("SELECT COUNT(*) n FROM safety_decisions").get()).toEqual(before);expect(f.starts()).toBe(0);
    const response=await f.get("","");expect(response.status).toBe(401);expect(JSON.stringify(await response.json())).not.toContain("projection");
  }finally{await f.close();}
});

test("shipped SDK client negotiates the read capability over an authenticated real socket",async()=>{
  const f=await safetyHistoryFixture();let client:import("@schlessera/brain-ui-sdk/client").BrainUiClient|undefined;
  try{
    await f.add("A");const {BrainUiClient}=await import("@schlessera/brain-ui-sdk/client");
    const AuthenticatedWebSocket=WebSocket as unknown as new(url:string,options:Bun.WebSocketOptions)=>WebSocket;
    let resolve!:(page:SafetyPage)=>void,reject!:(error:Error)=>void;
    const result=new Promise<SafetyPage>((yes,no)=>{resolve=yes;reject=no;});
    const timer=setTimeout(()=>reject(new Error("SDK safety negotiation deadline")),3000);
    try{
      client=new BrainUiClient({url:f.url,socketFactory:url=>new AuthenticatedWebSocket(url,{headers:{cookie:f.cookie}}),handlers:{
        server_hello:hello=>{expect(hello.safetyCapabilities?.review).toBe(false);expect(hello.capabilities?.sessionSafetyHistory).toBe(true);
          client!.send({type:"safety_read",version:1,requestId:"sdk",target:{sessionId:"ithaca"}});},
        safety_history:frame=>resolve(frame.page),
      }});client.connect();
      expect((await result).projection.unresolvedCount,"SDK_NEGOTIATES_REAL_SAFETY_READ").toBe(1);
    }finally{clearTimeout(timer);}
  }finally{client?.close();await f.close();}
});

test("retirement invalidates a live safety-only subscription without requiring chat deletion UI capability",async()=>{
  const f=await safetyHistoryFixture();try{
    await f.add("A");const initial=await page(await f.get()),client=await f.connect();
    client.send({type:"safety_subscribe",version:1,requestId:"retirement",identity:initial.identity,afterRevision:initial.highWater,snapshotId:initial.snapshotId});
    client.send({type:"ping",probeId:"subscribed"});await client.until(m=>m.type==="pong");
    const retired=retireChat(f.db,{operationId:"live-retire",principalId:f.principal.id,target:{sessionId:"ithaca"},expected:{backendId:"claude",generation:1},removableBackends:["claude"],at:Date.now()});
    expect(retired.status).toBe("retired");if(retired.status!=="retired")throw new Error("Retirement refused");
    f.host.chatRetired(f.principal.id,retired);
    const terminal=await client.until(m=>m.type==="safety_unavailable");expect(terminal).toMatchObject({requestId:"retirement",reason:"unavailable"});
    expect((await f.get()).status).toBe(404);expect(f.starts()).toBe(0);
  }finally{await f.close();}
});

test("authenticated history query validation refuses oversized, duplicated or authority-bearing selectors",async()=>{
  const f=await safetyHistoryFixture();try{
    await f.add("A");
    for(const suffix of ["?limit=0","?limit=101","?limit=1.5","?limit=1&limit=2","?cursor=","?cursor="+"a".repeat(513),"?principalId=odysseus","?verdict=safe"]){
      const response=await f.get(suffix);expect(response.status,"BOUNDED_READ_QUERY").toBe(400);expect(JSON.stringify(await response.json())).not.toContain("projection");}
    expect(f.db.query("SELECT COUNT(*) n FROM safety_decisions").get()).toEqual({n:0});expect(f.starts()).toBe(0);
  }finally{await f.close();}
});

test("replaced or concurrent delta reads retain bounded ownership until their asynchronous wait settles",async()=>{
  const f=await safetyHistoryFixture();try{
    const initial=await page(await f.get()),held=f.hold();
    const requests=Array.from({length:33},()=>f.history.delta(f.principal,initial.identity,initial.highWater,initial.snapshotId).then(value=>({ok:true as const,value}),error=>({ok:false as const,error})));
    await held.arrived;
    const refused=await Promise.race([requests.at(-1)!,Promise.resolve({ok:true as const,value:null})]);held.release();
    expect(refused.ok,"DELTA_WAIT_CAPACITY_FENCE").toBe(false);
    if(!refused.ok)expect(refused.error.message).toBe("capacity");
    const results=await Promise.all(requests);expect(results.filter(r=>r.ok)).toHaveLength(32);
    expect((await f.history.delta(f.principal,initial.identity,initial.highWater,initial.snapshotId)).projection.unresolvedCount).toBe(0);
  }finally{await f.close();}
});
