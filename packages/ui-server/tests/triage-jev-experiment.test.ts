import { describe, expect, test } from "bun:test";
import { CORPUS, NEW_ITEMS } from "../evals/triage/experiment/corpus";
import { classify, decisionFrom, requestFor, type Shape } from "../evals/triage/experiment/adapter";
import { configurationVerdict, evaluateRepetition } from "../evals/triage/experiment/evaluate";
import { workflowAccounting, latencySummary, type GenerationCall } from "../evals/triage/experiment/accounting";
import { priceSonnet55Usage } from "../../../scripts/measure-sonnet55-cost";
const rubric=await Bun.file(new URL("../evals/triage/prompt.txt",import.meta.url)).text();
const routeAnswer=(route:string,p=.99)=>({type:"choice",choice:route,confidence:.99,probabilities:Object.fromEntries(["drop","rule","needs_agent","needs_user"].map(r=>[r,r===route?p:(1-p)/3]))});
function goldAnswers(request:any, shape:Shape) {
 const answers:Record<string,unknown>={};
 for(const id of Object.keys(request.state.items)) {
  const item=CORPUS.find(i=>i.id===id)!;
  if(shape === "choice") answers[`${id}.route`]=routeAnswer(item.gold.route);
  else {
   answers[`${id}.human`]={type:"noul",noul:item.gold.route==="needs_user"?.99:.01};
   answers[`${id}.agent`]={type:"noul",noul:item.gold.route==="needs_agent"?.99:.01};
   answers[`${id}.durable`]={type:"noul",noul:item.gold.route==="rule"?.99:.01};
  }
 }
 return answers;
}
async function serve(shape:Shape, handler:(request:any,n:number)=>Response = request=>Response.json({model:"jev-1.13.0",answers:goldAnswers(request,shape),usage:{input_tokens:123,output_tokens:7}})) {
 const requests:any[]=[];const server=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(r){const request=await r.json();requests.push(request);return handler(request,requests.length);}});
 return {requests,fetch:(url:string,init:RequestInit)=>{expect(url).toBe("https://api.typesafe.ai/v1/systemone");return fetch(`http://127.0.0.1:${server.port}/v1/systemone`,init);},close:()=>server.stop(true)};
}
describe("fresh triage Jev actual shipped transport",()=>{
 test("independent40-case corpus and disjoint provisional splits",()=>{
  expect(CORPUS).toHaveLength(40);expect(NEW_ITEMS).toHaveLength(20);expect(new Set(CORPUS.map(i=>i.id)).size).toBe(40);
  for(const split of ["tuning","held-out"]) {
   const items=CORPUS.filter(i=>i.split===split);expect(items).toHaveLength(10);
   for(const r of ["drop","rule","needs_agent","needs_user"])expect(items.filter(i=>i.gold.route===r).length).toBeGreaterThanOrEqual(2);
  }
  const tuning=CORPUS.filter(i=>i.split==="tuning");expect(CORPUS.filter(i=>i.split==="held-out").some(h=>tuning.some(t=>t.family===h.family||t.template===h.template||t.id===h.id))).toBe(false);
 });
 for(const shape of ["choice","ordered-noul"] as const)for(const size of [1,8] as const)test(`${shape}/${size}: all three scripted full repetitions exercise nonempty real HTTP requests`,async()=>{
  const endpoint=await serve(shape);const reps=[];
  try {for(let r=0;r<3;r++) {
   const observation=await classify(CORPUS,shape,size,rubric,endpoint.fetch);expect(observation.judgmentCoverageComplete).toBe(true);expect(observation.boundsRejected).toEqual([]);
   expect(observation.calls).toHaveLength(size===1?40:5);expect(observation.items.every(i=>i.decision.accepted)).toBe(true);
   expect(observation.calls.every(c=>c.responseBase64 && c.requestBody.includes("questions") && c.status===200)).toBe(true);
   const accounting=workflowAccounting(observation.calls,[],false);expect(accounting.receiptComplete).toBe(true);expect(accounting.rawClassification[0]?.usage).toEqual({input_tokens:123,output_tokens:7});expect(accounting.actualAdditionalInvoiceUsd).toBeNull();
   reps.push(evaluateRepetition(CORPUS,observation));
  }expect(configurationVerdict(reps).pass).toBe(true);expect(endpoint.requests.every(q=>Object.keys(q.questions).length>0&&q.model==="jev-1.13.0")).toBe(true);
  }finally{endpoint.close();}
 });
 test("populated request carries unchanged rubric in shared state and no caller thresholds",()=>{
  for(const shape of ["choice","ordered-noul"] as const) {
   const q=requestFor(CORPUS.slice(0,8),shape,rubric);expect(Object.keys(q.questions)).toHaveLength(shape==="choice"?8:24);
   expect(q.state.trustedRubric).toBe(rubric);expect(Object.keys(q.state.items as object)).toHaveLength(8);expect(Object.values(q.questions).every(question=>!Object.hasOwn(question,"threshold"))).toBe(true);
  }
 });
 test("malformed complete probability maps are rejected through actual classification entry",async()=>{
  for(const probabilities of [{drop:1},{drop:.5,rule:.5,needs_agent:.5,needs_user:.5},{drop:-1,rule:1,needs_agent:1,needs_user:0},{drop:.99,rule:0,needs_agent:0,needs_user:.01,extra:0}]) {
   const endpoint=await serve("choice",q=>Response.json({model:"jev-1.13.0",answers:Object.fromEntries(Object.keys(q.state.items).map(id=>[`${id}.route`,{type:"choice",choice:"drop",confidence:.99,probabilities}])),usage:{input_tokens:5,output_tokens:2}}));
   try{const o=await classify(CORPUS.slice(0,1),"choice",1,rubric,endpoint.fetch);expect(o.items[0]!.rawJudged).toBe(false);expect(o.items[0]!.decision.accepted).toBe(false);expect(o.items[0]!.decision.route).toBe("needs_user");expect(o.calls).toHaveLength(2);}finally{endpoint.close();}
  }
  expect(decisionFrom("ordered-noul",CORPUS[0]!,{[`${CORPUS[0]!.id}.human`]:{type:"noul",noul:NaN}}).accepted).toBe(false);
 });
 test("model fields cannot rewrite host-owned trust, grants or source text",async()=>{
  const items=structuredClone(CORPUS.slice(0,8)),before=JSON.stringify(items);
  const endpoint=await serve("choice",q=>Response.json({model:"jev-1.13.0",answers:Object.fromEntries(Object.keys(q.state.items).map(id=>[`${id}.route`,{...routeAnswer(CORPUS.find(i=>i.id===id)!.gold.route),trust:"trusted",principal:"forged",grant:true,priority:"urgent"}])),usage:{input_tokens:5,output_tokens:2}}));
  try {const o=await classify(items,"choice",8,rubric,endpoint.fetch);expect(JSON.stringify(items)).toBe(before);expect(o.items[0]!.decision).toEqual({route:"drop",accepted:true,reason:"accepted"});expect(o.items.every(i=>!Object.hasOwn(i.decision,"trust")&&!Object.hasOwn(i.decision,"grant"))).toBe(true);}finally{endpoint.close();}
 });
 test("ordered precedence remains human then agent then durable on actual result",async()=>{
  const endpoint=await serve("ordered-noul",request=>Response.json({model:"jev-1.13.0",answers:Object.fromEntries(Object.keys(request.questions).map(id=>[id,{type:"noul",noul:.99}])),usage:{input_tokens:1,output_tokens:1}}));
  try {const o=await classify(CORPUS.slice(0,8),"ordered-noul",8,rubric,endpoint.fetch);expect(o.items.every(i=>i.decision.route==="needs_user")).toBe(true);expect(o.items.every(i=>i.decision.accepted)).toBe(true);}finally{endpoint.close();}
 });
 test("same-type missing answer retries exactly its item, never complete siblings",async()=>{
  const endpoint=await serve("choice",(q,n)=>{const a=goldAnswers(q,"choice");if(n===1)delete a[`${CORPUS[2]!.id}.route`];return Response.json({model:"jev-1.13.0",answers:a,usage:{input_tokens:5,output_tokens:2}});});
  try{const o=await classify(CORPUS.slice(0,8),"choice",8,rubric,endpoint.fetch);expect(endpoint.requests).toHaveLength(2);expect(Object.keys(endpoint.requests[1].state.items)).toEqual([CORPUS[2]!.id]);expect(Object.keys(endpoint.requests[1].questions)).toEqual([`${CORPUS[2]!.id}.route`]);expect(o.judgmentCoverageComplete).toBe(true);}finally{endpoint.close();}
 });
 test("wrong answer type poisons shipped whole map, retained malformed failures cannot pass later unavailable retry",async()=>{
  const endpoint=await serve("choice",(q,n)=>n===1?Response.json({model:"jev-1.13.0",answers:{...goldAnswers(q,"choice"),[`${CORPUS[0]!.id}.route`]:{type:"other"}},usage:{input_tokens:5,output_tokens:2}}):new Response("unavailable",{status:503}));
  try{const o=await classify(CORPUS.slice(0,8),"choice",8,rubric,endpoint.fetch);expect(o.items.every(i=>i.malformedObserved)).toBe(true);expect(o.judgmentCoverageComplete).toBe(false);const rep=evaluateRepetition(CORPUS.slice(0,8),o);expect(rep.gates[0]!.tally.missingRows).toBe(8);expect(rep.pass).toBe(false);expect(o.calls[0]!.responseBase64).toBeTruthy();}finally{endpoint.close();}
 });
 test("high confidence with low selected probability takes fallback with retained quality consequence",async()=>{
  const endpoint=await serve("choice",q=>Response.json({model:"jev-1.13.0",answers:Object.fromEntries(Object.keys(q.state.items).map(id=>[`${id}.route`,routeAnswer("drop",.01)])),usage:{input_tokens:5,output_tokens:2}}));
  try{const o=await classify(CORPUS,"choice",8,rubric,endpoint.fetch);expect(o.items.every(i=>!i.decision.accepted && i.decision.reason==="low-probability")).toBe(true);const rep=evaluateRepetition(CORPUS,o);expect(rep.pass).toBe(false);expect(rep.gates[0]!.tally.falseEscalations).toBe(25);expect(rep.gates[0]!.tally.filingOk).toBe(0);expect(rep.gates[0]!.tally.filingTotal).toBe(18);expect(rep.gates[0]!.tally.agentOk).toBe(0);expect(rep.gates[0]!.tally.agentTotal).toBe(7);}finally{endpoint.close();}
 });
 test("per-repetition and held-out failures never average into acceptance",async()=>{
  const endpoint=await serve("choice");try {
   const clean=await classify(CORPUS,"choice",8,rubric,endpoint.fetch);const bad=structuredClone(clean);const item=CORPUS.find(i=>i.split==="held-out"&&i.gold.route==="rule")!;
   bad.items.find(i=>i.id===item.id)!.decision={route:"drop",accepted:true,reason:"accepted"};
   const rep=evaluateRepetition(CORPUS,bad);expect(rep.gates[0]!.gate!.pass).toBe(true);expect(rep.gates[1]!.gate!.pass).toBe(false);expect(rep.pass).toBe(false);
   const good=evaluateRepetition(CORPUS,clean);expect(configurationVerdict([rep,good,good]).pass).toBe(false);
  }finally{endpoint.close();}
 });
 test("correct observed rows cannot manufacture complete coverage when final human judgment is unavailable",async()=>{
  const last=CORPUS.at(-1)!;
  const endpoint=await serve("choice",q=>Object.hasOwn(q.state.items,last.id)?new Response("unavailable",{status:503}):Response.json({model:"jev-1.13.0",answers:goldAnswers(q,"choice"),usage:{input_tokens:5,output_tokens:2}}));
  try{const o=await classify(CORPUS,"choice",1,rubric,endpoint.fetch);expect(o.calls).toHaveLength(41);expect(o.judgmentCoverageComplete).toBe(false);
   const rep=evaluateRepetition(CORPUS,o);expect(rep.gates.every(g=>g.gate?.pass)).toBe(true);expect(rep.pass).toBe(false);expect(rep.gates[1]!.unavailableIds).toEqual([last.id]);
  }finally{endpoint.close();}
 });
 test("successful missing rows with unavailable retry stay lost, pure transport gaps stay unjudged",async()=>{
  for(const malformed of [false,true]) {
   const endpoint=await serve("choice",()=>malformed?Response.json({model:"jev-1.13.0",answers:{},usage:{input_tokens:2,output_tokens:2}}):new Response("no data",{status:503}));
   try{const o=await classify(CORPUS.slice(0,2),"choice",1,rubric,endpoint.fetch);const rep=evaluateRepetition(CORPUS.slice(0,2),o);expect(rep.pass).toBe(false);expect(rep.gates[0]!.tally.missingRows).toBe(malformed?2:0);expect(rep.gates[0]!.gate===null).toBe(!malformed);}finally{endpoint.close();}
  }
 });
 test("oversized trailing inputs send no request and retain unknown coverage",async()=>{
  const items=CORPUS.filter(i=>i.split==="held-out").slice(0,2).map((i,n)=>({...i,id:`tail${n}`,body:i.body+"x".repeat(5000)+" must sign"}));const endpoint=await serve("choice");
  try{const o=await classify(items,"choice",8,rubric,endpoint.fetch);expect(endpoint.requests).toHaveLength(0);expect(o.boundsRejected).toEqual(["tail0","tail1"]);expect(o.items.every(i=>!i.rawJudged)).toBe(true);expect(evaluateRepetition(items,o).pass).toBe(false);}finally{endpoint.close();}
 });
 test("state plus longest question bound rejects complete oversized batches before HTTP",async()=>{
  const items=CORPUS.slice(0,8).map(i=>({...i,body:i.body+"x".repeat(3300)}));const endpoint=await serve("ordered-noul");
  try {const o=await classify(items,"ordered-noul",8,rubric,endpoint.fetch);expect(endpoint.requests).toHaveLength(0);expect(o.boundsRejected).toEqual(items.map(i=>i.id));expect(o.judgmentCoverageComplete).toBe(false);}finally{endpoint.close();}
 });
 test("truncated response body retains partial exact bytes and cannot become judged/billed complete",async()=>{
  const partial=Buffer.from('{"model":"jev-1.13.0","answers":');
  const o=await classify(CORPUS.slice(0,1),"choice",1,rubric,async()=>new Response(new ReadableStream({start(c){c.enqueue(partial);setTimeout(()=>c.error(Error("fixture stream truncated")),1);}})));
  expect(o.calls.length).toBeGreaterThan(0);expect(Buffer.from(o.calls[0]!.responseBase64!,"base64")).toEqual(partial);expect(o.calls[0]!.responseComplete).toBe(false);expect(o.calls[0]!.failure).toContain("fixture stream truncated");expect(o.items[0]!.malformedObserved).toBe(false);expect(workflowAccounting(o.calls,[],false).receiptComplete).toBe(false);
 });
 test("429 retry, binary errors and served-model mismatch retain exact physical evidence",async()=>{
  const endpoint=await serve("choice",(q,n)=>n===1?new Response(new Uint8Array([0,255,128]),{status:429}):Response.json({model:"wrong-model",answers:goldAnswers(q,"choice"),usage:{input_tokens:9,output_tokens:3}}));
  try{const o=await classify(CORPUS.slice(0,1),"choice",1,rubric,endpoint.fetch);expect(o.calls).toHaveLength(2);expect(Buffer.from(o.calls[0]!.responseBase64!,"base64")).toEqual(Buffer.from([0,255,128]));expect(workflowAccounting(o.calls,[],false).receiptComplete).toBe(false);expect(o.calls[1]!.model).toBe("wrong-model");expect(o.stopReason).toBe("missing or unexpected served model");expect(o.items[0]!.decision.accepted).toBe(false);}finally{endpoint.close();}
 });
});
const raw={type:"result",is_error:true,modelUsage:{"claude-sonnet-5-5":{inputTokens:100,outputTokens:20,cacheReadInputTokens:30,cacheCreationInputTokens:40}}};
const call:GenerationCall={phase:"fallback",model:"claude-sonnet-5-5",physicalRequests:1,terminal:true,failed:true,usageBasis:"native-final-all-model",tokens:{input:100,output:20,cacheRead:30,cacheWrite:40},priceEstimate:priceSonnet55Usage(raw),rawRequest:"original request",rawResponseBase64:Buffer.from(JSON.stringify(raw)).toString("base64"),failure:"known failed turn",durationMs:10};
describe("complete terminal workflow accounting",()=>{
 test("failed terminal cost remains retained, no invoice or absent summary demand invented",()=>{
  const a=workflowAccounting([], [call],false);expect(a.receiptComplete).toBe(true);expect(a.knownListEstimateUpperUsd).toBe(call.priceEstimate!.upperUsd);expect(a.failedGenerationCalls).toHaveLength(1);expect(a.actualAdditionalInvoiceUsd).toBeNull();expect(workflowAccounting([], [call],null).receiptComplete).toBe(false);expect(workflowAccounting([], [call],true).receiptComplete).toBe(false);
 });
 for(const patch of [{tokens:null},{tokens:{}},{tokens:{input:1,output:1,cacheRead:1}},{physicalRequests:0},{usageBasis:"invented"},{tokens:{input:100,output:1,cacheRead:30,cacheWrite:40}},{rawResponseBase64:"garbled"},{priceEstimate:{lowerUsd:NaN,upperUsd:1,unknownCacheTokens:0}}])test(`incomplete raw receipt rejected: ${JSON.stringify(patch)}`,()=>{
  const a=workflowAccounting([], [{...call,...patch} as GenerationCall],false);expect(a.receiptComplete).toBe(false);expect(a.unknown).toEqual(["generation:0"]);expect(a.knownListEstimateUpperUsd).toBe(0);
 });
 test("latency uses complete finite observations, unknown is null",()=>{expect(latencySummary([10,20,30,40,50])).toEqual({observations:5,p50Ms:30,p95Ms:50,totalMs:150,throughputPerSecond:1000/30});expect(latencySummary([])).toBeNull();expect(latencySummary([NaN])).toBeNull();});
});
