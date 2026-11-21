import { expect, test } from "bun:test";
import { z } from "zod";
import { parseServerMessage } from "../../ui-sdk/src/schemas.js";

// Preserve the previous Activity discriminators even if a future SDK expands
// them. Scrub states belong inside the existing unknown event payload.
const previousDelta=z.looseObject({type:z.literal("activity_delta"),runId:z.string(),seq:z.number(),
  span:z.looseObject({spanId:z.string(),runId:z.string(),name:z.string(),kind:z.enum(["turn","tool","subagent","cron"]),
    origin:z.enum(["session","cron","autonomous","compute"]),startedAt:z.number(),
    outcome:z.enum(["success","error","timeout","cancelled","denied","interrupted"]).optional(),attrs:z.record(z.string(),z.unknown()).optional()}).optional(),
  event:z.looseObject({spanId:z.string(),eventIndex:z.number(),ts:z.number(),eventType:z.string(),payload:z.unknown().optional()}).optional()});

for(const state of ["complete","skipped","partial"] as const)test(`previous Activity schema accepts maintenance scrub ${state} without a new discriminator`,()=>{
 const payload={state,...(state==="partial"?{capacityBlocked:1,readFailures:[{path:"a".repeat(64),errorClass:"Error",message:"Ithaca read refused"}]}:{}),reason:state==="skipped"?"journal_busy":state==="partial"?"quarantine_pending":null,listed:0,quarantined:0,quarantinedBytes:0,pending:state==="partial"?1:0,pendingBytes:state==="partial"?6:0};
 const frame={type:"activity_delta",runId:"maintenance",seq:1,
   span:{spanId:"maintenance:root",runId:"maintenance",name:"cron maintain",kind:"cron",origin:"cron",startedAt:1,outcome:"success",attrs:{"maintenance.journal_scrub":JSON.stringify(payload)}},
   event:{spanId:"maintenance:root",eventIndex:0,ts:1,eventType:"journal_scrub",payload}};
 expect(previousDelta.safeParse(frame).success,"PREVIOUS_ACTIVITY_SCHEMA_ACCEPTS_SCRUB").toBe(true);
 // The production SDK schema in this branch is unchanged from the parent.
 expect(parseServerMessage(JSON.stringify(frame)).ok,"PREVIOUS_SDK_PARSER_RETAINS_WHOLE_FRAME").toBe(true);
 expect(previousDelta.safeParse({...frame,span:{...frame.span,outcome:"partial"}}).success,"CLOSED_ENUM_NEGATIVE_CONTROL").toBe(false);
});

test("previous Activity schema accepts the scrub failure event and existing error outcome",()=>{
 const frame={type:"activity_delta",runId:"maintenance",seq:2,
   span:{spanId:"maintenance:root",runId:"maintenance",name:"cron maintain",kind:"cron",origin:"cron",startedAt:1,outcome:"error"},
   event:{spanId:"maintenance:root",eventIndex:1,ts:2,eventType:"journal_scrub_failed",payload:{site:"journal.scrub",errorClass:"Error",message:"storage unavailable",at:2}}};
 expect(previousDelta.safeParse(frame).success).toBe(true);
 expect(parseServerMessage(JSON.stringify(frame)).ok).toBe(true);
});

test("the previous schema parses actual host scrub Activity records",async()=>{
 const {mkdtempSync,mkdirSync,rmSync,writeFileSync}=await import("node:fs"),{tmpdir}=await import("node:os"),{join}=await import("node:path");
 const {createUiDb}=await import("../src/db/client.js"),{createTurnJournal}=await import("../src/brain/turn-journal.js");
 const {createNativeJournalFixture}=await import("./helpers/native-journal-fixture.js");
 const {createActivityStore}=await import("../src/activity/store.js"),{toWireSpan,toWireEvent}=await import("../src/activity/stream.js");
 const root=mkdtempSync(join(tmpdir(),"odysseus-scrub-wire-")),brain=join(root,"brain");mkdirSync(brain);writeFileSync(join(brain,"ithaca.md"),"# Ithaca");
 const native=createNativeJournalFixture(brain,root),path=join(root,"ui.db"),db=createUiDb(path);
 const journal=createTurnJournal(db,{brainPath:brain,dbPath:path,objectsRoot:join(root,"objects"),nativeManager:native.manager});
 try{
  await journal.maintain();
  const changes=createActivityStore(db).changesSince(0).filter(change=>change.runId.startsWith("cron-journal-scrub-"));
  expect(changes.some(change=>change.kind==="event"),"ACTUAL_SCRUB_EVENT_EMITTED").toBe(true);
  for(const change of changes){
   const frame={type:"activity_delta",runId:change.runId,seq:change.seq,...(change.kind==="span"?{span:toWireSpan(change.span)}:{event:toWireEvent(change.event)})};
   expect(previousDelta.safeParse(frame).success,"PREVIOUS_SCHEMA_ACCEPTS_ACTUAL_SCRUB_RECORD").toBe(true);
   expect(parseServerMessage(JSON.stringify(frame)).ok).toBe(true);
  }
 }finally{await journal.close();await native.close();db.close();rmSync(root,{recursive:true,force:true});}
});
