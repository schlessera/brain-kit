/** Actual native in-flight cancellation proof; only the explicit offline namespace. */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { prepare, fixtures } from "./fixture";
import { installNativeSurface } from "./native-surface";
import { runNativePhase, runtime } from "./native-driver";
async function main(){
  if(process.env.BRAIN_HYGIENE_OFFLINE!=="1"||readFileSync("/proc/net/dev","utf8").split("\n").slice(2).some(line=>line.includes(":")&&!line.trim().startsWith("lo:")))throw Error("Actual isolated offline namespace required");
  const destination=process.argv[2];if(!destination)throw Error("Fresh protected output required");
  const source=new URL("../../../",import.meta.url).pathname,env=prepare(fixtures[0],19);installNativeSurface(env.root,source,fixtures[0]);
  let physical=0,cancelled=false;
  try{
    const receipt=await runNativePhase({root:env.root,source,destination:join(destination,"native"),phase:"dry-run",token:`sk-ant-oat01-${"o".repeat(95)}AA`,offline:true,deadlineMs:10000,offlineDeadlineAfterDispatchMs:200,
      async physicalFetch(){physical++;return new Response(new ReadableStream<Uint8Array>({start(controller){controller.enqueue(new TextEncoder().encode(`event: message_start\ndata: ${JSON.stringify({type:"message_start",message:{id:"msg_deadline",type:"message",role:"assistant",model:runtime.model,content:[],usage:{input_tokens:10,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0}}})}\n\n`));},cancel(){cancelled=true;}}),{headers:{"content-type":"text/event-stream"}});}});
    assert.equal(physical,1,"Actual native request was active before deadline");assert.equal(receipt.promptReleased,true);
    assert.equal(receipt.native.failure,"Native deadline exceeded","Deadline must abort the actual SDK query");
    assert.equal(receipt.native.ownedChildDrained,true);assert.equal(receipt.stdoutComplete,true);
    assert.equal(cancelled,true,"Deadline must close the owned physical reader");assert.equal(receipt.physicalCalls[0].responseNaturalEof,false);
    assert.equal(receipt.physicalCalls[0].upstreamReaderClosed,true);assert.equal(receipt.apiEquivalent,null);
    assert.equal(receipt.diagnostics.unknownPhysicalCalls,1);assert.equal(receipt.diagnostics.aggregateApiEquivalent,null);
    assert.ok(receipt.durationMs<5000,"Actual SDK deadline/control drain must remain bounded");
    console.log(JSON.stringify({passed:true,sdk:receipt.runtimePair.sdk,cli:receipt.runtimePair.cli,physical,ownedChildDrained:true,unknownCostsPreserved:true,externalRequests:0}));
  }finally{env.close();}
}
if(import.meta.main)await main();
