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
 const payload={state,reason:state==="skipped"?"journal_busy":state==="partial"?"quarantine_pending":null,listed:0,quarantined:0,quarantinedBytes:0,pending:state==="partial"?1:0,pendingBytes:state==="partial"?6:0};
 const frame={type:"activity_delta",runId:"maintenance",seq:1,
   span:{spanId:"maintenance:root",runId:"maintenance",name:"cron maintain",kind:"cron",origin:"cron",startedAt:1,outcome:"success",attrs:{"maintenance.journal_scrub":JSON.stringify(payload)}},
   event:{spanId:"maintenance:root",eventIndex:0,ts:1,eventType:"journal_scrub",payload}};
 expect(previousDelta.safeParse(frame).success,"PREVIOUS_ACTIVITY_SCHEMA_ACCEPTS_SCRUB").toBe(true);
 // The production SDK schema in this branch is unchanged from the parent.
 expect(parseServerMessage(JSON.stringify(frame)).ok,"PREVIOUS_SDK_PARSER_RETAINS_WHOLE_FRAME").toBe(true);
 expect(previousDelta.safeParse({...frame,span:{...frame.span,outcome:"partial"}}).success,"CLOSED_ENUM_NEGATIVE_CONTROL").toBe(false);
});
