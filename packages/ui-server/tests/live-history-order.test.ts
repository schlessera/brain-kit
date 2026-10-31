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
 expect(b.tailOmitted,"OLDER_VOICE_IS_CAUSALLY_BEFORE_THE_RETAINED_NATIVE_TAIL").toBe(false);
});
test("preserves native order: witnessed Q1/A1 then unwitnessed Q2/A2 (answer text differs from ranges)", ()=>{
 const p={...page,records:[...page.records,{sequence:4,identity:"q2",evidence:{kind:"request" as const,turnId:"t2"}},backend(5,"t2","Partial streamed")]};
 const out=projectLiveHistory([msg("user","Typed question one."),msg("assistant","Typed answer one.",{turnId:"t1"}),msg("user","Question two."),msg("assistant","Answer two, final native form.",{turnId:"t2"})],p);
 const texts=out.items.flatMap(i=>"text" in i ? [i.text]:[]);
 const native=["Typed question one.","Typed answer one.","Question two.","Answer two, final native form."];
 expect(native.map(t=>texts.indexOf(t)),"UNWITNESSED_GROUP_FOLLOWS_PRIOR_NATIVE_EXCHANGE").toEqual(native.map(t=>texts.indexOf(t)).sort((a,b)=>a-b));
 expect(out.coverage.reasons).toContain("ambiguous_order");
});

for(const coverage of ["complete","partial"] as const)test(`all-unwitnessed typed prefix cannot outrank newest journal discussion coverage=${coverage}`,()=>{
 const records:DialoguePage["records"]=[
 {sequence:1,identity:"spoken-one",evidence:{kind:"voice",conversationId:"voice-first",epoch:1,providerId:"gemini-live",event:{kind:"unassigned_input_fragment",sequence:0,text:"V1 newer spoken question",timing:{kind:"unavailable"}}}},
 {sequence:2,identity:"spoken-two",evidence:{kind:"voice",conversationId:"voice-first",epoch:1,providerId:"gemini-live",event:{kind:"output_transcript",sequence:0,outputId:"o",text:"V2 newer spoken reply"}}},
 {sequence:3,identity:"spoken-three",evidence:{kind:"voice",conversationId:"voice-first",epoch:1,providerId:"gemini-live",event:{kind:"unassigned_input_fragment",sequence:1,text:"V3 newest spoken question",timing:{kind:"unavailable"}}}},
 ];
 const env=projectLiveHistory([msg("user","T1 old typed question"),msg("assistant","A1 old typed answer",{turnId:"before-owner-1"}),msg("user","T2 old typed question"),msg("assistant","A2 old typed answer",{turnId:"before-owner-2"})],{ownerId:"ithaca",generation:1,through:3,coverage,records});
 const texts=env.items.flatMap(i=>"text" in i?[i.text]:[]);
 expect(texts,"UNWITNESSED_PREFIX_PRECEDES_JOURNAL_WITHOUT_INVENTING_A_WITNESS").toEqual(["T1 old typed question","A1 old typed answer","T2 old typed question","A2 old typed answer","V1 newer spoken question","V2 newer spoken reply","V3 newest spoken question"]);
 expect(env.coverage.state).toBe("partial");expect(env.coverage.reasons).toContain("ambiguous_order");
 if(coverage==="partial")expect(env.coverage.reasons).toContain("write_gap");
 const bounded=boundHistory(env,new Set(),{maxBytes:600,maxItems:128,maxFactBytes:100});
 expect(bounded.text,"LATEST_JOURNAL_QUESTION_SURVIVES_OLD_UNANCHORED_PREFIX").toContain("V3 newest spoken question");
 expect(bounded.tailOmitted,"UNKNOWN_RECENCY_OF_DISCARDED_TEXT_IS_QUALIFIED").toBe(true);
 const full=boundHistory(env,new Set(),{maxBytes:24000,maxItems:128,maxFactBytes:100});expect(full.tailOmitted).toBe(false);
});
test("unknown group after a native anchor cannot jump over later journal speech",()=>{
 const p={...page,through:5,records:[...page.records,{sequence:5,identity:"latest-voice",evidence:{kind:"voice" as const,conversationId:"voice",epoch:1,providerId:"gpt-live",event:{kind:"unassigned_input_fragment" as const,sequence:0,text:"Newest witnessed spoken question?",timing:{kind:"unavailable" as const}}}}]};
 const env=projectLiveHistory([msg("user","Typed question one."),msg("assistant","Typed answer one.",{turnId:"t1"}),msg("user","Unwitnessed next typed question."),msg("assistant","Unwitnessed native answer.")],p);
 const texts=env.items.flatMap(i=>"text" in i?[i.text]:[]);
 expect(texts.indexOf("Unwitnessed next typed question.")).toBeGreaterThan(texts.indexOf("Typed answer one."));
 expect(texts.at(-1),"AMBIGUOUS_NATIVE_SLOT_CANNOT_REPLACE_JOURNAL_RECENCY").toBe("Newest witnessed spoken question?");
 expect(env.coverage.reasons).toContain("ambiguous_order");
});

test("unwitnessed native question cannot relocate its exactly witnessed assistant ranges",()=>{
 const text="First part. Last part.";
 const range=(sequence:number,start:number,end:number)=>({sequence,identity:`range-${sequence}`,evidence:{kind:"backend" as const,turnId:"before-owner",start,end,text:text.slice(start,end),digest:Bun.SHA256.hash(text.slice(start,end),"hex")}});
 const records:DialoguePage["records"]=[range(2,0,12),{sequence:3,identity:"between",evidence:{kind:"voice",conversationId:"voice",epoch:1,providerId:"gpt-live",event:{kind:"output_transcript",outputId:"o",sequence:0,text:"Interleaved witnessed voice."}}},range(4,12,text.length)];
 const env=projectLiveHistory([msg("user","Question before owner."),msg("assistant",text,{turnId:"before-owner"})],{ownerId:"ithaca",generation:1,coverage:"complete",through:4,records});
 expect(env.items.flatMap(i=>"text" in i?[i.text]:[]),"KNOWN_RANGE_POSITIONS_SURVIVE_AN_UNKNOWN_REQUEST").toEqual(["Question before owner.","First part. ","Interleaved witnessed voice.","Last part."]);
 expect(env.coverage.reasons).toContain("ambiguous_order");
});

test("exact unanswered user request outranks dense later-than-prefix voice records",()=>{
 const records:DialoguePage["records"]=[{sequence:1,identity:"q1",evidence:{kind:"request",turnId:"t1"}},backend(2,"t1","Answer one."),
 ...Array.from({length:60},(_,i)=>({sequence:i+3,identity:`voice-${i}`,evidence:{kind:"voice" as const,conversationId:"voice",epoch:1,providerId:"gpt-live",event:{kind:"output_transcript" as const,outputId:`o${i}`,sequence:0,text:`Earlier voice ${i}: ${"Harbour notes. ".repeat(40)}`}}})),
 {sequence:63,identity:"running",evidence:{kind:"request",turnId:"t2"}}];
 const env=projectLiveHistory([msg("user","Question one.",{turnId:"t1"}),msg("assistant","Answer one.",{turnId:"t1"}),msg("user","NEWEST running question?",{turnId:"t2"})],{ownerId:"ithaca",generation:1,coverage:"complete",through:63,records});
 for(const maxBytes of [7500,24000])expect(boundHistory(env,new Set(),{maxBytes,maxFactBytes:0,maxItems:128}).text,"EXACT_RUNNING_REQUEST_MUST_SURVIVE").toContain("NEWEST running question?");
});

test("unproven newest user is an unavailable gap with an honest newest omission",()=>{
 const env=projectLiveHistory([msg("user","Unclassified internal carrier.")],undefined,[],new Set(),new Set([0]));
 const b=boundHistory(env);
 expect(b.text).not.toContain("Unclassified internal carrier.");expect(b.text).toContain("source_unavailable");
 expect(b.coverage.state).toBe("partial");expect(b.tailOmitted,"UNPROVEN_NEWEST_USER_IS_NOT_SILENTLY_COMPLETE").toBe(true);
});

test("known newest voice does not warn about an older exactly witnessed native tail",()=>{
 const answer="Older complete answer. ".repeat(100);
 const records:DialoguePage["records"]=[{sequence:1,identity:"request",evidence:{kind:"request",turnId:"t1"}},backend(2,"t1",answer),{sequence:3,identity:"newest",evidence:{kind:"voice",conversationId:"voice",epoch:1,providerId:"gpt-live",event:{kind:"output_transcript",sequence:0,outputId:"newest",text:"Newest witnessed voice reply."}}}];
 const env=projectLiveHistory([msg("user","Older question.",{turnId:"t1"}),msg("assistant",answer,{turnId:"t1"})],{ownerId:"ithaca",generation:1,coverage:"complete",through:3,records});
 const b=boundHistory(env,new Set(),{maxBytes:650,maxFactBytes:0,maxItems:128});
 expect(b.text).toContain("Newest witnessed voice reply.");expect(b.text).not.toContain(answer);
 expect(b.tailOmitted,"OLDER_EXACT_NATIVE_TAIL_IS_NOT_POSSIBLY_NEWEST").toBe(false);
});

test("a later adjacent unwitnessed assistant remains a possible newest item after a witnessed fact",()=>{
 const records:DialoguePage["records"]=[{sequence:1,identity:"q1",evidence:{kind:"request",turnId:"t1",requestId:"r1"}},backend(2,"t1","The mast is ready."),{sequence:3,identity:"voice",evidence:{kind:"voice",conversationId:"voice",epoch:1,providerId:"gpt-live",event:{kind:"output_transcript",sequence:0,outputId:"reply",text:"Newest witnessed voice."}}}];
 const fact={turnId:"t1",requestId:"r1",item:{ref:"fact-one",kind:"host_fact" as const,outcome:"completed" as const,text:"The mast is ready.",result:{conversationId:"voice",epoch:1,requestId:"r1",turnId:"t1"},completeness:"retained_bounded" as const}};
 const later="Unwitnessed later assistant. ".repeat(60);
 const env=projectLiveHistory([msg("user","Is the mast ready?",{turnId:"t1"}),msg("assistant","The mast is ready.",{turnId:"t1"}),msg("assistant",later,{turnId:"t9"})],{ownerId:"ithaca",generation:1,coverage:"complete",through:3,records},[fact]);
 const bounded=boundHistory(env,new Set(),{maxBytes:600,maxFactBytes:200,maxItems:128});
 expect(bounded.text).not.toContain(later);expect(bounded.text).toContain("Newest witnessed voice.");
 expect(bounded.tailOmitted,"ADJACENT_ASSISTANT_AFTER_FACT_CANNOT_BE_SILENTLY_OMITTED").toBe(true);
 const full=boundHistory(env);expect(full.text).toContain(later);expect(full.tailOmitted,"RETAINED_ADJACENT_ASSISTANT_HAS_NO_NEWEST_OMISSION").toBe(false);
 const factTail=projectLiveHistory([msg("user","Is the mast ready?",{turnId:"t1"}),msg("assistant","The mast is ready.",{turnId:"t1"})],{ownerId:"ithaca",generation:1,coverage:"complete",through:3,records},[fact]);
 expect(boundHistory(factTail,new Set(),{maxBytes:600,maxFactBytes:0,maxItems:128}).tailOmitted,"KNOWN_OLDER_FACT_IS_NOT_NEWEST_WHEN_VOICE_IS_LATER").toBe(false);
});
