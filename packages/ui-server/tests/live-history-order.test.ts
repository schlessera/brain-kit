import { expect, test } from "bun:test";
import type { DialoguePage, SessionHistoryMessage } from "@schlessera/brain-ui-sdk/protocol";
import { projectLiveHistory } from "../src/ws/live-history";
import { boundHistory } from "../src/voice/session-history";
const msg = (role: "user" | "assistant", content: string, extra: Partial<SessionHistoryMessage> = {}): SessionHistoryMessage => ({role,content,toolCalls:[],...extra});
const backend=(seq:number,turnId:string,text:string)=>({sequence:seq,identity:`b${seq}`,evidence:{kind:"backend" as const,turnId,start:0,end:text.length,text,digest:Bun.SHA256.hash(text,"hex")}});
const page: DialoguePage = { ownerId:"ithaca",generation:1,through:4,coverage:"complete",records:[
 {sequence:1,identity:"r1",evidence:{kind:"voice",conversationId:"old",epoch:1,providerId:"gemini-live",event:{kind:"output_transcript",sequence:0,outputId:"o",text:"Voice: the mast supports the sail."}}},
 {sequence:2,identity:"q",evidence:{kind:"request",turnId:"t1"}},
 backend(3,"t1","Typed answer one."),
]};
test("preserves newest unanswered typed question after witnessed exchange", ()=>{
 const out=projectLiveHistory([msg("user","Typed question one."),msg("assistant","Typed answer one.",{turnId:"t1"}),msg("user","NEWEST typed question with no answer yet.")],page);
 const texts=out.items.flatMap(i=>"text" in i ? [i.text]:[]);
 expect(texts.at(-1), "LATEST_UNANSWERED_QUESTION_IS_THE_NATIVE_TAIL").toBe("NEWEST typed question with no answer yet.");
 expect(out.coverage.reasons).toContain("ambiguous_order");
 const b=boundHistory(out,new Set(),{maxBytes:650,maxFactBytes:0,maxItems:128});
 expect(b.text,"LATEST_QUESTION_SURVIVES_BYTE_PRESSURE").toContain("NEWEST typed question with no answer yet.");
 expect(b.tailOmitted).toBe(false);
});
test("preserves native order: witnessed Q1/A1 then unwitnessed Q2/A2 (answer text differs from ranges)", ()=>{
 const p={...page,records:[...page.records,{sequence:4,identity:"q2",evidence:{kind:"request" as const,turnId:"t2"}},backend(5,"t2","Partial streamed")]};
 const out=projectLiveHistory([msg("user","Typed question one."),msg("assistant","Typed answer one.",{turnId:"t1"}),msg("user","Question two."),msg("assistant","Answer two, final native form.",{turnId:"t2"})],p);
 const texts=out.items.flatMap(i=>"text" in i ? [i.text]:[]);
 const native=["Typed question one.","Typed answer one.","Question two.","Answer two, final native form."];
 expect(native.map(t=>texts.indexOf(t)),"UNWITNESSED_GROUP_FOLLOWS_PRIOR_NATIVE_EXCHANGE").toEqual(native.map(t=>texts.indexOf(t)).sort((a,b)=>a-b));
 expect(out.coverage.reasons).toContain("ambiguous_order");
});
