import { test, expect } from "bun:test";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { CORPUS } from "../evals/triage/experiment/corpus";
import { collectLabelPanel, labelRequests, type PanelPhysical } from "../evals/triage/experiment/label-panel";
const ANTHROPIC_KEY="offline-Synthetic-Anthropic-KEY";
const rubric = readFileSync(resolve(import.meta.dir, "../evals/triage/prompt.txt"), "utf8");
const fixtures = new Map(CORPUS.map(i => [i.id, i]));
const native = (provider: string, rows: any[]) => {
 const text = JSON.stringify(rows);
 if (provider === "anthropic") return {model:"claude-sonnet-5-5",stop_reason:"end_turn",content:[{type:"text",text}],
  usage:{input_tokens:31,output_tokens:23,cache_read_input_tokens:7,cache_creation_input_tokens:11}};
 if (provider === "openai") return {model:"gpt-6.1-sol",service_tier:"default",choices:[{finish_reason:"stop",message:{content:text,refusal:null}}],
  usage:{prompt_tokens:31,completion_tokens:23,total_tokens:54,prompt_tokens_details:{cached_tokens:7,cache_write_tokens:11},completion_tokens_details:{reasoning_tokens:13}}};
 return {modelVersion:"gemini-3.8-flash",responseId:"offline-response",candidates:[{finishReason:"STOP",content:{parts:[{text}]}}],
  usageMetadata:{promptTokenCount:31,candidatesTokenCount:23,thoughtsTokenCount:13,cachedContentTokenCount:7,totalTokenCount:67,serviceTier:"STANDARD"}};
};
type Alter = (json: any, provider: string, number: number, rows: any[]) => Response | void;
function transport(alter?: Alter,checkProjection=true) {
 let number = 0;
 return (async (url: any, init: any) => {
  number++;
  const body = JSON.parse(init.body), endpoint = String(url);
  const provider = endpoint.includes("anthropic") ? "anthropic" : endpoint.includes("openai") ? "openai" : "gemini";
  const text = provider === "anthropic" ? body.messages[0].content : provider === "openai" ? body.messages[1].content : body.contents[0].parts[0].text;
  const system = provider === "anthropic" ? body.system[0].text : provider === "openai" ? body.messages[0].content : body.systemInstruction.parts[0].text;
  expect(system).toBe(rubric);expect(text).toBe(labelRequests(CORPUS).find(s=>s===text));
  const blind = JSON.parse(text);
  expect(blind).toHaveLength(4);
  for(const item of blind) {if(checkProjection)expect(Object.keys(item)).toEqual(["id","source","title","body"]);expect(item.body.length).toBeGreaterThan(0);}
  if(provider === "gemini") {expect(endpoint).not.toContain("key=");expect(new Headers(init.headers).get("x-goog-api-key")).toBe("offline-synthetic-gemini-key");expect(body.generationConfig.thinkingConfig.thinkingLevel).toBe("high");}
  if(provider === "openai") {expect(body.reasoning_effort).toBe("high");expect(body.max_completion_tokens).toBe(8000);expect(body.tools).toBeUndefined();}
  if(provider === "anthropic") {expect(body.output_config.effort).toBe("high");expect(body.max_tokens).toBe(8000);}
  const rows = blind.map((i:any)=>({id:i.id,route:fixtures.get(i.id)!.gold.route,stakes:1,summary:"Authored offline mechanical label"}));
  const json = native(provider,rows), changed = alter?.(json,provider,number,rows);
  return changed ?? new Response(JSON.stringify(json),{headers:{"content-type":"application/json","x-request-id":"offline-id"}});
 }) as typeof fetch;
}

if(process.env.BRAIN_TRIAGE_PANEL_SYNTHETIC !== "1") {
 test("real donor raw routes and panel controls run with synthetic-only child credentials",async()=>{
  const home = mkdtempSync(join(tmpdir(),"848-panel-test-"));
  try {
   const child = Bun.spawn([process.execPath,"test","--timeout","30000",import.meta.filename],{
    cwd:resolve(import.meta.dir,"../../.."),env:{PATH:process.env.PATH!,HOME:home,BRAIN_TRIAGE_PANEL_SYNTHETIC:"1",
     ANTHROPIC_API_KEY:ANTHROPIC_KEY,OPENAI_API_KEY:"offline-synthetic-openai-key",GEMINI_API_KEY:"offline-synthetic-gemini-key"},stdout:"pipe",stderr:"pipe"});
   const [exit,stdout,stderr] = await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
   expect({exit,stdout,stderr}).toMatchObject({exit:0});expect(stderr).toContain("0 fail");
  }finally{rmSync(home,{recursive:true,force:true});}
 },30000);
} else {
 test("literal captured donor request contains independently specified blind fields only",async()=>{
  const result=await collectLabelPanel(CORPUS,rubric,transport(undefined,false));
  expect(result.coverageComplete).toBe(true);
  const actual=JSON.parse(JSON.parse(result.physical[0]!.requestBody!).messages[0].content);
  expect(actual).toEqual(CORPUS.slice(0,4).map(({id,source,title,body})=>({id,source,title,body})));
  expect(actual[0].body.length).toBeGreaterThan(0);
 });
 test("all forty blind inputs receive three repetitions from three exact families through unchanged donor routes",async()=>{
  const before = globalThis.fetch, retained:PanelPhysical[]=[];
  const result = await collectLabelPanel(CORPUS,rubric,transport(),{onPhysical:r=>retained.push(r)});
  expect(globalThis.fetch).toBe(before);expect(result.stopReason).toBeNull();expect(result.coverageComplete).toBe(true);expect(result.endorsed).toBe(true);
  expect(result.physical).toHaveLength(90);expect(result.judgments).toHaveLength(90);expect(result.itemJudgments).toBe(360);expect(result.verdicts).toHaveLength(40);
  expect(new Set(result.physical.map(r=>r.judge)).size).toBe(3);expect(retained).toHaveLength(90);
  const openai=result.physical.find(r=>r.judge==="gpt-6.1-sol")!,gemini=result.physical.find(r=>r.judge==="gemini-3.8-flash")!;
  expect(openai.tokens).toEqual({input:31,output:23,thinking:13,cacheRead:7,cacheWrite:11});
  expect(gemini.tokens).toEqual({input:31,output:36,thinking:13,cacheRead:7,cacheWrite:null});
  expect(gemini.rawUsage).toMatchObject({serviceTier:"STANDARD",totalTokenCount:67});
  for(const r of result.physical){expect(r.responseComplete).toBe(true);expect(r.usageComplete).toBe(true);expect(r.responseBase64!.length).toBeGreaterThan(0);
   expect(r.requestBody!.length).toBeGreaterThan(0);expect(r.listPriceUsd).toBeNull();expect(r.invoiceUsd).toBeNull();expect(JSON.stringify(r)).not.toContain("offline-synthetic");}
 });
 test("unanimous alternative labels are retained without relabelling or auto-excluding gold",async()=>{
  const gold = JSON.stringify(CORPUS.map(i=>i.gold));
  const result=await collectLabelPanel(CORPUS,rubric,transport((j,p,n,rows)=>{rows[0].route=rows[0].route==="drop"?"rule":"drop";Object.assign(j,native(p,rows));}));
  expect(result.coverageComplete).toBe(true);expect(result.endorsed).toBe(false);expect(result.verdicts.some(v=>v.text.startsWith("RELABEL"))).toBe(true);
  expect(JSON.stringify(CORPUS.map(i=>i.gold))).toBe(gold);
 });
 test("one family disagreement cannot be endorsed despite two agreeing families",async()=>{
  const result=await collectLabelPanel(CORPUS,rubric,transport((j,p,n,rows)=>{if(p==="gemini"){rows[0].route=rows[0].route==="drop"?"rule":"drop";Object.assign(j,native(p,rows));}}));
  expect(result.coverageComplete).toBe(true);expect(result.endorsed).toBe(false);expect(result.verdicts.some(v=>v.text==="CONTESTED")).toBe(true);
 });
 test("tied three-repetition modals remain visible and cannot endorse arbitrary donor first-vote choice",async()=>{
  const routes=["drop","rule","needs_agent","needs_user"];
  const result=await collectLabelPanel(CORPUS,rubric,transport((j,p,n,rows)=>{
   const repetition=Math.floor(((n-1)%30)/10);
   for(const row of rows){const alternatives=routes.filter(r=>r!==row.route);if(repetition)row.route=alternatives[repetition-1];}
   Object.assign(j,native(p,rows));
  }));
  expect(result.coverageComplete).toBe(true);expect(result.verdicts[0]!.endorsed).toBe(true);
  expect(result.verdicts[0]!.tied).toHaveLength(3);expect(result.endorsed).toBe(false);
 });
 test("mixed repetition votes preserve instability while the donor majority still endorses",async()=>{
  const result=await collectLabelPanel(CORPUS,rubric,transport((j,p,n,rows)=>{
   if(Math.floor(((n-1)%30)/10)===2){rows[0].route=rows[0].route==="drop"?"rule":"drop";Object.assign(j,native(p,rows));}
  }));
  expect(result.coverageComplete).toBe(true);expect(result.endorsed).toBe(true);
  expect(result.verdicts[0]!.unstable).toHaveLength(3);expect(result.verdicts[0]!.tied).toHaveLength(0);
 });
 const invalidRows:Record<string,(rows:any[])=>void>={
  "missing row":(rows:any[])=>rows.pop(),"duplicate row":(rows:any[])=>rows[1]={...rows[0]},
  "extra row":(rows:any[])=>rows.push({...rows[0],id:"unexpected"}),"wrong route":(rows:any[])=>rows[0].route="approve",
  "wrong order":(rows:any[])=>rows.reverse(),"invalid stakes":(rows:any[])=>rows[0].stakes=0,
  "oversized summary":(rows:any[])=>rows[0].summary="x".repeat(141),
 };
 for(const [name,alter] of Object.entries(invalidRows)) test(`${name} stops actual panel with retained successful usage`,async()=>{
  const result=await collectLabelPanel(CORPUS,rubric,transport((j,p,n,rows)=>{alter(rows);Object.assign(j,native(p,rows));}));
  expect(result.stopReason).toBe("invalid blind label batch");expect(result.physical).toHaveLength(1);expect(result.coverageComplete).toBe(false);
  expect(result.physical[0]!.tokens.output).toBe(23);expect(result.physical[0]!.responseComplete).toBe(true);
 });
 test("missing raw usage stops instead of accepting donor zero defaults",async()=>{
  const result=await collectLabelPanel(CORPUS,rubric,transport(j=>{delete j.usage.output_tokens;}));
  expect(result.physical[0]!.tokens.output).toBeNull();expect(result.physical[0]!.usageComplete).toBe(false);expect(result.physical).toHaveLength(1);expect(result.coverageComplete).toBe(false);
 });
 test("Anthropic cache counters larger than fresh input stay valid and separate",async()=>{
  const result=await collectLabelPanel(CORPUS,rubric,transport((j,p)=>{if(p==="anthropic"){j.usage.cache_read_input_tokens=100;j.usage.cache_creation_input_tokens=200;}}));
  expect(result.coverageComplete).toBe(true);expect(result.physical[0]!.tokens).toMatchObject({input:31,cacheRead:100,cacheWrite:200});
 });
 test("explicit unsafe optional native usage is not silently converted into acceptable unknown",async()=>{
  const result=await collectLabelPanel(CORPUS,rubric,transport(j=>{j.usage.cache_read_input_tokens=-1;}));
  expect(result.coverageComplete).toBe(false);expect(result.physical).toHaveLength(1);expect(result.physical[0]!.usageComplete).toBe(false);
 });
 test("echoed credential response bytes are withheld rather than persisted",async()=>{
  const result=await collectLabelPanel(CORPUS,rubric,transport(j=>{j.error={message:ANTHROPIC_KEY};}));
  expect(result.physical[0]!.responseBase64).toBeNull();expect(result.physical[0]!.responseSha).not.toBeNull();expect(JSON.stringify(result)).not.toContain("offline-synthetic");
 });
 test("secret-bearing response header names and values are both omitted",async()=>{
  const result=await collectLabelPanel(CORPUS,rubric,transport(j=>new Response(JSON.stringify(j),{headers:{
   [`x-goog-${ANTHROPIC_KEY}`]:"ordinary", "x-ratelimit-fixture":ANTHROPIC_KEY,"x-request-id":"safe-request"}})));
  expect(result.physical[0]!.headers).toEqual({"x-request-id":"safe-request"});expect(JSON.stringify(result)).not.toContain("offline-synthetic");
 });
 test("sensitive rejected request has only its hash and no persisted secret body",async()=>{
  const items=CORPUS.map((i,n)=>n===0?{...i,body:i.body+" "+ANTHROPIC_KEY}:i);
  let dispatched=0;const result=await collectLabelPanel(items,rubric,(async()=>{dispatched++;throw Error("unexpected");}) as unknown as typeof fetch);
  expect(dispatched).toBe(0);expect(result.physical[0]!.requestBody).toBeNull();expect(result.physical[0]!.requestSha).not.toBeNull();expect(JSON.stringify(result)).not.toContain("offline-synthetic");
 });
 test("unexpected served model stops before any subsequent physical",async()=>{
  const result=await collectLabelPanel(CORPUS,rubric,transport(j=>{j.model="claude-sonnet-5";}));
  expect(result.stopReason).toBe("unknown or mismatched required physical receipt");expect(result.physical).toHaveLength(1);
 });
 for(const provider of ["anthropic","openai"]) test(`${provider} wrong requested model in actual donor lowest-fetch call is blocked before upstream forwarding`,async()=>{
  const descriptor=Object.getOwnPropertyDescriptor(globalThis,"fetch")!, before=globalThis.fetch;
  let current=before,forwarded=0;
  Object.defineProperty(globalThis,"fetch",{configurable:true,get:()=>current,set:(observer:typeof fetch)=>{
   current=(async(input:any,init:any)=>{const body=JSON.parse(init.body);if(String(input).includes(provider))body.model="wrong-requested-model";
    return observer(input,{...init,body:JSON.stringify(body)});}) as typeof fetch;
  }});
  try {
   const fake=transport(),result=await collectLabelPanel(CORPUS,rubric,(async(url:any,init:any)=>{
    if(JSON.parse(init.body).model==="wrong-requested-model")forwarded++;return fake(url,init);}) as typeof fetch);
   expect(forwarded).toBe(0);expect(result.physical).toHaveLength(provider==="anthropic"?1:31);expect(result.endorsed).toBe(false);
   expect(result.physical.at(-1)!.error).toBe("unexpected requested model");
   expect(result.physical.at(-1)!.transportDispatched).toBe(false);expect(result.transportDispatches).toBe(provider==="anthropic"?0:30);
   expect(JSON.parse(result.physical.at(-1)!.requestBody!).model).toBe("wrong-requested-model");
  }finally{Object.defineProperty(globalThis,"fetch",descriptor);}
  expect(globalThis.fetch).toBe(before);
 });
 for(const provider of ["openai","gemini"]) test(`${provider} wrong served model stops at its first actual route`,async()=>{
  const result=await collectLabelPanel(CORPUS,rubric,transport((j,p)=>{if(p===provider){if(p==="openai")j.model="other";else j.modelVersion="other";}}));
  expect(result.stopReason).toBe("unknown or mismatched required physical receipt");expect(result.physical).toHaveLength(provider==="openai"?31:61);
 });
 test("missing Gemini thought count cannot become zero output reasoning",async()=>{
  const result=await collectLabelPanel(CORPUS,rubric,transport((j,p)=>{if(p==="gemini")delete j.usageMetadata.thoughtsTokenCount;}));
  expect(result.physical).toHaveLength(61);expect(result.physical.at(-1)!.tokens.output).toBeNull();expect(result.coverageComplete).toBe(false);
 });
 test("visible Gemini thought parts cannot contaminate donor label text",async()=>{
  const result=await collectLabelPanel(CORPUS,rubric,transport((j,p)=>{if(p==="gemini")j.candidates[0].content.parts.unshift({thought:true,text:"private thinking"});}));
  expect(result.physical).toHaveLength(61);expect(result.physical.at(-1)!.terminal).toBe(false);expect(result.coverageComplete).toBe(false);
 });
 test("truncated but parseable labels cannot pass the terminal guard",async()=>{
  const result=await collectLabelPanel(CORPUS,rubric,transport(j=>{j.stop_reason="max_tokens";}));
  expect(result.stopReason).toBe("failed or nonterminal judge call");expect(result.physical).toHaveLength(1);expect(result.coverageComplete).toBe(false);
 });
 test("known transient failed physical and bounded retry both remain literal receipts",async()=>{
  const result=await collectLabelPanel(CORPUS,rubric,transport((j,p,n)=>{if(n===1){j.error={message:"temporary overload"};return new Response(JSON.stringify(j),{status:503});}}),{retryDelay:async()=>{}});
  expect(result.coverageComplete).toBe(true);expect(result.physical).toHaveLength(91);expect(result.physical.slice(0,2).map(r=>r.attempt)).toEqual([1,2]);
  expect(result.physical[0]!.status).toBe(503);expect(result.physical[0]!.tokens.output).toBe(23);expect(result.physical[0]!.responseBase64).not.toBeNull();
 });
 test("unknown rate-limit usage is retained and stops without retry",async()=>{
  const result=await collectLabelPanel(CORPUS,rubric,transport(()=>new Response(JSON.stringify({error:{message:"limited"}}),{status:429})),{retryDelay:async()=>{}});
  expect(result.physical).toHaveLength(1);expect(result.physical[0]!.status).toBe(429);expect(result.physical[0]!.tokens.output).toBeNull();expect(result.coverageComplete).toBe(false);
 });
 test("binary error bytes are retained exactly and fetch restored",async()=>{
  const before=globalThis.fetch,bytes=new Uint8Array([255,0,128,17]);
  const result=await collectLabelPanel(CORPUS,rubric,transport(()=>new Response(bytes,{status:500})));
  expect(Buffer.from(result.physical[0]!.responseBase64!,"base64")).toEqual(Buffer.from(bytes));expect(result.physical[0]!.responseComplete).toBe(true);expect(globalThis.fetch).toBe(before);
 });
 test("partial failed body stays incomplete with actual prefix bytes",async()=>{
  const result=await collectLabelPanel(CORPUS,rubric,transport(()=>new Response(new ReadableStream({start(c){c.enqueue(new TextEncoder().encode("{partial"));},pull(c){c.error(Error("fixture closed"));}}))));
  expect(result.physical).toHaveLength(1);expect(result.physical[0]!.responseComplete).toBe(false);expect(Buffer.from(result.physical[0]!.responseBase64!,"base64").toString()).toBe("{partial");
  expect(result.physical[0]!.readerCleanup).toBe("cancel-failed");
 });
 test("callback failure still restores owned global fetch",async()=>{
  const before=globalThis.fetch;await expect(collectLabelPanel(CORPUS,rubric,transport(),{onPhysical:()=>{throw Error("receipt sink failed");}})).rejects.toThrow("receipt sink failed");expect(globalThis.fetch).toBe(before);
 });
 test("missing input and concurrent observer ownership refuse dispatch",async()=>{
  await expect(collectLabelPanel(CORPUS.slice(0,39),rubric,transport())).rejects.toThrow("forty");
  let release!:()=>void;const gate=new Promise<void>(r=>release=r);let entered!:()=>void;const ready=new Promise<void>(r=>entered=r);
  const fake=transport();
  const first=collectLabelPanel(CORPUS,rubric,(async(url:any,init:any)=>{entered();await gate;return fake(url,init);}) as typeof fetch);
  await ready;await expect(collectLabelPanel(CORPUS,rubric,transport())).rejects.toThrow("already owned");release();await first;
 });
}
