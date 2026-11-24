import { expect,test } from 'bun:test';
import { safetyRecordSchema } from '../src/safety';
import { safetyPageSchema } from '../src/schemas';
const record={kind:'occurrence',id:'ithaca',sequence:'1',observedAt:1,turnId:'voyage',bindingId:'bound',occurrenceId:'ithaca',detailPruned:false,epochId:'epoch',detector:'proxy_input',source:'egress_connection',operationId:null,signalId:'signal',exposureId:'exposure',exposure:'finalized',summary:'Ithaca',provenance:{kind:'web_origin',origin:{scheme:'https',host:'ithaca.example.org',port:443},verifiedBy:'host_transport'}} as const;
test('review7: trusted wire admission requires complete immutable evidence',()=>{
 const trusted={trusted:true,ruleId:'ithaca',policyHash:'a'.repeat(64),trustRevision:'1',collectionRevision:'2'};expect(safetyRecordSchema.safeParse({...record,admission:trusted}).success).toBe(true);
 for(const admission of [{...trusted,policyHash:null},{...trusted,ruleId:undefined},{...trusted,collectionRevision:undefined},{...trusted,trusted:false}])expect(safetyRecordSchema.safeParse({...record,admission}).success,'TRUSTED_WIRE_EVIDENCE_IS_COMPLETE_AND_DISCRIMINATED').toBe(false);
 expect(safetyRecordSchema.safeParse({...record,admission:{trusted:false,policyHash:null,trustRevision:'1'}}).success).toBe(true);expect(safetyRecordSchema.safeParse(record).success).toBe(true);
});


test('review9: version-one history retains arbitrary valid detector IDs without admissions',()=>{
 const prior={...record,detector:'prior_detector_v1'};expect(safetyRecordSchema.parse(prior),'OLDER_V1_DETECTOR_IDS_REMAIN_READABLE').toEqual(prior);expect(safetyRecordSchema.safeParse({...prior,detector:'invalid/id'}).success).toBe(false);
});

for(const method of ['GET','CONNECT'])for(const port of [0,1,65535,65536,-1,1.5,NaN])test(`review17: ${method} destination port ${port} shares wire validation`,async()=>{
 const {validatedEgressProvenance}=await import('../src/server/egress-proxy');const destination={method,protocol:'http:',host:'ithaca.example.org',port};
 if(port===1||port===65535)expect(()=>validatedEgressProvenance(destination)).not.toThrow();else expect(()=>validatedEgressProvenance(destination),'DESTINATION_AND_WIRE_PORT_BOUNDS_AGREE').toThrow();
});
for(const method of ['GET','CONNECT'])for(const host of ['a'.repeat(253),'a'.repeat(254),'λ'.repeat(126),'λ'.repeat(127)])test(`review17: ${method} hostname ${Buffer.byteLength(host)} bytes shares wire validation`,async()=>{
 const {validatedEgressProvenance}=await import('../src/server/egress-proxy');const destination={method,protocol:'http:',host,port:443};
 if(Buffer.byteLength(host)<=253)expect(()=>validatedEgressProvenance(destination)).not.toThrow();else expect(()=>validatedEgressProvenance(destination),'DESTINATION_AND_WIRE_HOST_BYTE_BOUNDS_AGREE').toThrow();
});

test('review28: durable and wire admissions share verified provenance and bounded revisions',async()=>{
 const {OccurrenceSchema}=await import('../../ui-server/src/governance/occurrence');
 const admission={trusted:true,ruleId:'ithaca',policyHash:'a'.repeat(64),trustRevision:'1',collectionRevision:'2'};
 const verified={kind:'web_origin',origin:{scheme:'https',host:'ithaca.example.org',port:443},verifiedBy:'host_transport'};
 const durable={id:'ithaca',epochId:'epoch',operationId:null,signalId:'signal',exposureId:'exposure',detector:'proxy_input',exposure:'finalized',provenance:verified,admission};
 for(const schema of [OccurrenceSchema,safetyRecordSchema]){
 const base=schema===OccurrenceSchema?durable:{...record,provenance:verified,admission};expect(schema.safeParse(base).success).toBe(true);
 for(const change of [{provenance:null},{detector:'tool_web_input'},{admission:{...admission,trustRevision:'18446744073709551616'}},{admission:{...admission,collectionRevision:'99999999999999999999'}}])expect(schema.safeParse({...base,...change}).success,'TRUSTED_ADMISSION_REQUIRES_VERIFIED_PROXY_AND_U64_REVISIONS').toBe(false);
 }
});

test("the terminal delivery field keeps its public enum operations", () => {
  const state=safetyPageSchema.shape.records.element.options[1].shape.state;
  expect(state.extract(["finalized"]).parse("finalized")).toBe("finalized");
  expect(state.options).toContain("not_delivered");
});
