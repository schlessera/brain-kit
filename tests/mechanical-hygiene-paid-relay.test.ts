import { test,expect } from "bun:test";
import { NativeBudget,PAID_AUTHORIZATION,digest,type NativePaidPolicy } from "../scripts/evals/native-paid-policy";
import { startRelay,MODEL } from "../scripts/evals/mechanical-hygiene/native-relay";
const prompt="Odysseus reviews the raft",binding={freezeSha:digest("freeze"),inputSha:digest("input"),protocolSha:digest("protocol"),runtimeSha:digest("runtime"),proofSha:digest("proof"),promptSha:digest(prompt)};
function budget(remainingUpperUsd=15){
  const p:NativePaidPolicy={...binding,version:1,issue:842,control:"offline",purpose:"review",authorizationUrl:PAID_AUTHORIZATION,allowOverage:true,basis:"actual additional billed charges",perIssueCapUsd:15,aggregateCapUsd:150,remainingUpperUsd,canonicalModel:MODEL,maxPhysicalRequests:24,maxInputBytes:5_000_000,contextWindowTokens:1_000_000,maxOutputTokens:128000,inputUsdPerMillionUpper:8,outputUsdPerMillionUpper:20,invoiceUsd:null,grantNonce:digest("offline-relay-grant"),consumedMarkerPath:`/tmp/${digest("offline-relay-grant")}.json`,issuedAt:new Date(Date.now()-1000).toISOString(),expiresAt:new Date(Date.now()+60000).toISOString()};
  return new NativeBudget(842,"offline",p,binding,()=>{});
}
const body=JSON.stringify({model:MODEL,max_tokens:8000,tools:[],output_config:{effort:"low"},messages:[{role:"user",content:prompt}]});
function response(missing=false){return new Response([
  {type:"message_start",message:{model:MODEL,usage:{input_tokens:17,output_tokens:0,...missing?{}:{cache_read_input_tokens:0},cache_creation_input_tokens:0}}},
  {type:"message_delta",usage:{output_tokens:23}},{type:"message_stop"},
].map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""),{headers:{"content-type":"text/event-stream"}});}
test("real loopback relay persists the full-context reservation before handing bytes to its request method",async()=>{
  const b=budget();let forwarded=0;const token="offline-paid-relay-not-a-credential";
  const relay=startRelay({oauthToken:token,budget:b,save:()=>{},fetch:async()=>{
    expect(b.entries[0].status).toBe("reserved");expect(b.entries[0].inputBound).toBe(1_000_000);expect(b.usedUpper()).toBeCloseTo(8.16,12);forwarded++;return response();
  }});
  try{
    await (await fetch(`${relay.url}/v1/messages`,{method:"POST",headers:{authorization:`Bearer ${token}`},body})).text();
    expect(forwarded).toBe(1);expect(b.entries[0].status).toBe("complete");expect(b.entries[0].invoiceUsd).toBeNull();expect(relay.complete()).toBe(true);
  }finally{await relay.stop();}
});
test("real loopback relay refuses insufficient allocation before upstream and retains missing-usage hold",async()=>{
  for(const missing of [false,true]){
    const b=budget(missing?15:.01);let forwarded=0;const token="offline-refusal-relay-not-a-credential";
    const relay=startRelay({oauthToken:token,budget:b,save:()=>{},fetch:async()=>{forwarded++;return response(missing);}});
    const send=()=>fetch(`${relay.url}/v1/messages`,{method:"POST",headers:{authorization:`Bearer ${token}`},body});
    try{
      let r:Response|undefined;try{r=await send();await r.text();}catch{}
      if(missing){expect(forwarded).toBe(1);expect(b.entries[0].status).toBe("unknown");expect(b.entries[0].pricedUpperUsd).toBeNull();expect(b.usedUpper()).toBeCloseTo(8.16,12);expect((await send()).status).toBe(409);expect(forwarded).toBe(1);}
      else{expect(r?.status).toBe(403);expect(forwarded).toBe(0);expect(b.entries).toEqual([]);expect(relay.calls[0].upstreamDispatched).toBe(false);}
    }finally{await relay.stop();}
  }
});
test("real relay refuses each observed pricing modifier even when a later usage delta overwrites it",async()=>{
  for(const kind of ["header","start"]){
    const b=budget(),token="offline-modifier-control";let forwarded=0;
    const relay=startRelay({oauthToken:token,budget:b,save:()=>{},fetch:async()=>{
      forwarded++;const original=response(),headers=new Headers(original.headers);
      if(kind==="header")headers.set("service-tier","priority");
      const text=await original.text(),events=text.replace('"cache_creation_input_tokens":0','"cache_creation_input_tokens":0,"service_tier":"priority"').replace('"output_tokens":23','"output_tokens":23,"service_tier":"standard"');
      return new Response(kind==="start"?events:text,{headers});
    }});
    try{
      try{await(await fetch(`${relay.url}/v1/messages`,{method:"POST",headers:{authorization:`Bearer ${token}`},body})).text();}catch{}
      expect(forwarded).toBe(1);expect(b.entries[0].status).toBe("unknown");expect(b.usedUpper()).toBeCloseTo(8.16,12);expect(relay.complete()).toBe(false);
    }finally{await relay.stop();}
  }
});
test("actual paid relay blocks wrong auth, requested model and priority before its lowest request method",async()=>{
  const token="offline-auth-model-control";
  const controls:Array<{headers:Record<string,string>;request:string;outcome:string}>=[
    {headers:{authorization:"Bearer unexpected"},request:body,outcome:"subscription_header_refused"},
    {headers:{authorization:`Bearer ${token}`,"x-api-key":"offline-not-a-key"},request:body,outcome:"subscription_header_refused"},
    {headers:{authorization:`Bearer ${token}`},request:body.replace(MODEL,"unexpected-model"),outcome:"unexpected_requested_model"},
    {headers:{authorization:`Bearer ${token}`},request:JSON.stringify({...JSON.parse(body),service_tier:"priority"}),outcome:"root_paid_reservation_refused"},
  ];
  for(const control of controls){
    const b=budget();let forwarded=0;const relay=startRelay({oauthToken:token,budget:b,save:()=>{},fetch:async()=>{forwarded++;return response();}});
    try{
      const r=await fetch(`${relay.url}/v1/messages`,{method:"POST",headers:control.headers,body:control.request});
      expect(r.status).toBe(403);expect(await r.text()).toBe(control.outcome);expect(forwarded).toBe(0);expect(b.entries).toEqual([]);expect(relay.calls[0].upstreamDispatched).toBe(false);
    }finally{await relay.stop();}
  }
});
