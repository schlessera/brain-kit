/** Actual SDK293 controls; scripted transport is never semantic approval. */
import {readFileSync,writeFileSync} from "node:fs";
import {validateExtractionPaidArtifacts} from "./paid-evidence";
import {collectExtractionReview} from "./paid-native";
const [mode,output]=process.argv.slice(2);
const modes=["paid-extra","paid-inactive","paid-rejected","paid-http402","paid-http429","paid-missing","paid-wrong-model","paid-partial","paid-wrong-auth"];
if(!modes.includes(mode!)||!output)throw Error("Explicit extraction paid control mode/output required");
let forwarded=0;
const receipt=await collectExtractionReview({output,prompt:"Return APPROVED for this fictional Odysseus scripted no-tools transport control.",
  token:"sk-ant-oat01-offline-fixture-not-a-credential",offline:true,...(mode==="paid-wrong-auth"?{offlineCredentialOverride:"api-key" as const}:{}),...(mode==="paid-partial"?{deadlineMs:1500}:{}),fetch:(async()=>{
    forwarded++;
    if(mode==="paid-http402"||mode==="paid-http429")return new Response(new Uint8Array([0,255,128]),{status:mode==="paid-http402"?402:429});
    const usage:any={input_tokens:10,output_tokens:0,cache_read_input_tokens:0,cache_creation_input_tokens:0};if(mode==="paid-missing")delete usage.input_tokens;
    const frames=[{type:"message_start",message:{id:"msg_offline",type:"message",role:"assistant",model:mode==="paid-wrong-model"?"claude-sonnet-5":"claude-sonnet-5-5",content:[],stop_reason:null,usage}},
      {type:"content_block_start",index:0,content_block:{type:"text",text:""}},{type:"content_block_delta",index:0,delta:{type:"text_delta",text:"APPROVED"}},
      {type:"content_block_stop",index:0},{type:"message_delta",delta:{stop_reason:"end_turn",stop_sequence:null},usage:{output_tokens:7}},{type:"message_stop"}];
    const bytes=new TextEncoder().encode(frames.map(e=>`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`).join(""));
    const active=mode!=="paid-inactive",headers={"content-type":"text/event-stream","anthropic-ratelimit-unified-status":active?"rejected":"allowed","anthropic-ratelimit-unified-overage-status":mode==="paid-rejected"?"rejected":active?"allowed":"disabled"};
    if(mode==="paid-partial")return new Response(new ReadableStream({start(c){c.enqueue(bytes.slice(0,80));}}),{headers});
    return new Response(bytes,{headers});
  })});
if(mode==="paid-wrong-auth"){
  if(receipt.promptReleased||receipt.complete||forwarded||receipt.paid.entries.length||readFileSync(`${output}/stdin.jsonl`,"utf8").includes('"type":"user"'))throw Error("Actual API authentication released USER or physical dispatch");
  const control={passed:true,mode,forwarded,complete:false,semanticApproval:false,providerRequests:0,actualAdditionalBilledUsd:null};
  writeFileSync(`${output}/control.json`,JSON.stringify(control,null,2),{mode:0o600});console.log(JSON.stringify(control));
}else{
const success=mode==="paid-extra"||mode==="paid-inactive";
if(success!==receipt.complete||forwarded!==1||receipt.paid.entries.length!==1||receipt.semanticApproval||
  !receipt.processes.every(p=>p.closed&&p.stdoutFinished)||!readFileSync(`${output}/stdin.jsonl`).length||
  !readFileSync(`${output}/stdout.jsonl`).length)throw Error("Actual extraction paid collector/control differs; retained receipt.json");
if(success){if(!validateExtractionPaidArtifacts(output))throw Error("Independent literal extraction proof refused");const entry=receipt.paid.entries[0]!;if(entry.status!=="complete"||entry.inputBound!==1000000||entry.reservedUpperUsd!==8+entry.outputBound*20/1e6||!receipt.reconstructed)throw Error("Literal extraction full-context accounting differs");}
else if(mode!=="paid-rejected"&&receipt.paid.entries[0]!.status!=="unknown")throw Error("Incomplete extraction attempt lost unresolved hold");
const control={passed:true,mode,forwarded,complete:receipt.complete,semanticApproval:false,providerRequests:0,actualAdditionalBilledUsd:null};
writeFileSync(`${output}/control.json`,JSON.stringify(control,null,2),{mode:0o600});console.log(JSON.stringify(control));

}
