/** Explicit offline namespace integration. Bogus token, scripted loopback responses only. */
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepare, fixtures } from "./fixture";
import { installNativeSurface } from "./native-surface";
import { runNativePhase, runtime } from "./native-driver";
const MODEL = runtime.model;
export function response(id: number, tool?: { name: string; input: unknown }) {
  const frames = [
    { type: "message_start", message: { id: `msg_${id}`, type: "message", role: "assistant", model: MODEL, content: [], stop_reason: null, usage: { input_tokens: 10, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    { type: "content_block_start", index: 0, content_block: tool ? {type:"tool_use",id:`tool_${id}`,name:tool.name,input:{}} : {type:"text",text:""} },
    { type: "content_block_delta", index: 0, delta: tool ? {type:"input_json_delta",partial_json:JSON.stringify(tool.input)} : {type:"text_delta",text:"Offline hygiene proof complete."} },
    { type: "content_block_stop", index: 0 },
    { type: "message_delta", delta: { stop_reason: tool ? "tool_use" : "end_turn", stop_sequence: null }, usage: { output_tokens: 7 } },
    { type: "message_stop" },
  ];
  return new Response(frames.map(f => `event: ${f.type}\ndata: ${JSON.stringify(f)}\n\n`).join(""), {headers:{"content-type":"text/event-stream","anthropic-ratelimit-unified-status":"allowed","anthropic-ratelimit-unified-overage-status":"allowed","anthropic-ratelimit-unified-overage-disabled-reason":"org_level_disabled"}});
}
async function main() {
  if (process.env.BRAIN_HYGIENE_OFFLINE !== "1") throw Error("Explicit offline namespace required");
  const source = new URL("../../../",import.meta.url).pathname;
  const fixture = fixtures.find(f => f.id === "date-mtime-later")!, env = prepare(fixture, 19);
  installNativeSurface(env.root,source,fixture);
  const out = process.argv[2]; if (!out) throw Error("Require protected fresh output parent"); mkdirSync(out,{mode:0o700});
  let mainCalls=0, physical=0, sentinelReached=false; const observed: unknown[]=[];
  const steps = [
    {name:"Read",input:{file_path:join(source,".hygiene-offline-sentinel.md")}},
    {name:"Bash",input:{command:"brain hygiene reconcile --dry-run --json"}},
    {name:"Bash",input:{command:"brain config check"}},
    {name:"Bash",input:{command:"stat -c %y context/raft.md"}},
  ];
  // The readonly source mount makes this sentinel reachable without the hook.
  // The actual denial must prevent its bytes reaching model-bound messages.
  writeFileSync(join(source,".hygiene-offline-sentinel.md"),"OUTSIDE_HYGIENE_PRIVATE_SENTINEL");
  try {
    const receipt = await runNativePhase({root:env.root,source,destination:join(out,"dry-run"),phase:"dry-run",offline:true,
      token:`sk-ant-oat01-${"o".repeat(95)}AA`,deadlineMs:20000,
      async physicalFetch(_url,init){physical++;const request=JSON.parse(typeof init.body === "string" ? init.body : new TextDecoder().decode(init.body as Uint8Array));
        if(JSON.stringify(request.messages).includes("OUTSIDE_HYGIENE_PRIVATE_SENTINEL"))sentinelReached=true;
        const main = request.tools?.some((tool:any)=>tool.name==="Bash");
        for(const message of request.messages??[])for(const block of Array.isArray(message.content)?message.content:[])if(block.type==="tool_result")observed.push(block);
        return response(physical,main?steps[mainCalls++]:undefined);
      }});
    writeFileSync(join(out,"tool-results.json"),JSON.stringify(observed,null,2),{mode:0o600});
    assert.equal(sentinelReached,false,"Outside controlled source sentinel reached actual model-bound messages");
    if(receipt.native.failure)throw Error(receipt.native.failure);
    if(!receipt.native.ownedChildDrained||!receipt.native.naturalStdoutEof||!receipt.promptReleased||receipt.init?.cli!==receipt.runtimePair.cli||!receipt.native.calls.length)throw Error("Actual native/physical/closure proof incomplete");
    if(receipt.tools.length!==steps.length||receipt.tools[0].allowed||!receipt.tools.slice(1).every(t=>t.allowed))throw Error("Actual hook/CLI positive controls did not execute");
    const text=JSON.stringify(observed);
    if(!text.includes("detected")||!text.includes("2026-07-11"))throw Error("Actual shipped CLI/mtime control missing");
    console.log(JSON.stringify({passed:true,model:MODEL,cli:receipt.init.cli,sdk:receipt.runtimePair.sdk,physical,tools:receipt.tools.length,overage:receipt.native.overage,clock:"tool-only July12",externalRequests:0}));
  } finally {env.close();rmSync(join(source,".hygiene-offline-sentinel.md"),{force:true});}
}
if(import.meta.main)await main();
