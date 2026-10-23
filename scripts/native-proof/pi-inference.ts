/** Keyless loopback transport only: the actual Pi SDK selects and executes its own tools. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
type Event = (kind:string,data?:object)=>void;
const HOST_KEY="odysseus-offline-host-key";
export function startPiNativeInference(agentDirectory:string,event:Event,authorityCommand:string,egressCommand:(attempt:number)=>string) {
  let attempts=0;const seen=new Map<string,number>();
  const model="claude-sonnet-4-6";
  const server=Bun.serve({hostname:"127.0.0.1",port:0,maxRequestBodySize:16*1024**2,async fetch(request){
    if(request.method!=="POST"||new URL(request.url).pathname!=="/v1/messages")return new Response("unexpected offline inference route",{status:404});
    // Only the host-held fixture key is accepted: a worker placeholder means the relay did not inject it.
    if(request.headers.get("x-api-key")!==HOST_KEY){event("pi_inference_unauthenticated",{});return new Response("fixture key required",{status:401});}
    const body=await request.json() as {messages:{role:string;content:string|{type:string;text?:string;tool_use_id?:string}[]}[];tools?:{name:string}[]};
    const texts=body.messages.filter(message=>message.role==="user").flatMap(message=>typeof message.content==="string"?[message.content]:message.content.filter(block=>block.type==="text").map(block=>block.text??""));
    const prompt=texts.findLast(text=>text.includes("Odysseus requests")||text.includes("Odysseus cancels"));
    if(!prompt)throw Error("Offline Pi transport did not receive the fixture user request");
    let attempt=seen.get(prompt);if(!attempt){attempt=++attempts;seen.set(prompt,attempt);event("fake_provider_enter",{attempt,backend:"pi"});}
    const toolId=`odysseus-native-bash-${attempt}`;
    const completed=body.messages.some(message=>Array.isArray(message.content)&&message.content.some(block=>block.type==="tool_result"&&block.tool_use_id===toolId));
    const frames:object[]=[{type:"message_start",message:{id:`odysseus-native-${attempt}-${completed?"done":"tool"}`,type:"message",role:"assistant",model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}}];
    if(!completed){
      const bash=body.tools?.find(tool=>tool.name.toLowerCase()==="bash");if(!bash)throw Error("Actual Pi SDK did not expose its configured bash tool");
      const command=`${authorityCommand} > .brain/worker-authority-${attempt}.json && ${egressCommand(attempt)} && printf '%b' '---\\ntype: note\\ntitle: Odysseus worker ${attempt}\\nupdated: 2026-07-12\\n---\\nOdysseus marks the actual Pi worker.\\n' > notes/worker-${attempt}.md; printf worker-pass; sleep ${attempt===3?"10":"0.05"}`;
      frames.push({type:"content_block_start",index:0,content_block:{type:"tool_use",id:toolId,name:bash.name,input:{}}},
        {type:"content_block_delta",index:0,delta:{type:"input_json_delta",partial_json:JSON.stringify({command})}});
    }else frames.push({type:"content_block_start",index:0,content_block:{type:"text",text:""}},{type:"content_block_delta",index:0,delta:{type:"text_delta",text:"Odysseus records the voyage."}});
    frames.push({type:"content_block_stop",index:0},{type:"message_delta",delta:{stop_reason:completed?"end_turn":"tool_use",stop_sequence:null},usage:{output_tokens:1}},{type:"message_stop"});
    event("pi_inference_response",{attempt,completed});
    return new Response(frames.map(frame=>`event: ${(frame as {type:string}).type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),{headers:{"content-type":"text/event-stream"}});
  }});
  // A fictional host-held key, sent only to this offline loopback fixture.
  writeFileSync(join(agentDirectory,"models.json"),JSON.stringify({providers:{anthropic:{baseUrl:`http://127.0.0.1:${server.port}`,apiKey:HOST_KEY}}}));
  // The relay may send the host's key to this fixture origin only because the host lists it.
  return {model:`anthropic/${model}`,origin:`anthropic=http://127.0.0.1:${server.port}`,close(){server.stop(true);}};
}
