import { expect, test } from "bun:test";
import { safetyReviewBodySchema, safetyReviewResponseSchema, parseServerMessage } from "../src/schemas";
import { SAFETY_READ_CAPABILITIES } from "../src/protocol";

const body = { version:1 as const, session:{sessionId:"ithaca",historyOwnerId:"voyage",historyGeneration:"1"},
  occurrenceId:"harbour-notice",expectedEvidenceRevision:"12",verdict:"safe" as const };
test("individual review schema accepts one exact ID and refuses bulk, authority and revision ambiguity",()=>{
  expect(safetyReviewBodySchema.parse(body)).toEqual(body);
  for (const value of [{...body,occurrenceIds:["A","B"]},{...body,principalId:"odysseus"},{...body,channel:"card"},
    {...body,rule:{}},{...body,expectedEvidenceRevision:"01"},{...body,expectedEvidenceRevision:"18446744073709551616"},
    {...body,session:{...body.session,historyGeneration:1}},{...body,occurrenceId:"A:B"}]) {
    expect(safetyReviewBodySchema.safeParse(value).success,"OWNER_REVIEW_CONTRACT_IS_STRICT_AND_INDIVIDUAL").toBe(false);
  }
});
test("review responses and negotiated capabilities remain optional bounded sidecars",()=>{
  const receipt = {...body,requestId:"review",operationId:"operation",stage:"refused",verdict:"unresolved",projection:null,reason:"not_finalized"};
  delete (receipt as Partial<typeof body>).expectedEvidenceRevision;
  expect(safetyReviewResponseSchema.safeParse({version:1,receipt,currentProjection:null}).success).toBe(true);
  expect(safetyReviewResponseSchema.safeParse({version:1,receipt:{...receipt,reason:"x".repeat(513)},currentProjection:null}).success).toBe(false);
  const hello = {type:"server_hello",protocolRev:5,capabilities:{sessionSafetyHistory:true}} as const;
  expect(parseServerMessage(JSON.stringify(hello))).toEqual({ok:true,message:hello});
  expect(parseServerMessage(JSON.stringify({...hello,safetyCapabilities:SAFETY_READ_CAPABILITIES}))).toMatchObject({message:{safetyCapabilities:{review:false}}});
  expect(parseServerMessage(JSON.stringify({...hello,safetyCapabilities:{...SAFETY_READ_CAPABILITIES,review:true,readOnlyReason:null,
    limits:{...SAFETY_READ_CAPABILITIES.limits,reviewBodyBytes:16384,reviewLifetimeMs:900000,receiptLifetimeMs:86400000}}}))).toMatchObject({message:{safetyCapabilities:{review:true,readOnlyReason:null}}});
});
