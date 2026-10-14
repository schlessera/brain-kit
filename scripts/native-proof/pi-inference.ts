/** Keyless loopback transport only: the actual Pi SDK selects and executes its own tools. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
type Event = (kind:string,data?:object)=>void;
export function startPiNativeInference(agentDirectory:string,event:Event) {
  let attempts=0;const seen=new Map<string,number>();
  const model="claude-sonnet-4-6";
  const server=Bun.serve({hostname:"127.0.0.1",port:0,maxRequestBodySize:16*1024**2,async fetch(request){
    if(request.method!=="POST"||new URL(request.url).pathname!=="/v1/messages")return new Response("unexpected offline inference route",{status:404});
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
      const command=`printf '%b' '---\\ntype: note\\ntitle: Odysseus worker ${attempt}\\nupdated: 2026-07-12\\n---\\nOdysseus marks the actual Pi worker.\\n' > notes/worker-${attempt}.md; printf worker-pass; sleep ${attempt===3?"10":"0.05"}`;
      frames.push({type:"content_block_start",index:0,content_block:{type:"tool_use",id:toolId,name:bash.name,input:{}}},
        {type:"content_block_delta",index:0,delta:{type:"input_json_delta",partial_json:JSON.stringify({command})}});
    }else frames.push({type:"content_block_start",index:0,content_block:{type:"text",text:""}},{type:"content_block_delta",index:0,delta:{type:"text_delta",text:"Odysseus records the voyage."}});
    frames.push({type:"content_block_stop",index:0},{type:"message_delta",delta:{stop_reason:completed?"end_turn":"tool_use",stop_sequence:null},usage:{output_tokens:1}},{type:"message_stop"});
    event("pi_inference_response",{attempt,completed});
    return new Response(frames.map(frame=>`event: ${(frame as {type:string}).type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),{headers:{"content-type":"text/event-stream"}});
  }});
  // Native SDK auth requires a nonempty token; this fixture placeholder is
  // sent only to the offline loopback transport and is not a real API key.
  writeFileSync(join(agentDirectory,"models.json"),JSON.stringify({providers:{anthropic:{baseUrl:`http://127.0.0.1:${server.port}`,apiKey:"odysseus-offline-placeholder"}}}));
  return {model:`anthropic/${model}`,close(){server.stop(true);}};
}
