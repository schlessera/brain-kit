import { expect, test } from "bun:test";
import type { DialoguePage, SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import { readLiveHistory, projectLiveHistory } from "../src/ws/live-history";
import type { WsHost } from "../src/ws/host";

const msg = (role: "user" | "assistant", content: string, extra: Partial<SessionHistoryMessage> = {}): SessionHistoryMessage => ({role,content,toolCalls:[],...extra});
const page: DialoguePage = { ownerId:"ithaca",generation:1,through:4,coverage:"complete",records:[
 {sequence:1,identity:"request",evidence:{kind:"request",requestId:"r",turnId:"t"}},
 {sequence:2,identity:"speech",evidence:{kind:"voice",conversationId:"old",epoch:1,providerId:"gemini-live",event:{kind:"unassigned_input_fragment",sequence:0,text:"While that runs, explain the mast.",timing:{kind:"unavailable"}}}},
 {sequence:3,identity:"backend",evidence:{kind:"backend",turnId:"t",start:0,end:"Bronze owl.".length,text:"Bronze owl.",digest:Bun.SHA256.hash("Bronze owl.","hex")}},
 {sequence:4,identity:"reply",evidence:{kind:"voice",conversationId:"old",epoch:1,providerId:"gemini-live",event:{kind:"output_transcript",sequence:0,outputId:"o",text:"The mast supports the sail."}}},
]};
test("canonical mapping keeps actual discussion, exact native range order and engine provenance without task wrapper",()=>{
 const out=projectLiveHistory([msg("user","Where is the departure note?"),msg("assistant","We can look for it."),msg("user",'internal task wrapper {"recognized":"not authenticated"}',{source:"voice-context"}),msg("assistant","Bronze owl.",{turnId:"t"})],page);
 expect(JSON.stringify(out)).not.toContain("internal task wrapper");
 expect(out.items.filter(i=>i.kind!=="gap").map(i=>i.text)).toEqual(["Where is the departure note?","We can look for it.","While that runs, explain the mast.","Bronze owl.","The mast supports the sail."]);
 expect(out.items.find(i=>i.kind==="recognized")).toMatchObject({provenance:{providerId:"gemini-live",conversationId:"old",epoch:1}});
 // Unwitnessed earlier native answer has no inferred cross-stream position.
 expect(out.coverage.reasons).toContain("ambiguous_order");
});
test("range copies never replace native final answers; partial evidence and newest-page omissions are honest",()=>{
 const incomplete={...page,cursor:"bounded",coverage:"partial" as const,records:page.records.map(r=>r.evidence.kind==="backend"?{...r,evidence:{...r.evidence,text:"wrong text",digest:Bun.SHA256.hash("wrong text","hex")}}:r)};
 const out=projectLiveHistory([msg("assistant","Bronze owl. Full native conclusion.",{turnId:"t"})],incomplete);
 expect(out.items.find(i=>i.kind==="typed")).toMatchObject({text:"Bronze owl. Full native conclusion."});
 expect(out.coverage).toEqual({state:"partial",reasons:["ambiguous_order","older_omitted","write_gap"]});
});
function source(overrides: Record<string,unknown> = {}) {
 let valid=true, reads=0, backendReads=0;
 const host={historySettled:async()=>{},catalog:{dialogueRead:async()=>{reads++;return page;},dialogueOwnerForId:()=>({id:"ithaca",generation:1}),getStoredBackendId:()=>"fake",loadConversation:async()=>null,...overrides},registry:{getBackendForSession:async()=>({getHistory:async()=>{backendReads++;return [];}})},prepareHistory:(_id:string,m:SessionHistoryMessage[])=>m} as unknown as WsHost;
 return {host, authorized:()=>valid, revoke:()=>{valid=false;},counts:()=>({reads,backendReads})};
}
test("authorization failure does not read the journal or backend",async()=>{
 const f=source();f.revoke();expect(await readLiveHistory(f.host,"odysseus",{sessionId:"voyage"},f.authorized)).toBeUndefined();expect(f.counts()).toEqual({reads:0,backendReads:0});
});
test("revocation while canonical read awaits never reads backend or returns a seed",async()=>{
 let finish!:(p:DialoguePage)=>void;const f=source({dialogueRead:()=>new Promise<DialoguePage>(r=>{finish=r;})});
 const pending=readLiveHistory(f.host,"odysseus",{sessionId:"voyage"},f.authorized);while(!finish)await Bun.sleep(1);f.revoke();finish(page);expect(await pending).toBeUndefined();expect(f.counts().backendReads).toBe(0);
});
for(const failure of ["journal","generation"] as const)test(`${failure} read error fails closed without a context-free snapshot`,async()=>{
 const f=source(failure==="journal"?{dialogueRead:async()=>{throw Error("source failed");}}:failure==="generation"?{dialogueOwnerForId:()=>({id:"ithaca",generation:2})}:{attachMessageSources:()=>{throw Error("provenance failed");}});
 await expect(readLiveHistory(f.host,"odysseus",{sessionId:"voyage"},f.authorized)).rejects.toThrow();
});
test("authorized snapshot is recursively frozen, empty reads stay empty and do not execute tasks",async()=>{
 const f=source({dialogueRead:async()=>({...page,records:[]})});
 const out=await readLiveHistory(f.host,"odysseus",{sessionId:"voyage"},f.authorized);
 expect(out).toEqual({version:1,coverage:{state:"complete",reasons:[]},items:[]});expect(Object.isFrozen(out)).toBe(true);expect(Object.isFrozen(out!.items)).toBe(true);
});

test("submitted voice carriers keep their recorded chat source rather than fabricating recognized speech",()=>{
 const out=projectLiveHistory([msg("user","Reviewed and edited request.",{source:"voice-conversation"}),msg("user","Dictated message.",{source:"voice-dictate"})]);
 expect(out.items).toEqual([
  {ref:JSON.stringify(["native",0,"user"]),kind:"typed",role:"user",text:"Reviewed and edited request.",source:"voice-conversation"},
  {ref:JSON.stringify(["native",1,"user"]),kind:"typed",role:"user",text:"Dictated message.",source:"voice-dictate"},
 ]);
});

for(const mismatch of ["none","principal","conversation","session","turn"] as const)test(`unresolved exact carrier classification respects receipt identity mismatch=${mismatch}`,async()=>{
 const carrier='Internal task carrier {"recognized":"Research the mast."}';
 const native=[msg("user",carrier),msg("user","Later ordinary question."),msg("assistant","Later ordinary answer.",{turnId:"ordinary-turn"})];
 const stored={id:mismatch==="conversation"?"other":"old",principalId:mismatch==="principal"?"penelope":"odysseus",epoch:1,sessionId:mismatch==="session"?"other-session":"voyage",receipts:[{provenance:"contextual",turnId:mismatch==="turn"?"ordinary-turn":"missing-turn",submitted:carrier,state:"completed",requestId:"host-request",epoch:1}],results:[]};
 const f=source({loadConversation:async()=>stored});f.host.registry.getBackendForSession=async()=>({getHistory:async()=>native}) as never;
 if(mismatch==="none"||mismatch==="turn")await expect(readLiveHistory(f.host,"odysseus",{sessionId:"voyage"},f.authorized),"EXACT_CARRIER_WITHOUT_A_PROVABLE_NATIVE_JOIN_REFUSES").rejects.toThrow("Historical request provenance is unavailable");
 else{
  const pending=readLiveHistory(f.host,"odysseus",{sessionId:"voyage"},f.authorized);
  await expect(pending,"FOREIGN_RECEIPT_NEVER_OWNS_THIS_SNAPSHOT").resolves.toBeDefined();
  const out=await pending;
  expect(out!.items.flatMap(i=>i.kind==="typed"&&i.role==="user"?[i.text]:[]),"FOREIGN_RECEIPT_CANNOT_RECLASSIFY_OR_FILTER_NATIVE_TEXT").toEqual([carrier,"Later ordinary question."]);
 }
});
