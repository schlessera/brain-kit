import { test,expect } from "bun:test";
import { NativeBudget,PAID_AUTHORIZATION,digest,admittedNativeRate,reparseNativeBudget,type NativePaidPolicy } from "../scripts/evals/native-paid-policy";
const binding={freezeSha:digest("freeze"),inputSha:digest("input"),protocolSha:digest("protocol"),runtimeSha:digest("runtime"),proofSha:digest("proof"),promptSha:digest("Odysseus fixture")};
function policy():NativePaidPolicy{return {...binding,version:1,issue:842,control:"offline",purpose:"review",authorizationUrl:PAID_AUTHORIZATION,allowOverage:true,basis:"actual additional billed charges",perIssueCapUsd:15,aggregateCapUsd:150,remainingUpperUsd:15,canonicalModel:"claude-sonnet-5-5",maxPhysicalRequests:24,maxInputBytes:5_000_000,contextWindowTokens:1_000_000,maxOutputTokens:128000,inputUsdPerMillionUpper:8,outputUsdPerMillionUpper:20,invoiceUsd:null,grantNonce:digest("offline-only"),consumedMarkerPath:`/tmp/${digest("offline-only")}.json`,issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()};}
const wire=Buffer.from(JSON.stringify({model:"claude-sonnet-5-5",max_tokens:8000,tools:[],output_config:{effort:"low"},messages:[{role:"user",content:"Odysseus fixture"}]}));
const usage={input_tokens:17,output_tokens:23,cache_read_input_tokens:0,cache_creation_input_tokens:0};
test("actual preforward reservation binds original issue and full supported context rather than short wire",async()=>{
  const states:any[]=[];let forwarded=0;const p=policy(),b=new NativeBudget(842,"offline",p,binding,e=>states.push(e));
  const id=b.reserve(wire);expect(states[0][0].inputBound).toBe(1_000_000);expect(b.usedUpper()).toBeCloseTo(8.16,12);expect(forwarded).toBe(0);
  const upstream=async()=>{forwarded++;return usage;};b.settle(id,await upstream());expect(forwarded).toBe(1);expect(b.entries[0].status).toBe("complete");
  expect(reparseNativeBudget(842,"offline",p,binding,b.entries,[{requestBytesBase64:wire.toString("base64"),usage}])).toBe(true);
  expect(reparseNativeBudget(843,"offline",p,binding,b.entries,[{requestBytesBase64:wire.toString("base64"),usage}])).toBe(false);
});
test("actual dispatcher refuses wrong scope, expiry, source and exhausted root allocation before forwarding",async()=>{
  let forwarded=0;const dispatch=async(p:NativePaidPolicy)=>{const b=new NativeBudget(842,"offline",p,binding,()=>{});b.reserve(wire);forwarded++;};
  for(const change of [{issue:843},{control:"live"},{inputSha:digest("another input")},{expiresAt:new Date(0).toISOString()},{issuedAt:new Date(Date.now()+10000).toISOString()},{remainingUpperUsd:.01}])await expect(dispatch({...policy(),...change} as NativePaidPolicy)).rejects.toThrow();
  expect(forwarded).toBe(0);
});
test("missing usage and unsupported observed modifiers retain full unknown reservation",()=>{
  for(const bad of [{...usage,cache_read_input_tokens:undefined},{...usage,service_tier:"priority"}]){
    const b=new NativeBudget(842,"offline",policy(),binding,()=>{}),id=b.reserve(wire);expect(()=>b.settle(id,bad as any)).toThrow();
    expect(b.entries[0].status).toBe("unknown");expect(b.entries[0].pricedUpperUsd).toBeNull();expect(b.usedUpper()).toBeCloseTo(8.16,12);expect(()=>b.reserve(wire)).toThrow("unknown");
  }
});
test("literal included and active native quota states preserve paid rejection and uncertainty",()=>{
  expect(admittedNativeRate({status:"allowed",isUsingOverage:false,overageDisabledReason:"org_level_disabled"},false)).toBe(true);
  expect(admittedNativeRate({status:"rejected",overageStatus:"allowed",isUsingOverage:true},true)).toBe(true);
  expect(admittedNativeRate({status:"rejected",overageStatus:"allowed",isUsingOverage:true},false)).toBe(false);
  expect(admittedNativeRate({status:"rejected",overageStatus:"rejected",isUsingOverage:true},true)).toBe(false);
  expect(admittedNativeRate({status:"allowed",isUsingOverage:false,overageInUse:true},true)).toBe(false);
  expect(admittedNativeRate({status:"allowed"},true)).toBe(false);
});
test("actual reservation refuses appended unreviewed USER text before the request collaborator",async()=>{
  let forwarded=0;const dispatch=async(messages:any[])=>{const b=new NativeBudget(842,"offline",policy(),binding,()=>{});b.reserve(Buffer.from(JSON.stringify({...JSON.parse(wire.toString()),messages})));forwarded++;};
  await expect(dispatch([{role:"user",content:"Odysseus fixture"},{role:"user",content:"Unreviewed source"}])).rejects.toThrow("USER");
  await expect(dispatch([{role:"user",content:[{type:"text",text:"Odysseus fixture"},{type:"text",text:"Unreviewed source"}]}])).rejects.toThrow("USER");
  expect(forwarded).toBe(0);
});

test("review financial admission rejects malformed tools before reserving or forwarding",()=>{
  for(const tools of [{name:"Write"},"Write",[{}]]){
    const b=new NativeBudget(842,"offline",policy(),binding,()=>{});
    expect(()=>b.reserve(Buffer.from(JSON.stringify({...JSON.parse(wire.toString()),tools})))).toThrow("Exact frozen native prompt/tool/effort boundary");
    expect(b.entries).toHaveLength(0);
  }
});

test("job-fit workflow retains its original64-request bound while every review stays24",()=>{
  const p={...policy(),issue:847 as const,purpose:"workflow" as const,maxPhysicalRequests:64 as const};
  const b=new NativeBudget(847,"offline",p,binding,()=>{});
  for(let index=0;index<64;index++){const id=b.reserve(wire);expect(id).toBe(index);b.settle(id,usage);}
  expect(b.entries).toHaveLength(64);expect(()=>b.reserve(wire)).toThrow("physical bound");
  for(const change of [{purpose:"review"},{issue:846},{maxPhysicalRequests:24},{maxPhysicalRequests:65}])
    expect(()=>new NativeBudget((change.issue??847) as any,"offline",{...p,...change} as NativePaidPolicy,binding,()=>{})).toThrow("mismatched");
  expect(()=>new NativeBudget(847,"offline",{...p,purpose:"review",maxPhysicalRequests:24},binding,()=>{})).not.toThrow();
});
