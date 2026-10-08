/** Actual installed CLI helper-auth refusal before user/model dispatch, offline only. */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, realpathSync } from "node:fs";
import { spawn, type ChildProcess } from "node:child_process";
import { CLEARED_API_CREDENTIALS } from "../../../packages/ui-backend-claude/src/subscription";
import { captureNative, drainOwned } from "./native-capture";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";
import { protectedPrompt, runtime } from "./native-driver";
import { actualNativeRuntime } from "./native-runtime";
import { response } from "./offline-native";
async function main(){
  if(process.env.BRAIN_HYGIENE_OFFLINE!=="1"||readFileSync("/proc/net/dev","utf8").split("\n").slice(2).some(line=>line.includes(":")&&!line.trim().startsWith("lo:")))throw Error("Actual offline namespace required");
  const pair=actualNativeRuntime(new URL("../../../",import.meta.url).pathname,true);
  const root=mkdtempSync("/tmp/hygiene-auth-gate-");let physical=0;
  const server=Bun.serve({hostname:"127.0.0.1",port:0,fetch(request){if(new URL(request.url).pathname!=="/v1/messages")return Response.json({});physical++;return response(physical);}});
  const controller=new AbortController(),receipt:any={promptReleased:false,settingsChecked:false};
  let child:ChildProcess|undefined,closed:Promise<void>|undefined;let stdoutComplete=false,forcedKill=false;
  const raw=join(root,"stdout.jsonl");writeFileSync(raw,"",{mode:0o600});
  let resolveHandle!:(value:any)=>void;const handle=new Promise(resolve=>resolveHandle=resolve);let cli:any,failure:unknown;
  const timer=setTimeout(()=>controller.abort(),5000);
  try{
    cli=query({prompt:protectedPrompt(handle,"Controlled prompt must never reach a model.",receipt,()=>{},controller),options:{cwd:root,settingSources:[],settings:{apiKeyHelper:"printf not-a-real-api-key",autoMemoryEnabled:false},model:runtime.model,tools:[],maxTurns:1,persistSession:false,abortController:controller,
      spawnClaudeCodeProcess(options){
        assert.equal(realpathSync(options.command),pair.native,"Auth proof must use the exact verified SDK/native pair");
        child=spawn(options.command,options.args,{env:options.env,cwd:options.cwd,stdio:["pipe","pipe","pipe"]});
        const capture=captureNative(raw,()=>{},()=>stdoutComplete=true);child.stdout!.pipe(capture);Object.defineProperty(child,"stdout",{value:capture});child.stderr!.resume();
        closed=new Promise(resolve=>child!.once("close",()=>resolve()));return child as any;
      },
      env:{...CLEARED_API_CREDENTIALS,PATH:process.env.PATH,HOME:root,CLAUDE_CONFIG_DIR:join(root,".claude"),ANTHROPIC_BASE_URL:`http://127.0.0.1:${server.port}`,CLAUDE_CODE_OAUTH_TOKEN:`sk-ant-oat01-${"o".repeat(95)}AA`,ANTHROPIC_DEFAULT_HAIKU_MODEL:runtime.model,ANTHROPIC_SMALL_FAST_MODEL:runtime.model,CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC:"1"}}});
    resolveHandle(cli);try{for await(const _frame of cli){}}catch(error){failure=error;}
    assert.equal(receipt.promptReleased,false,"Protected prompt must remain held under actual helper-auth initialization/settings");
    assert.equal(physical,0,"No actual model request may escape the subscription-only gate");
    assert.ok(receipt.accountRoute,"Actual initialize handshake was observed");
    assert.equal(receipt.settingsChecked,false,"Actual effective helper settings were rejected");
    assert.ok(failure,"SDK turn terminates on protected handshake refusal");
    console.log(JSON.stringify({passed:true,actualNative:true,sdk:pair.sdk,cli:pair.cli,modelRequests:physical,promptReleased:false,effectiveHelperRefused:true}));
  }finally{clearTimeout(timer);cli?.close();if(child&&closed){forcedKill=(await drainOwned(child,closed)).forcedKill;}
    assert.equal(stdoutComplete,true,"Actual native stdout must end before cleanup");assert.equal(forcedKill,false,"Actual refused native child must drain without forced kill");
    server.stop(true);rmSync(root,{recursive:true,force:true});}
}
if(import.meta.main)await main();
