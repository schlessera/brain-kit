/** Final host fence around the installed Agent's supported tool hooks. */
import type { Agent } from "@earendil-works/pi-agent-core";
import type { PermissionDecision } from "@schlessera/brain-ui-sdk/server";
import {PiInputSafetyUnavailableError} from "./worker-protocol.js";

type Content = import("@earendil-works/pi-agent-core").AfterToolCallContext["result"]["content"];
export interface PiToolSafety {
  permission(name:string,id:string,input:Record<string,unknown>):Promise<PermissionDecision>;
  result(name:string,id:string,content:Content):Promise<void>;
  unavailable?():Promise<void>;
  stop():void;
}

/** Await the existing host loss notice; rejection is never proof of durability.
 * The host owns durable failure retention. Either outcome stops this worker. */
export async function refusePiInput(safety:PiToolSafety):Promise<never> {
 const failures:unknown[]=[];
 try{await safety.unavailable?.();}catch(error){failures.push(error);}
 try{safety.stop();}catch(error){failures.push(error);}
 throw new PiInputSafetyUnavailableError(failures.length?new AggregateError(failures,"Pi input refusal failed"):undefined);
}

/** Pi's public afterToolCall runs after every tool_result extension and image
 * normalization. Extension exceptions alone are swallowed by Pi's runner;
 * this outer hook aborts the agent on recording loss, before another request.
 * No tools, prompts, messages or already-delivered results are rewritten. */
export function installPiToolSafety(agent:Agent,safety:PiToolSafety,hasUnqualifiedInput:()=>boolean):void {
 const before=agent.beforeToolCall,after=agent.afterToolCall;
 const stop=()=>{safety.stop();agent.abort();};
 const stream=agent.streamFunction;
 // Recheck the whole extension set after reloads, not a handler blacklist.
 // Even tool_result can independently inject messages via pi.sendMessage().
 // This covers Agent dispatch (including summaries), not CacheWarmer's direct
 // ModelRuntime dispatch. The managed runtime disables that separate path.
 agent.streamFunction=async(...args)=>{
  if(hasUnqualifiedInput()){
   try{return await refusePiInput(safety);}
   finally{agent.abort();}
  }
  return stream(...args);
 };
 agent.beforeToolCall=async(context,signal)=>{
  try{
   const prior=await before?.(context,signal);
   if(prior?.block){
    // Pi skips afterToolCall for a blocked call. Its extension-authored reason
    // is itself the final result, so record it before allowing delivery.
    await safety.permission(context.toolCall.name,context.toolCall.id,context.args as Record<string,unknown>);
    await safety.result(context.toolCall.name,context.toolCall.id,[{type:"text",text:prior.reason || "Tool execution was blocked"}]);
    return prior;
   }
   if(signal?.aborted)return {block:true,terminate:true,reason:"Turn cancelled"};
   const decision=await safety.permission(context.toolCall.name,context.toolCall.id,context.args as Record<string,unknown>);
   if(decision.behavior==="deny")return {block:true,reason:decision.message};
   if(decision.updatedInput){
    const input=context.args as Record<string,unknown>;
    for(const key of Object.keys(input))delete input[key];
    Object.assign(input,decision.updatedInput);
   }
   return prior;
  }catch(error){stop();throw error;}
 };
 agent.afterToolCall=async(context,signal)=>{
  // The tool already ran: its result is reported even when the session's own
  // hook failed, so the host records it or keeps its chat's gap (#3812).
  let final:Awaited<ReturnType<NonNullable<typeof after>>>,failure:{error:unknown}|undefined;
  try{final=await after?.(context,signal);}catch(error){failure={error};}
  try{await safety.result(context.toolCall.name,context.toolCall.id,final?.content??context.result.content);}
  catch(error){stop();throw error;}
  if(failure){stop();throw failure.error;}
  return final;
 };
}
