/** Keyless loopback transport only: the actual Pi SDK selects and executes its own tools. */
import { writeFileSync } from "node:fs";
import { join } from "node:path";
type Event = (kind:string,data?:object)=>void;
const HOST_KEY="odysseus-offline-host-key";
/** #2835 timing turn: the fixture model's exact host-applied writes, edits and one same-turn search. */
export interface ScheriaTiming { count:number; path:(i:number)=>string; content:(i:number)=>string; sha256:(text:string)=>string }
/**
 * #2834 timeline turn: the fixture model's exact calls, one per request, each
 * request's arrival and each response's dispatch on the app's own clock.
 */
export interface IthacaTimeline { cells:readonly {label:string;steps:readonly (readonly [name:string,input:object,label:string|null])[]}[] }
export function startPiNativeInference(agentDirectory:string,event:Event,authorityCommand:string,egressCommand:(attempt:number)=>string,timing?:ScheriaTiming,timeline?:IthacaTimeline) {
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
    if(timing&&prompt.includes("Scheria log"))return scheria(body,attempt,timing);
    if(timeline&&prompt.includes("Ithaca "))return ithaca(body,attempt,timeline,texts);
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
  // One tool call per response, in order: write each log, edit each log, search, answer.
  function scheria(body:{messages:{role:string;content:string|{type:string;text?:string;tool_use_id?:string;content?:unknown}[]}[];tools?:{name:string}[]},attempt:number,timing:ScheriaTiming){
    const results=body.messages.flatMap(message=>Array.isArray(message.content)?message.content.filter(block=>block.type==="tool_result"&&block.tool_use_id?.startsWith("scheria-")):[]);
    const step=results.length,count=timing.count;
    const frames:object[]=[{type:"message_start",message:{id:`odysseus-scheria-${attempt}-${step}`,type:"message",role:"assistant",model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}}];
    const call=(name:string,input:object)=>{
      if(!body.tools?.some(tool=>tool.name===name))throw Error(`Actual Pi SDK did not expose ${name} to the timing turn`);
      frames.push({type:"content_block_start",index:0,content_block:{type:"tool_use",id:`scheria-${step}`,name,input:{}}},{type:"content_block_delta",index:0,delta:{type:"input_json_delta",partial_json:JSON.stringify(input)}});
    };
    if(step<count)call("write_file",{path:timing.path(step),content:timing.content(step)});
    else if(step<2*count){const i=step-count;call("edit_file",{path:timing.path(i),expectedBaseHash:timing.sha256(timing.content(i)),old_string:"Scheria shore",new_string:"Scheria harbour"});}
    else if(step===2*count)call("brain_search",{query:"harbour Nausicaa",limit:50});
    else{
      const text=(block:unknown):string=>typeof block==="string"?block:Array.isArray(block)?block.map(text).join("\n"):block&&typeof block==="object"&&"text" in block?String((block as {text:unknown}).text):"";
      event("scheria_search",{backend:"pi",text:text(results.at(-1)?.content)});
      frames.push({type:"content_block_start",index:0,content_block:{type:"text",text:""}},{type:"content_block_delta",index:0,delta:{type:"text_delta",text:"Odysseus files the Scheria log."}});
    }
    const done=step>2*count;
    frames.push({type:"content_block_stop",index:0},{type:"message_delta",delta:{stop_reason:done?"end_turn":"tool_use",stop_sequence:null},usage:{output_tokens:1}},{type:"message_stop"});
    event("pi_inference_response",{attempt,step,completed:done});
    return new Response(frames.map(frame=>`event: ${(frame as {type:string}).type}\ndata: ${JSON.stringify(frame)}\n\n`).join(""),{headers:{"content-type":"text/event-stream"}});
  }
  function ithaca(body:{messages:{role:string;content:string|{type:string;tool_use_id?:string}[]}[];tools?:{name:string}[]},attempt:number,plan:IthacaTimeline,texts:string[]){
    const arrivedAt=performance.now();
    const step=body.messages.flatMap(message=>Array.isArray(message.content)?message.content.filter(block=>block.type==="tool_result"&&block.tool_use_id?.startsWith(`ithaca-${attempt}-`)):[]).length;
    event("timeline_request",{attempt,step,at:arrivedAt});
    const frames:object[]=[{type:"message_start",message:{id:`odysseus-ithaca-${attempt}-${step}`,type:"message",role:"assistant",model,content:[],stop_reason:null,stop_sequence:null,usage:{input_tokens:1,output_tokens:0}}}];
    // A harbour record is one bash write, for the journal begin and finish timings.
    const request=texts.findLast(text=>text.includes("Odysseus requests"))??"";
    const harbour=/Ithaca harbour record (\d+)/.exec(request),cell=/Ithaca timeline cell (\d+)/.exec(request);
    const next=harbour?(step===0?["bash",{command:`echo Eurycleia ${harbour[1]} > notes/ithaca-harbour-${harbour[1]}.md`},null] as const:undefined)
      :cell?plan.cells[Number(cell[1])]?.steps[step]:undefined;
    if(next){
      const [name,input]=next;
      if(!body.tools?.some(tool=>tool.name===name))throw Error(`Actual Pi SDK did not expose ${name} to the timeline turn`);
      frames.push({type:"content_block_start",index:0,content_block:{type:"tool_use",id:`ithaca-${attempt}-${step}`,name,input:{}}},{type:"content_block_delta",index:0,delta:{type:"input_json_delta",partial_json:JSON.stringify(input)}});
    }else frames.push({type:"content_block_start",index:0,content_block:{type:"text",text:""}},{type:"content_block_delta",index:0,delta:{type:"text_delta",text:"Odysseus files the Ithaca timeline."}});
    frames.push({type:"content_block_stop",index:0},{type:"message_delta",delta:{stop_reason:next?"tool_use":"end_turn",stop_sequence:null},usage:{output_tokens:1}},{type:"message_stop"});
    const response=frames.map(frame=>`event: ${(frame as {type:string}).type}\ndata: ${JSON.stringify(frame)}\n\n`).join("");
    event("timeline_response",{attempt,step,tool:next?.[0]??null,label:next?.[2]??null,toolUseId:next?`ithaca-${attempt}-${step}`:null,at:performance.now()});
    return new Response(response,{headers:{"content-type":"text/event-stream"}});
  }
  // A fictional host-held key, sent only to this offline loopback fixture.
  writeFileSync(join(agentDirectory,"models.json"),JSON.stringify({providers:{anthropic:{baseUrl:`http://127.0.0.1:${server.port}`,apiKey:HOST_KEY}}}));
  // The relay may send the host's key to this fixture origin only because the host lists it.
  return {model:`anthropic/${model}`,origin:`anthropic=http://127.0.0.1:${server.port}`,close(){server.stop(true);}};
}
