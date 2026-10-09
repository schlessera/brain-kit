import { test, expect } from "bun:test";
import { startRelay, MODEL, physicalPriceDiagnostics } from "../scripts/evals/mechanical-hygiene/native-relay";
function sse(finalOutput:boolean){
  const frames=[{type:"message_start",message:{model:MODEL,usage:{input_tokens:10,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}},
    {type:"message_delta",usage:finalOutput?{output_tokens:9,input_tokens:null,cache_read_input_tokens:null}:{}},{type:"message_stop"}];
  return new Response(frames.map(frame=>`event: ${frame.type}\r\ndata: ${JSON.stringify(frame)}\r\n\r\n`).join(""),{headers:{"content-type":"text/event-stream"}});
}
for(const complete of [true,false])test(`actual loopback physical relay ${complete?"reconciles terminal nullable counters":"stops the next request on missing terminal output"}`,async()=>{
  const token="offline-relay-not-a-credential";let calls=0;const saved:unknown[]=[];
  const relay=startRelay({oauthToken:token,save:rows=>saved.push(structuredClone(rows)),fetch:async()=>{calls++;return sse(complete);}});
  const request=()=>fetch(`${relay.url}/v1/messages`,{method:"POST",headers:{authorization:`Bearer ${token}`,"content-type":"application/json"},body:JSON.stringify({model:MODEL,messages:[]})});
  try{
    let failed=false;try{const response=await request();await response.text();}catch{failed=true;}
    expect(failed).toBe(!complete);expect(relay.calls).toHaveLength(1);
    const receipt=relay.calls[0];expect(receipt.finished).toBe(true);expect(saved.length).toBeGreaterThan(0);
    if(complete){expect(receipt.usage?.output_tokens).toBe(9);expect(receipt.usage?.input_tokens).toBe(10);expect(relay.complete()).toBeTruthy();
      const raw=Buffer.concat(receipt.responseBytesBase64Chunks.map(bytes=>Buffer.from(bytes,"base64"))).toString();expect(raw).toContain("\r\n");expect(raw).toContain('"output_tokens":9');}
    else{expect(receipt.outcome).toBe("missing_usage_or_parse_error");expect(receipt.apiEquivalent).toBeNull();
      expect((await request()).status,"physical uncertainty refuses the next actual request").toBe(409);expect(calls).toBe(1);}
  }finally{await relay.stop();}
});

test("literal native request and binary HTTP failure bytes survive the actual loopback relay",async()=>{
  const responseBytes=new Uint8Array([0,255,13,10,123,125]);let received:Uint8Array|undefined;
  const upstream=Bun.serve({hostname:"127.0.0.1",port:0,async fetch(request){received=new Uint8Array(await request.arrayBuffer());return new Response(responseBytes,{status:503,headers:{"content-type":"application/octet-stream"}});}});
  const token="offline-bytes-not-a-credential",body=Buffer.from(JSON.stringify({model:MODEL,messages:[{role:"user",content:"Odysseus μ"}]}));
  const relay=startRelay({oauthToken:token,upstream:`http://127.0.0.1:${upstream.port}`,save:()=>{},fetch:(url,init)=>fetch(url,init)});
  try{
    const response=await fetch(`${relay.url}/v1/messages`,{method:"POST",headers:{authorization:`Bearer ${token}`},body});
    expect(response.status).toBe(503);expect(new Uint8Array(await response.arrayBuffer())).toEqual(responseBytes);
    const receipt=relay.calls[0];expect(received).toEqual(new Uint8Array(body));
    expect(Buffer.from(receipt.requestBytesBase64,"base64")).toEqual(body);
    expect(Buffer.concat(receipt.responseBytesBase64Chunks.map(bytes=>Buffer.from(bytes,"base64")))).toEqual(Buffer.from(responseBytes));
    expect(receipt.outcome).toBe("http_error");expect(receipt.responseNaturalEof).toBe(true);expect(receipt.streamClosed).toBe(true);expect(receipt.apiEquivalent).toBeNull();
  }finally{await relay.stop();upstream.stop(true);}
});

for(const shutdown of [false,true])test(`actual ${shutdown?"relay shutdown":"consumer cancellation"} aborts and drains the owned upstream stream`,async()=>{
  let upstreamAborted=false,timer:ReturnType<typeof setInterval>|undefined;
  const upstream=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){
    return new Response(new ReadableStream<Uint8Array>({start(controller){
      request.signal.addEventListener("abort",()=>{upstreamAborted=true;clearInterval(timer);try{controller.close();}catch{}},{once:true});
      const first={type:"message_start",message:{model:MODEL,usage:{input_tokens:10,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}};
      controller.enqueue(new TextEncoder().encode(`event: message_start\ndata: ${JSON.stringify(first)}\n\n`));
      timer=setInterval(()=>{try{controller.enqueue(new TextEncoder().encode("event: ping\ndata: {}\n\n"));}catch{clearInterval(timer);}},10);
    },cancel(){upstreamAborted=true;clearInterval(timer);}}),{headers:{"content-type":"text/event-stream"}});
  }});
  const token="offline-cancel-not-a-credential";
  const relay=startRelay({oauthToken:token,upstream:`http://127.0.0.1:${upstream.port}`,save:()=>{},fetch:(url,init)=>fetch(url,init)});
  try{
    const response=await fetch(`${relay.url}/v1/messages`,{method:"POST",headers:{authorization:`Bearer ${token}`},body:JSON.stringify({model:MODEL,messages:[]})});
    const reader=response.body!.getReader();expect((await reader.read()).done).toBe(false);
    if(!shutdown)await reader.cancel("Controlled actual consumer cancellation");
    await relay.stop();
    const receipt=relay.calls[0];expect(receipt.consumerCancelled).toBe(true);expect(receipt.upstreamReaderClosed).toBe(true);expect(receipt.streamClosed).toBe(true);expect(receipt.finished).toBe(true);
    expect(receipt.responseNaturalEof).toBe(false);expect(receipt.apiEquivalent).toBeNull();expect(relay.complete()).toBeFalsy();
    await new Promise(resolve=>setTimeout(resolve,25));expect(upstreamAborted).toBe(true);
  }finally{clearInterval(timer);await relay.stop();upstream.stop(true);}
});

test("malformed literal upstream bytes remain unknown and stop a subsequent actual request",async()=>{
  const bytes=new Uint8Array([101,118,101,110,116,58,32,120,10,100,97,116,97,58,32,255,10,10]);
  const token="offline-malformed-not-a-credential";let forwarded=0;
  const relay=startRelay({oauthToken:token,save:()=>{},fetch:async()=>{forwarded++;return new Response(bytes,{headers:{"content-type":"text/event-stream"}});}});
  const send=()=>fetch(`${relay.url}/v1/messages`,{method:"POST",headers:{authorization:`Bearer ${token}`},body:JSON.stringify({model:MODEL,messages:[]})});
  try{
    try{await (await send()).arrayBuffer();}catch{}
    const row=relay.calls[0];expect(row.responseBytesBase64Chunks.length).toBeGreaterThan(0);
    expect(Buffer.concat(row.responseBytesBase64Chunks.map(b=>Buffer.from(b,"base64")))).toEqual(Buffer.from(bytes));
    expect(row.outcome).toBe("missing_usage_or_parse_error");expect(row.apiEquivalent).toBeNull();
    expect((await send()).status).toBe(409);expect(forwarded).toBe(1);
  }finally{await relay.stop();}
});

test("streamed split UTF-8 and final unterminated SSE frame preserve exact physical bytes",async()=>{
  const first=new TextEncoder().encode(`event: message_start\r\ndata: ${JSON.stringify({type:"message_start",message:{model:MODEL,usage:{input_tokens:10,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}})}\r\n\r\n`);
  const text=new TextEncoder().encode('event: content_block_delta\r\ndata: {"type":"content_block_delta","delta":{"text":"μ"}}\r\n\r\n');
  const cut=text.indexOf(0xce)+1;expect(cut).toBeGreaterThan(0);
  const tail=new TextEncoder().encode('event: message_delta\r\ndata: {"type":"message_delta","usage":{"output_tokens":9}}\r\n\r\nevent: message_stop\r\ndata: {"type":"message_stop"}');
  const segments=[first,text.slice(0,cut),text.slice(cut),tail];let read=0;
  const token="offline-unicode-not-a-credential";
  const relay=startRelay({oauthToken:token,save:()=>{},fetch:async()=>new Response(new ReadableStream<Uint8Array>({pull(controller){if(read<segments.length)controller.enqueue(segments[read++]);else controller.close();}}),{headers:{"content-type":"text/event-stream"}})});
  try{
    const response=await fetch(`${relay.url}/v1/messages`,{method:"POST",headers:{authorization:`Bearer ${token}`},body:JSON.stringify({model:MODEL,messages:[]})});
    expect(Buffer.from(await response.arrayBuffer())).toEqual(Buffer.concat(segments));
    const row=relay.calls[0];expect(row.responseFrames.some(frame=>frame.includes('"text":"μ"'))).toBe(true);
    expect(Buffer.concat(row.responseBytesBase64Chunks.map(b=>Buffer.from(b,"base64")))).toEqual(Buffer.concat(segments));
    expect(row.responseNaturalEof).toBe(true);expect(row.finished).toBe(true);expect(relay.complete()).toBeTruthy();
  }finally{await relay.stop();}
});


test("actual physical failure retains known subtotal and unknown aggregate without billing invention",async()=>{
  const token="offline-ledger-not-a-credential";let forwarded=0;
  const relay=startRelay({oauthToken:token,save:()=>{},fetch:async()=>++forwarded===1?sse(true):new Response(new Uint8Array([255]),{status:503})});
  const send=()=>fetch(`${relay.url}/v1/messages`,{method:"POST",headers:{authorization:`Bearer ${token}`},body:JSON.stringify({model:MODEL,messages:[]})});
  try{
    await (await send()).arrayBuffer();await (await send()).arrayBuffer();expect((await send()).status).toBe(409);
    const diagnostics=physicalPriceDiagnostics(relay.calls);
    expect(diagnostics.physicalRequests).toBe(2);expect(diagnostics.blockedAdmissions).toBe(1);expect(diagnostics.knownUpperUsd).toBeGreaterThan(0);
    expect(diagnostics.unknownPhysicalCalls).toBe(1);expect(diagnostics.aggregateApiEquivalent).toBeNull();expect(diagnostics.actualAdditionalBilledUsd).toBeNull();
    expect(diagnostics.finalInvoiceSupplied).toBe(false);
  }finally{await relay.stop();}
});
