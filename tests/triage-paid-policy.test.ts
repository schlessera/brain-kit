import { test, expect } from "bun:test";
import { sha } from "../packages/ui-server/evals/triage/experiment/adapter";
import { ReviewBudget, validatePaidPolicy, acceptedRate, usageUpper, rejectResponseModifiers, reparseBudget, EXTRA_USAGE_AUTHORIZATION, type RootPaidPolicy } from "../packages/ui-server/evals/triage/experiment/paid-policy";
import { consumeGrant, validGrantEvidence } from "../packages/ui-server/evals/triage/experiment/grant";
import { mkdtempSync,readFileSync,rmSync,writeFileSync,chmodSync,symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
const prompt="Review complete Odysseus fixture";
export const binding={freezeSha:sha("freeze"),inputSha:sha("input"),protocolSha:sha("protocol"),runtimeSha:sha("runtime"),proofSha:sha("proof"),promptSha:sha(prompt)};
export function policy():RootPaidPolicy{const grantNonce=sha("synthetic-policy-grant");return {...binding,grantNonce,consumedMarkerPath:`/tmp/owned-fixture-grants/${grantNonce}.json`,version:1,issue:848,authorizationUrl:EXTRA_USAGE_AUTHORIZATION,allowOverage:true,basis:"actual additional billed charges",perIssueCapUsd:15,aggregateCapUsd:150,remainingUpperUsd:15,issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),canonicalModel:"claude-sonnet-5-5",maxPhysicalRequests:24,maxInputBytes:5_000_000,maxInputTokens:1_000_000,contextWindowTokens:1_000_000,maxOutputTokens:128000,inputUsdPerMillionUpper:8,outputUsdPerMillionUpper:20,invoiceUsd:null};}
const bytes=(extra:Record<string,unknown>={})=>Buffer.from(JSON.stringify({model:"claude-sonnet-5-5",max_tokens:8000,tools:[],output_config:{effort:"low"},messages:[{role:"user",content:prompt}],...extra}));
const tokens={input_tokens:17,output_tokens:23,cache_read_input_tokens:0,cache_creation_input_tokens:0};
test("root paid policy rejects missing, expired, mismatched and nonfinite allocations",()=>{
 expect(()=>validatePaidPolicy(policy(),binding)).not.toThrow();
 for(const change of [{remainingUpperUsd:NaN},{remainingUpperUsd:Infinity},{remainingUpperUsd:-1},{remainingUpperUsd:16},{allowOverage:false},{authorizationUrl:"unapproved"},{expiresAt:new Date(0).toISOString()},{inputSha:sha("changed")},{maxOutputTokens:128001},{inputUsdPerMillionUpper:0}])expect(()=>validatePaidPolicy({...policy(),...change} as RootPaidPolicy,binding)).toThrow();
});
test("actual pretransport budget refuses wrong model, prompt, bounds and modifiers before fetch",async()=>{
 let forwarded=0;const p=policy(),budget=new ReviewBudget(p,binding,()=>{});
 const transport=async(body:Buffer)=>{const index=budget.reserve(body);forwarded++;budget.settle(index,tokens);};
 for(const extra of [{model:"unexpected-model"},{messages:[{role:"user",content:"different prompt"}]},{max_tokens:0},{max_tokens:128001},{max_tokens:NaN},{tools:[{name:"Read"}]},{output_config:{effort:"high"}},{service_tier:"priority"},{inference_geo:"unknown-region"},{speed:"fast"}])await expect(transport(bytes(extra))).rejects.toThrow();
 expect(forwarded).toBe(0);await transport(bytes());expect(forwarded).toBe(1);
});
test("single physical reservation persists before forwarding and failed unknown cost remains locked",()=>{
 const states:any[]=[];const budget=new ReviewBudget(policy(),binding,e=>states.push(e));
 const first=budget.reserve(bytes());expect(states[0][0].status).toBe("reserved");expect(budget.usedUpper()).toBeGreaterThan(0);
 expect(()=>budget.reserve(bytes())).toThrow("inflight");budget.unknown(first);expect(budget.entries[0]!.status).toBe("unknown");expect(budget.entries[0]!.pricedUpperUsd).toBeNull();expect(budget.usedUpper()).toBe(states[0][0].reservedUpperUsd);expect(()=>budget.reserve(bytes())).toThrow("unknown");
});
test("short physical wire reserves full context before forwarding and accepts larger known input counters",async()=>{
 const wire=bytes(),states:any[]=[];const budget=new ReviewBudget(policy(),binding,e=>states.push(e));let forwarded=0;
 const upstream=async()=>{forwarded++;return{...tokens,input_tokens:wire.byteLength+257};};
 const index=budget.reserve(wire);expect(states[0][0].inputBound).toBe(1_000_000);expect(budget.usedUpper()).toBeCloseTo(8.16,12);expect(forwarded).toBe(0);
 const usage=await upstream();expect(usage.input_tokens).toBeGreaterThan(wire.byteLength);budget.settle(index,usage);
 expect(forwarded).toBe(1);expect(budget.entries[0]!.status).toBe("complete");expect(budget.usedUpper()).toBeCloseTo((usage.input_tokens*2.2+23*11)/1e6,12);expect(budget.entries[0]!.invoiceUsd).toBeNull();
});
test("known complete terminal usage reclaims only conservative priced upper and reparses literal budget",()=>{
 const p=policy(),budget=new ReviewBudget(p,binding,()=>{});budget.settle(budget.reserve(bytes()),tokens);expect(budget.usedUpper()).toBeCloseTo(.0002904,12);expect(budget.entries[0]!.invoiceUsd).toBeNull();
 const calls=[{rawRequestBase64:bytes().toString("base64"),usage:tokens}];expect(reparseBudget(p,binding,budget.entries,calls)).toBe(true);
 expect(reparseBudget(p,binding,[{...budget.entries[0]!,reservedUpperUsd:0}],calls)).toBe(false);
 expect(reparseBudget(p,binding,budget.entries,[{...calls[0],usage:{...tokens,service_tier:"priority"}}])).toBe(false);
});
test("Standard usage settlement retains independent fresh/read/long-write ceilings and refuses unknown modifiers",()=>{
 const b=new ReviewBudget(policy(),binding,()=>{}),usage={input_tokens:17,output_tokens:23,cache_read_input_tokens:19,cache_creation_input_tokens:11,service_tier:"standard",inference_geo:"us"};
 b.settle(b.reserve(bytes()),usage);expect(b.usedUpper()).toBeCloseTo(.00034089,12);expect(b.entries[0]!.invoiceUsd).toBeNull();
 const bad=new ReviewBudget(policy(),binding,()=>{}),id=bad.reserve(bytes());const invalid={...usage,service_tier:"priority"};expect(()=>bad.settle(id,invalid)).toThrow("modifier");expect(bad.entries[0]!.status).toBe("unknown");
});
test("per-request cap stops next physical and complete usage cannot exceed reserved context/output",()=>{
 const p={...policy(),remainingUpperUsd:.01};const budget=new ReviewBudget(p,binding,()=>{});expect(()=>budget.reserve(bytes())).toThrow("exceeds remaining");expect(budget.entries).toEqual([]);
 const b=new ReviewBudget(policy(),binding,()=>{}),id=b.reserve(bytes());expect(()=>b.settle(id,{...tokens,cache_read_input_tokens:1_000_001})).toThrow("bound");expect(b.entries[0]!.status).toBe("unknown");
 for(const bad of [{...tokens,cache_read_input_tokens:undefined},{...tokens,output_tokens:NaN},{...tokens,input_tokens:-1}])expect(()=>usageUpper(bad as any,1_000_000,128000)).toThrow();
});
test("active overage needs explicit paid mode; genuine paid rejection and unknown state never pass",()=>{
 expect(acceptedRate({status:"allowed",isUsingOverage:true},false)).toBe(false);expect(acceptedRate({status:"allowed_warning",overageStatus:"allowed_warning",isUsingOverage:true},true)).toBe(true);
 expect(acceptedRate({status:"rejected",overageStatus:"allowed",isUsingOverage:true},true)).toBe(true);
 expect(acceptedRate({status:"rejected",overageStatus:"allowed",isUsingOverage:true},false)).toBe(false);
 expect(acceptedRate({status:"allowed_warning",isUsingOverage:false},false)).toBe(true);
 for(const info of [{status:"allowed",isUsingOverage:true},{status:"allowed",overageStatus:"disabled",isUsingOverage:true},{status:"rejected",isUsingOverage:true},{status:"allowed",overageStatus:"rejected",isUsingOverage:true},{status:"unknown",isUsingOverage:false},{status:"allowed"}])expect(acceptedRate(info,true)).toBe(false);
});
test("atomic root nonce remains consumed across failures and new outputs; replay reparses without reclaim",()=>{
 const parent=mkdtempSync(join(tmpdir(),"Odysseus-paid-grant-"));
 try{
  const p={...policy(),consumedMarkerPath:join(parent,`${policy().grantNonce}.json`)},start=new Date().toISOString();
  const claim=consumeGrant(p,binding),bytes=readFileSync(p.consumedMarkerPath);
  expect(validGrantEvidence(p,binding,bytes,claim.sha,start,Date.now())).toBe(true);
  // Simulate a failed invocation: its marker is intentionally still present.
  expect(()=>consumeGrant(p,binding)).toThrow();expect(readFileSync(p.consumedMarkerPath).equals(bytes)).toBe(true);
  expect(validGrantEvidence(p,{...binding,inputSha:sha("different")},bytes,claim.sha,start,Date.now())).toBe(false);
  writeFileSync(p.consumedMarkerPath,"changed marker");expect(validGrantEvidence(p,binding,bytes,claim.sha,start,Date.now())).toBe(false);
 }finally{rmSync(parent,{recursive:true,force:true});}
});
test("root grant refuses public/symlink parent and missing nonce before any model boundary",()=>{
 const parent=mkdtempSync(join(tmpdir(),"Odysseus-grant-mode-"));
 try{const p={...policy(),consumedMarkerPath:join(parent,`${policy().grantNonce}.json`)};chmodSync(parent,0o755);expect(()=>consumeGrant(p,binding)).toThrow("Protected coordinator");
  chmodSync(parent,0o700);const alias=join(parent,"alias");symlinkSync(parent,alias);expect(()=>consumeGrant({...p,consumedMarkerPath:join(alias,`${p.grantNonce}.json`)},binding)).toThrow("Protected coordinator");
  expect(()=>validatePaidPolicy({...p,grantNonce:""},binding)).toThrow("one-use");
 }finally{rmSync(parent,{recursive:true,force:true});}
});

test("future-issued policy stops the actual budget boundary before forwarding",async()=>{
 let forwarded=0;const p={...policy(),issuedAt:new Date(Date.now()+10000).toISOString()};
 const forward=async()=>{const b=new ReviewBudget(p,binding,()=>{});b.reserve(bytes());forwarded++;};
 await expect(forward()).rejects.toThrow("policy");expect(forwarded).toBe(0);
});
test("completed ledger and consumed grant remain verifiable as-of dispatch after expiry",()=>{
 const parent=mkdtempSync(join(tmpdir(),"Odysseus-asof-grant-")),now=Date.now(),at=now-2000;
 try {
  const p={...policy(),issuedAt:new Date(at-1000).toISOString(),expiresAt:new Date(now-1000).toISOString(),consumedMarkerPath:join(parent,`${policy().grantNonce}.json`)};
  const claim=consumeGrant(p,binding,at),raw=readFileSync(p.consumedMarkerPath),b=new ReviewBudget(p,binding,()=>{},()=>at);
  b.settle(b.reserve(bytes()),tokens);
  expect(reparseBudget(p,binding,b.entries,[{rawRequestBase64:bytes().toString("base64"),usage:tokens}])).toBe(true);
  expect(validGrantEvidence(p,binding,raw,claim.sha,new Date(at).toISOString(),at)).toBe(true);
  expect(()=>validatePaidPolicy(p,binding,now)).toThrow("expired");
 }finally{rmSync(parent,{recursive:true,force:true});}
});
test("known Standard US bounds retain omission and literal regional usage without claiming global",()=>{
 const b=new ReviewBudget(policy(),binding,()=>{});b.settle(b.reserve(bytes({inference_geo:"us",service_tier:"auto"})),tokens);
 expect(b.usedUpper()).toBeCloseTo(.0002904,12);expect(()=>rejectResponseModifiers({...tokens,inference_geo:"us",service_tier:"standard"})).not.toThrow();
 expect(()=>rejectResponseModifiers({...tokens,inference_geo:"not_available",service_tier:"standard"})).not.toThrow();
 expect(()=>rejectResponseModifiers({...tokens,inference_geo:"unknown-region"})).toThrow("modifier");
});

test("actual pretransport sole user payload refuses appended user, text, image and tool blocks",async()=>{
 let forwarded=0;const b=new ReviewBudget(policy(),binding,()=>{});
 const send=async(messages:any[])=>{const n=b.reserve(bytes({messages}));forwarded++;b.settle(n,tokens);};
 for(const messages of [
  [{role:"user",content:prompt},{role:"user",content:"extra unreviewed source"}],
  [{role:"user",content:[{type:"text",text:prompt},{type:"text",text:"extra unreviewed source"}]}],
  [{role:"user",content:[{type:"text",text:prompt},{type:"image",source:{type:"base64",data:"unreviewed"}}]}],
  [{role:"user",content:[{type:"text",text:prompt},{type:"tool_result",content:"unreviewed"}]}],
 ])await expect(send(messages)).rejects.toThrow("sole frozen USER");
 expect(forwarded).toBe(0);
 await send([{role:"user",content:prompt},{role:"system",content:[{type:"text",text:"Native-generated system context"}]}]);expect(forwarded).toBe(1);
});
