import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { AUTHORIZATION_URL, assertPaidPolicy, PaidSpend, type PaidBinding, type PaidPolicy } from "../scripts/evals/smart-capture/paid-policy";
import { captureWire } from "../scripts/evals/smart-capture/wire";
import { startRelay, MODEL } from "../scripts/evals/smart-capture/relay";
const frames = (cache: boolean | "readMissing" | "writeMissing" = true) => [
  { type: "message_start", message: { model: MODEL, usage: { input_tokens: 10, output_tokens: 0, ...(cache !== false && cache !== "readMissing" ? { cache_read_input_tokens: 0 } : {}), ...(cache !== false && cache !== "writeMissing" ? { cache_creation_input_tokens: 0 } : {}) } } },
  { type: "content_block_delta", delta: { type: "text_delta", text: "Odysseus keeps the raft." } },
  { type: "message_delta", usage: { output_tokens: 7 } }, { type: "message_stop" },
].map(e => `data: ${JSON.stringify(e)}\n\n`).join("");
const body = JSON.stringify({ model: MODEL, max_tokens: 50, messages: [{ role: "user", content: "Odysseus keeps the raft." }] });
const send = (url: string) => fetch(`${url}/v1/messages`, { method: "POST", headers: { authorization: "Bearer offline-token", "content-type": "application/json", "anthropic-version": "2023-06-01" }, body });

for (const cache of [false, "readMissing", "writeMissing"] as const) test(`missing initial native cache counters remain unknown and refuse another physical dispatch: ${cache}`, async () => {
  let physical = 0; const relay = startRelay({ oauthToken: "offline-token", save: () => {}, async fetch() { physical++; return new Response(frames(cache)); } });
  try {
    await send(relay.url).then(r => r.text()).catch(() => {});
    expect(relay.calls[0]!.apiEquivalent).toBeNull();
    expect(relay.complete()).toBe(false); expect((await send(relay.url)).status).toBe(409); expect(physical).toBe(1);
  } finally { await relay.stop(); }
});
test("literal successful request and response bytes persist without credential headers", async () => {
  const raw = frames(); const relay = startRelay({ oauthToken: "offline-token", save: () => {}, async fetch() { return new Response(raw, { headers: { "content-type": "text/event-stream", "request-id": "fictional-request", "set-cookie": "must-not-save" } }); } });
  try {
    expect(await (await send(relay.url)).text()).toBe(raw); const call: any = relay.calls[0];
    expect(Buffer.from(call.rawRequestBase64 ?? "", "base64").toString()).toBe(body);
    expect(Buffer.from(call.rawResponseBase64 ?? "", "base64").toString()).toBe(raw);
    expect(call.requestHeaders).toEqual({ "anthropic-version": "2023-06-01", "content-type": "application/json" });
    expect(call.responseHeaders).toEqual({ "content-type": "text/event-stream", "request-id": "fictional-request" });
    expect(JSON.stringify(call)).not.toContain("offline-token"); expect(JSON.stringify(call)).not.toContain("must-not-save");
    expect(call.responseEof).toBe(true); expect(call.responseClosed).toBe(true); expect(call.actualInvoiceUsd).toBeNull();
  } finally { await relay.stop(); }
});
test("binary non-2xx bytes reach EOF and remain failed raw evidence", async () => {
  const bytes = Uint8Array.from([0, 255, 128, 13, 10]); const relay = startRelay({ oauthToken: "offline-token", save: () => {}, async fetch() { return new Response(bytes, { status: 403 }); } });
  try {
    expect(new Uint8Array(await (await send(relay.url)).arrayBuffer())).toEqual(bytes); const call: any = relay.calls[0];
    expect(Buffer.from(call.rawResponseBase64 ?? "", "base64")).toEqual(Buffer.from(bytes));
    expect(call.responseEof).toBe(true); expect(call.responseClosed).toBe(true); expect(call.apiEquivalent).toBeNull(); expect((await send(relay.url)).status).toBe(409);
  } finally { await relay.stop(); }
});
test("owned relay shutdown awaits an actual asynchronous upstream cancellation", async () => {
  let cancelled = false; const relay = startRelay({ oauthToken: "offline-token", save: () => {}, async fetch() { return new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode('data: {"type":"message_start","message":{"model":"claude-sonnet-5-5","usage":{"input_tokens":10,"output_tokens":0}}}\n\n')); }, async cancel() { await new Promise(r => setTimeout(r, 30)); cancelled = true; } })); } });
  const controller = new AbortController(); let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;
  try {
    const response = await fetch(`${relay.url}/v1/messages`, { method: "POST", headers: { authorization: "Bearer offline-token" }, body, signal: controller.signal }); reader = response.body!.getReader(); await reader.read();
    await relay.stop(); expect(cancelled).toBe(true); const call: any = relay.calls[0]; expect(call.responseClosed).toBe(true); expect(call.responseCancelled).toBe(true); expect(call.responseEof).toBe(false);
  } finally { controller.abort(); await reader?.cancel().catch(() => {}); await relay.stop(); }
});


test("literal physical forwarding refuses altered prompt, scope and every current binding", async () => {
  const sha=(v:string)=>createHash("sha256").update(v).digest("hex"), prompt="Odysseus keeps the raft.";
  const expected:PaidBinding={fixtureSha:"a".repeat(64),protocolSha:"b".repeat(64),sourceFreezeSha:"c".repeat(64),runtimeSha:"d".repeat(64),promptSha:sha(prompt),proofSha:"e".repeat(64)};
  const good={model:MODEL,max_tokens:50,tools:[],output_config:{effort:"low"},messages:[{role:"user",content:prompt}]};
  for(const change of ["prompt","tools","effort","purpose","issuedAt",...Object.keys(expected)]){
    const policy:PaidPolicy={...expected,purpose:"review",grantNonce:"1".repeat(64),consumedMarkerPath:`/tmp/offline-policy-test/${"1".repeat(64)}.json`,version:1,issue:839,authorizationUrl:AUTHORIZATION_URL,allowOverage:true,basis:"actual additional billed charges",perIssueCapUsd:15,aggregateCapUsd:150,remainingUpperUsd:15,issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),canonicalModel:MODEL,maxPhysicalRequests:24,maxInputBytes:3000000,maxInputTokens:1000000,contextWindowTokens:1000000,maxOutputTokens:128000,inputUsdPerMillionUpper:8,outputUsdPerMillionUpper:20,invoiceUsd:null};
    const payload=structuredClone(good); if(change==="prompt")payload.messages[0]!.content="different fictional prompt";if(change==="tools")(payload.tools as any[]).push({name:"Write"});if(change==="effort")payload.output_config.effort="high";
    const current={...expected,...(Object.keys(expected).includes(change)?{[change]:"f".repeat(64)}:{})};let forwarded=0;
    const paid=new PaidSpend(policy,expected);if(change==="purpose")policy.purpose="current";if(change==="issuedAt")policy.issuedAt=new Date(Date.now()+10000).toISOString();
    const relay=startRelay({oauthToken:"offline-token",paid,sessionNonce:"7".repeat(64),scope:"review",verifyAdmission:()=>{assertPaidPolicy(policy,current);},save:()=>{},async fetch(){forwarded++;return new Response(frames());}});
    try {expect((await fetch(`${relay.url}/v1/messages`,{method:"POST",headers:{authorization:"Bearer offline-token"},body:JSON.stringify(payload)})).status).toBe(409);expect(forwarded).toBe(0);expect(relay.calls[0]!.outcome).toBe("admission_refused");expect(relay.calls[0]!.forwarded).toBe(false);expect(relay.calls[0]!.actualInvoiceUsd).toBeNull();}finally{await relay.stop();}
  }
});
test("malformed successful physical response drains complete binary bytes and cannot admit another request",async()=>{
  const bytes=Uint8Array.from([100,97,116,97,58,32,255,0,10,10]),relay=startRelay({oauthToken:"offline-token",save:()=>{},async fetch(){return new Response(bytes);}});
  try{await send(relay.url).then(r=>r.text()).catch(()=>{});expect(Buffer.from(relay.calls[0]!.rawResponseBase64,"base64")).toEqual(Buffer.from(bytes));expect(relay.calls[0]!.responseEof).toBe(true);expect(relay.complete()).toBe(false);expect((await send(relay.url)).status).toBe(409);}finally{await relay.stop();}
});
test("literal response deadline preserves a partial prefix and awaits actual cancellation",async()=>{
  let cancelled=false;const state:any={responseEof:false,responseClosed:false,responseCancelled:false};const partial=Uint8Array.from([0,255,13]);let saves=0;
  const response=new Response(new ReadableStream({start(c){c.enqueue(partial);},async cancel(){await new Promise(r=>setTimeout(r,30));cancelled=true;}}));
  await expect(captureWire(response,state,()=>saves++,undefined,20)).rejects.toThrow("deadline");
  expect(Buffer.from(state.rawResponseBase64,"base64")).toEqual(Buffer.from(partial));expect(state.responseEof).toBe(false);expect(cancelled).toBe(true);expect(state.responseClosed).toBe(true);expect(state.responseCancelled).toBe(true);expect(saves).toBeGreaterThan(1);
});

test("paid relay session nonce is required and another local path cannot reach the provider",async()=>{
 const expected:PaidBinding={fixtureSha:"a".repeat(64),protocolSha:"b".repeat(64),sourceFreezeSha:"c".repeat(64),runtimeSha:"d".repeat(64),promptSha:createHash("sha256").update("Odysseus").digest("hex"),proofSha:"e".repeat(64)};
 const policy:PaidPolicy={...expected,purpose:"review",grantNonce:"1".repeat(64),consumedMarkerPath:`/tmp/offline-policy-test/${"1".repeat(64)}.json`,version:1,issue:839,authorizationUrl:AUTHORIZATION_URL,allowOverage:true,basis:"actual additional billed charges",perIssueCapUsd:15,aggregateCapUsd:150,remainingUpperUsd:15,issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),canonicalModel:MODEL,maxPhysicalRequests:24,maxInputBytes:3000000,maxInputTokens:1000000,contextWindowTokens:1000000,maxOutputTokens:128000,inputUsdPerMillionUpper:8,outputUsdPerMillionUpper:20,invoiceUsd:null};
 let forwarded=0;const options={oauthToken:"offline-token",paid:new PaidSpend(policy,expected),scope:"review" as const,verifyAdmission:()=>{},save:()=>{},async fetch(){forwarded++;return new Response(frames());}};
 expect(()=>startRelay(options)).toThrow("Protected per-session");const relay=startRelay({...options,sessionNonce:"7".repeat(64)});
 try{const bad=relay.url.replace("7".repeat(64),"8".repeat(64));expect((await send(bad)).status).toBe(403);expect(forwarded).toBe(0);expect(relay.calls).toHaveLength(0);}finally{await relay.stop();}
});


test("short wire cannot reach the physical transport without full-context financial allowance",async()=>{
 const prompt="Odysseus",expected:PaidBinding={fixtureSha:"a".repeat(64),protocolSha:"b".repeat(64),sourceFreezeSha:"c".repeat(64),runtimeSha:"d".repeat(64),promptSha:createHash("sha256").update(prompt).digest("hex"),proofSha:"e".repeat(64)};
 const policy:PaidPolicy={...expected,purpose:"review",grantNonce:"1".repeat(64),consumedMarkerPath:`/tmp/offline-policy-test/${"1".repeat(64)}.json`,version:1,issue:839,authorizationUrl:AUTHORIZATION_URL,allowOverage:true,basis:"actual additional billed charges",perIssueCapUsd:15,aggregateCapUsd:150,remainingUpperUsd:8,issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString(),canonicalModel:MODEL,maxPhysicalRequests:24,maxInputBytes:3000000,maxInputTokens:1000000,contextWindowTokens:1000000,maxOutputTokens:128000,inputUsdPerMillionUpper:8,outputUsdPerMillionUpper:20,invoiceUsd:null};
 const payload=JSON.stringify({model:MODEL,max_tokens:1000,tools:[],output_config:{effort:"low"},messages:[{role:"user",content:prompt}]});expect(Buffer.byteLength(payload)).toBeLessThan(1000);
 let forwarded=0;const spend=new PaidSpend(policy,expected),relay=startRelay({oauthToken:"offline-token",paid:spend,sessionNonce:"7".repeat(64),scope:"review",verifyAdmission:()=>assertPaidPolicy(policy,expected),save:()=>{},async fetch(){forwarded++;return new Response(frames());}});
 try{expect((await fetch(`${relay.url}/v1/messages`,{method:"POST",headers:{authorization:"Bearer offline-token"},body:payload})).status).toBe(409);expect(forwarded).toBe(0);expect(spend.physicalRequests).toBe(0);expect(relay.calls[0]!.forwarded).toBe(false);}finally{await relay.stop();}
});
