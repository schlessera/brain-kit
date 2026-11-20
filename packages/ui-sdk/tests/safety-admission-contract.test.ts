import { expect,test } from 'bun:test';
import { safetyRecordSchema } from '../src/safety';
const record={kind:'occurrence',id:'ithaca',sequence:'1',observedAt:1,turnId:'voyage',bindingId:'bound',occurrenceId:'ithaca',detailPruned:false,epochId:'epoch',detector:'proxy_input',source:'egress_connection',operationId:null,signalId:'signal',exposureId:'exposure',exposure:'finalized',summary:'Ithaca',provenance:null};
test('review7: trusted wire admission requires complete immutable evidence',()=>{
 const trusted={trusted:true,ruleId:'ithaca',policyHash:'a'.repeat(64),trustRevision:'1',collectionRevision:'2'};expect(safetyRecordSchema.safeParse({...record,admission:trusted}).success).toBe(true);
 for(const admission of [{...trusted,policyHash:null},{...trusted,ruleId:undefined},{...trusted,collectionRevision:undefined},{...trusted,trusted:false}])expect(safetyRecordSchema.safeParse({...record,admission}).success,'TRUSTED_WIRE_EVIDENCE_IS_COMPLETE_AND_DISCRIMINATED').toBe(false);
 expect(safetyRecordSchema.safeParse({...record,admission:{trusted:false,policyHash:null,trustRevision:'1'}}).success).toBe(true);expect(safetyRecordSchema.safeParse(record).success).toBe(true);expect(safetyRecordSchema.safeParse({...record,detector:'invented'}).success).toBe(false);
});
