import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AUTHORIZATION_URL, consumeGrant, assertPaidPolicy, PaidSpend, overageAllowed, type PaidBinding, type PaidPolicy } from "../scripts/evals/smart-capture/paid-policy";
const binding: PaidBinding = Object.fromEntries(["fixtureSha", "protocolSha", "sourceFreezeSha", "runtimeSha", "promptSha", "proofSha"].map((key, n) => [key, String(n+1).repeat(64)])) as unknown as PaidBinding;
const policy = (): PaidPolicy => ({ ...binding, purpose:"review",grantNonce:"1".repeat(64), consumedMarkerPath:`/tmp/offline-policy-test/${"1".repeat(64)}.json`, version: 1, issue: 839, authorizationUrl: AUTHORIZATION_URL, allowOverage: true, basis: "actual additional billed charges", perIssueCapUsd: 15, aggregateCapUsd: 150, remainingUpperUsd: 15, issuedAt:new Date(Date.now()-1000).toISOString(), expiresAt: new Date(Date.now()+60000).toISOString(), canonicalModel: "claude-sonnet-5-5", maxPhysicalRequests: 24, maxInputBytes: 3000000, maxInputTokens: 1000000, contextWindowTokens: 1000000, maxOutputTokens: 128000, inputUsdPerMillionUpper: 8, outputUsdPerMillionUpper: 20, invoiceUsd: null });
test("root paid policy binds every exact source/proof/runtime/prompt and never invents an invoice", () => {
  expect(assertPaidPolicy(policy(), binding).invoiceUsd).toBeNull();
  for (const key of Object.keys(binding)) expect(() => assertPaidPolicy({ ...policy(), [key]: "a".repeat(64) }, binding)).toThrow("not exact-bound");
  for (const change of [{ allowOverage: false }, { remainingUpperUsd: 0 }, { inputUsdPerMillionUpper: 0 }, { outputUsdPerMillionUpper: 0 }, { invoiceUsd: 0 }, { contextWindowTokens: 200000 }, { expiresAt: "2020-01-01" }, { issuedAt: new Date(Date.now()+10000).toISOString() }]) expect(() => assertPaidPolicy({ ...policy(), ...change }, binding)).toThrow();
});
test("physical paid reservation precedes dispatch, is serial and reduces only to conservative literal usage", () => {
  const p = policy(), spend = new PaidSpend(p, binding), body = { model: p.canonicalModel, max_tokens: 128000 };
  const reserved = spend.reserve(2700000, body); expect(reserved).toBe(10.56); expect(spend.retainedUpperUsd).toBe(10.56);
  expect(() => spend.reserve(1, body)).toThrow("concurrency");
  expect(spend.complete(reserved, { input_tokens: 10, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })).toBeCloseTo(.00022, 10);
  expect(spend.retainedUpperUsd).toBeCloseTo(.00022, 10); expect(p.invoiceUsd).toBeNull();
  expect(() => spend.reserve(2700000, { ...body, service_tier: "priority" })).toThrow();
  expect(() => spend.reserve(2700000, { ...body, inference_geo: "eu" })).toThrow();
});
test("unknown counters retain the worst-case paid reservation and block another request", () => {
  const p=policy(), spend=new PaidSpend(p,binding), body={model:p.canonicalModel,max_tokens:100}; const reserved=spend.reserve(1000,body);
  expect(() => spend.complete(reserved,{input_tokens:10,output_tokens:7})).toThrow("Unknown required");
  expect(spend.retainedUpperUsd).toBe(reserved); expect(() => spend.reserve(1000,body)).toThrow("prior failure");
});
test("paid admission preserves raw active/unknown overage flags and distinguishes paid-allowed from genuine rejection", () => {
  expect(overageAllowed({status:"allowed",isUsingOverage:true},false)).toBe(false);
  expect(overageAllowed({status:"allowed",overageStatus:"allowed",isUsingOverage:true},true)).toBe(true);
  expect(overageAllowed({status:"allowed_warning"},true)).toBe(true);
  expect(overageAllowed({status:"rejected",overageStatus:"allowed",isUsingOverage:true},true)).toBe(true);
  expect(overageAllowed({status:"rejected",overageStatus:"allowed_warning",isUsingOverage:true},true)).toBe(true);
  expect(overageAllowed({status:"rejected",overageStatus:"allowed",isUsingOverage:true},false)).toBe(false);
  expect(overageAllowed({status:"rejected",isUsingOverage:false},true)).toBe(false);
  expect(overageAllowed({status:"allowed",overageStatus:"rejected"},true)).toBe(false);
  expect(overageAllowed({status:"allowed",isUsingOverage:true},true)).toBe(false);
  expect(overageAllowed({status:"allowed",isUsingOverage:true,overageStatus:"allowed",overageDisabledReason:"user_disabled"},true)).toBe(false);
  expect(overageAllowed({status:"invented"},true)).toBe(false);
  expect(overageAllowed({status:"allowed",isUsingOverage:false,overageStatus:"disabled"},true)).toBe(false);
});

test("literal physical input and output cannot trade headroom inside the monetary bound", () => {
  const p=policy(), body={model:p.canonicalModel,max_tokens:1000};
  const input=new PaidSpend(p,binding), held=input.reserve(100,body);
  expect(() => input.complete(held,{input_tokens:1000001,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0})).toThrow("exceeds");
  expect(input.retainedUpperUsd).toBe(held); expect(input.stopped).toBe(true);
  const output=new PaidSpend(p,binding), held2=output.reserve(10000,{...body,max_tokens:1});
  expect(() => output.complete(held2,{input_tokens:1,output_tokens:2,cache_read_input_tokens:0,cache_creation_input_tokens:0})).toThrow("exceeds");
  expect(output.retainedUpperUsd).toBe(held2); expect(output.stopped).toBe(true);
});

test("protected root grant is atomically consumed once before any physical attempt and never reclaimed on failure",()=>{
  const root=mkdtempSync(join(tmpdir(),"brain-smart-paid-grant-"));chmodSync(root,0o700);
  const p={...policy(),consumedMarkerPath:join(root,`${"1".repeat(64)}.json`)};
  try{const grant=consumeGrant(p,binding);expect(grant.marker.invoiceUsd).toBeNull();expect(grant.marker.grantNonce).toBe(p.grantNonce);expect(JSON.parse(readFileSync(p.consumedMarkerPath,"utf8")).policySha).toBe(grant.marker.policySha);expect(()=>consumeGrant(p,binding)).toThrow("EEXIST");chmodSync(root,0o755);expect(()=>consumeGrant({...p,grantNonce:"2".repeat(64),consumedMarkerPath:join(root,`${"2".repeat(64)}.json`)},binding)).toThrow("Protected coordinator");}finally{rmSync(root,{recursive:true,force:true});}
});

test("known auto tier and US-only modifier fit the conservative upper without pinning the body",()=>{
 const p=policy(),spend=new PaidSpend(p,binding),body={model:p.canonicalModel,max_tokens:100,service_tier:"auto",inference_geo:"us"};const reserved=spend.reserve(1000,body);expect(reserved).toBe(8.002);expect(body).toEqual({model:"claude-sonnet-5-5",max_tokens:100,service_tier:"auto",inference_geo:"us"});expect(spend.complete(reserved,{input_tokens:10,output_tokens:7,cache_read_input_tokens:0,cache_creation_input_tokens:0})).toBeCloseTo(.00022,10);
});


test("short wire reserves the full approved context before any physical dispatch",()=>{
 const p=policy(),body={model:p.canonicalModel,max_tokens:128000},spend=new PaidSpend(p,binding);
 const held=spend.reserve(2,body);expect(held).toBe(10.56);
 expect(spend.complete(held,{input_tokens:900000,output_tokens:100,cache_read_input_tokens:100000,cache_creation_input_tokens:0})).toBe(8.002);
 const insufficient=new PaidSpend({...p,remainingUpperUsd:8},binding);
 expect(()=>insufficient.reserve(2,{...body,max_tokens:1})).toThrow("remaining root allowance");
 expect(insufficient.physicalRequests).toBe(0);
});
