/** Final host fence around the installed Agent's supported tool hooks. */
import type { Agent } from "@earendil-works/pi-agent-core";
import type { InlineExtension } from "@earendil-works/pi-coding-agent";
import type { PermissionDecision } from "@schlessera/brain-ui-sdk/server";

type Content = import("@earendil-works/pi-agent-core").AfterToolCallContext["result"]["content"];
export interface PiToolSafety {
  permission(name:string,id:string,input:Record<string,unknown>):Promise<PermissionDecision>;
  result(name:string,id:string,content:Content):Promise<void>;
  stop():void;
}

/** Nested ctx.executeTool calls bypass the public Agent hooks in Pi 0.99.2.
 * Refuse them before execution until upstream exposes the final nested fence. */
export function nestedToolSafetyGate():InlineExtension {
 return {name:"brain-nested-tool-safety",factory:pi=>{
  pi.on("tool_call",event=>event.parentToolCallId?{block:true,terminate:true,reason:"Nested tool execution has no qualified final host safety fence."}:undefined);
 }};
}

/** Pi's public afterToolCall runs after every tool_result extension and image
 * normalization. Extension exceptions alone are swallowed by Pi's runner;
 * this outer hook aborts the agent on recording loss, before another request.
 * No tools, prompts, messages or already-delivered results are rewritten. */
export function installPiToolSafety(agent:Agent,safety:PiToolSafety):void {
 const before=agent.beforeToolCall,after=agent.afterToolCall;
 const stop=()=>{safety.stop();agent.abort();};
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
  try{
   const final=await after?.(context,signal);
   await safety.result(context.toolCall.name,context.toolCall.id,final?.content??context.result.content);
   return final;
  }catch(error){stop();throw error;}
 };
}
