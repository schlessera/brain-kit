import { describe, expect, test } from "bun:test";
import {createHash} from "node:crypto";
import {createPiSchemaReplay} from "../scripts/pi-schema-replay.ts";
import { mkdtempSync, cpSync, mkdirSync, readFileSync, writeFileSync, symlinkSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { measurementSchema, measurementForm, nativeCredential, replaceExactly, PI_SCHEMA_ARMS, PI_SCHEMA_PROMPT, measurementFixtureGuard } from "../scripts/pi-schema-measurement.ts";
import { SCHEMA_ARMS } from "../scripts/show-block-schema-forms.ts";
import { showBlockInputSchema } from "../packages/ui-sdk/src/tool-contracts/blocks.ts";
import { toolInputJsonSchema, SHOW_BLOCK_DESCRIPTION } from "@schlessera/brain-ui-sdk/server";
import { validatePiSchemaRequest, validateTerminalUsage, observeCodexBilling } from "../scripts/pi-schema-capture.ts";

describe("Pi schema measurement admission", () => {
  test("named forms carry populated draft-2020-12 definitions and exact actual request parameters", () => {
    expect(measurementForm("flat")).toBe("flat");
    expect(() => measurementForm("other")).toThrow();
    for (const form of ["flat", "shared", "shared-trimmed"] as const) {
      const parameters = toolInputJsonSchema(measurementSchema(form));
      expect(PI_SCHEMA_ARMS[form]).toEqual(SCHEMA_ARMS[form]);
      expect(JSON.stringify(parameters)).toBe(JSON.stringify(toolInputJsonSchema(showBlockInputSchema(SCHEMA_ARMS[form]))));
      const definitions = parameters.$defs as Record<string, unknown> | undefined;
      expect(Object.keys(definitions ?? {}).length).toBe(form === "flat" ? 0 : 3);
      const body = { model: "offline-model", input:[{role:"user",content:[{type:"input_text",text:PI_SCHEMA_PROMPT}]}], tools: [{ type: "function", name: "show_block", strict: null, description: SHOW_BLOCK_DESCRIPTION, parameters }] };
      expect(() => validatePiSchemaRequest(body, "offline-model", parameters)).not.toThrow();
      expect(() => validatePiSchemaRequest({ ...body, model: "other" }, "offline-model", parameters)).toThrow();
      expect(() => validatePiSchemaRequest({ ...body, input:[{role:"user",content:[{type:"input_text",text:"unreviewed text"}]}] }, "offline-model", parameters)).toThrow();
      expect(() => validatePiSchemaRequest({ ...body, tools: [{ ...body.tools[0], parameters: {} }] }, "offline-model", parameters)).toThrow();
    }
  });
  test("source anchors, alternate credentials, expiry and account mismatch fail closed", () => {
    expect(replaceExactly("a a", "a", "b", 2)).toBe("b b");
    expect(() => replaceExactly("a", "a", "b", 2)).toThrow();
    expect(() => nativeCredential({})).toThrow();
    const token = (exp: number, id: string) => `offline.${Buffer.from(JSON.stringify({ exp, "https://api.openai.com/auth": { chatgpt_account_id: id } })).toString("base64url")}.fictional`;
    const env = { BRAIN_MEASURE_CODEX_ACCESS_TOKEN: token(Date.now() / 1000 + 3600, "fictional-account"), BRAIN_MEASURE_CODEX_ACCOUNT_ID: "fictional-account" };
    expect(nativeCredential(env).type).toBe("oauth");
    expect(() => nativeCredential({ ...env, OPENAI_API_KEY: "offline-key" })).toThrow();
    expect(() => nativeCredential({ ...env, BRAIN_MEASURE_CODEX_ACCOUNT_ID: "other-account" })).toThrow();
    expect(() => nativeCredential({ ...env, BRAIN_MEASURE_CODEX_ACCESS_TOKEN: token(0, "fictional-account") })).toThrow();
  });
});

test("reviewed prompt reuse is byte-identical and unknown terminal counters are rejected", () => {
  const snapshot = JSON.parse(readFileSync("scripts/measurements/suggestions-2026-10-07/input-review-snapshot.json", "utf8"));
  expect(PI_SCHEMA_PROMPT).toBe(snapshot.prompts.find((row:any)=>row.id==="note-approaches").text);
  const usage={input_tokens:120,output_tokens:24,total_tokens:144,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}};
  expect(()=>validateTerminalUsage(usage)).not.toThrow();
  for (const bad of [null,{}, {...usage,input_tokens:.5},{...usage,total_tokens:1},{...usage,input_tokens_details:{}},{...usage,output_tokens_details:{reasoning_tokens:25}}]) expect(()=>validateTerminalUsage(bad)).toThrow("Codex terminal usage is unknown.");
});

test("actual inline tool admission refuses shell/writes and outside symlink reads", async () => {
  const scratch=mkdtempSync(join(tmpdir(),"pi-schema-guard-"));
  try {
    writeFileSync(join(scratch,"inside.md"),"Odysseus");
    symlinkSync("/etc/hostname",join(scratch,"outside.md"));
    let handler:any;const extension=measurementFixtureGuard(scratch);
    if (typeof extension === "function") throw new Error("Named inline measurement extension expected.");
    extension.factory({on(_name:string,fn:any){handler=fn;}} as any);
    expect(await handler({toolName:"show_block",input:{}})).toBeUndefined();
    expect(await handler({toolName:"read_file",input:{path:"inside.md"}})).toBeUndefined();
    expect((await handler({toolName:"bash",input:{command:"printf unsafe"}})).block).toBe(true);
    expect((await handler({toolName:"write_file",input:{path:"inside.md"}})).block).toBe(true);
    expect((await handler({toolName:"read_file",input:{path:"outside.md"}})).block).toBe(true);
    expect(readFileSync(join(scratch,"inside.md"),"utf8")).toBe("Odysseus");
  } finally {rmSync(scratch,{recursive:true,force:true});}
});

test("source-backed included-limit and rejected-usage snapshots persist stops without paid-charge attribution",()=>{
  const scratch=mkdtempSync(join(tmpdir(),"pi-billing-snapshots-"));
  try {for(const [id,event] of [["limit",{type:"codex.rate_limits",rate_limit_reached_type:"workspace_member_usage_limit_reached"}],["error",{type:"error",error:{code:"usage_not_included"}}]] as const){const p=join(scratch,id);expect(observeCodexBilling({event},p)).toContain("Included-only unresolved");expect(observeCodexBilling({headers:{}},p)).toContain("Included-only unresolved");}}
  finally {rmSync(scratch,{recursive:true,force:true});}
});

for (const [form,mode] of [["flat",null],["shared",null],["shared-trimmed",null],["shared","model"],["shared","eof"],["shared","usage"],["shared","invalid-block"],["shared","fixture-tools"],["shared","tool-guard"],["shared","billing-header"],["shared","billing-event"],["shared","credit-metadata"],["shared","media-type-absent"],["shared","media-type-octet"],["shared","not-sse"],["shared","binary-error"],["shared","late-eof"],["shared","preterminal-cancel"],["shared","late-eof-final"]] as const) {
  test(`real Pi/server ${form}/${mode??"accepted"}: exact receipt and parsed handler acceptance`, async () => {
    const scratch = mkdtempSync(join(tmpdir(), "pi-schema-native-"));
    const brain = join(scratch, "brain");
    cpSync("packages/core/fixtures/corpus", brain, { recursive: true });
    for (const name of ["home", "pi", "receipts"]) mkdirSync(join(scratch, name));
    const child = Bun.spawn([process.execPath, "--preload", resolve("scripts/pi-schema-offline-preload.ts"), "--preload", resolve("scripts/pi-schema-preload.ts"), resolve("scripts/measure-pi-schema.ts"), "--brain", brain, "--out", join(scratch, "result.json")], {
      cwd: process.cwd(), env: { PATH: process.env.PATH!, HOME: join(scratch, "home"), PI_CODING_AGENT_DIR: join(scratch, "pi"), BRAIN_MEASURE_PI_SCHEMA_FORM: form, BRAIN_MEASURE_PI_RECEIPTS: join(scratch, "receipts"), ...(mode?{BRAIN_MEASURE_PI_OFFLINE_MUTATION:mode}:{}) }, stdout: "pipe", stderr: "pipe",
    });
    const stdout = new Response(child.stdout).text();
    const stderr = new Response(child.stderr).text();
    const processDeadline=setTimeout(()=>child.kill("SIGKILL"),60_000);
    try {
      const status = await child.exited;
      const rawDiagnostic = existsSync(join(scratch, "receipts/physical-requests.json")) ? readFileSync(join(scratch, "receipts/physical-requests.json"), "utf8") : "No native request";
      const rejected=mode&&!["fixture-tools","tool-guard","credit-metadata","media-type-absent","media-type-octet","late-eof","late-eof-final"].includes(mode);
      if(mode==="billing-header"||mode==="billing-event")expect(JSON.parse(rawDiagnostic),"known included-only stop must block the next actual physical request").toHaveLength(1);
      const nativeSummary=rawDiagnostic==="No native request"?rawDiagnostic:JSON.stringify(JSON.parse(rawDiagnostic).map((row:any)=>({sequence:row.sequence,status:row.status,terminal:row.terminal,eof:row.eof,error:row.error})));
      expect(status, `${await stdout}\n${await stderr}\n${nativeSummary}`).toBe(rejected?1:0);
      const result = JSON.parse(readFileSync(join(scratch, "result.json"), "utf8"));
      if (rejected) {
        const requests=JSON.parse(rawDiagnostic);
        expect(requests.length).toBeGreaterThan(0);
        if(mode==="billing-header"||mode==="billing-event"){
          expect(requests,"known included-only stop must block the next actual physical request").toHaveLength(1);
          expect(existsSync(join(scratch,"receipts/sentinel-2.sse"))).toBe(false);
          const billing=JSON.parse(readFileSync(join(scratch,"receipts/billing-state.json"),"utf8"));
          expect(billing.stop).toContain("Included-only unresolved");
          expect(billing.stop).toContain(mode==="billing-header"?"exhausted":"balance decreased");
          expect(result.record.completed).toBe(false);expect(requests[0].usage.output_tokens).toBe(24);
          return;
        }
        if(mode==="preterminal-cancel"){
          expect(requests).toHaveLength(1);expect(requests[0].terminal).toBe(false);expect(requests[0].eof,"cancel-generated done must never count as natural upstream EOF").toBe(false);expect(requests[0].usage).toBeNull();expect(requests[0].error).toContain("Consumer cancelled before completed terminal");expect(requests[0].streamLifecycle.some((event:any)=>event.event==="consumer-cancelled"&&!event.afterTerminal)).toBe(true);expect(requests[0].streamLifecycle.some((event:any)=>event.event==="natural-upstream-eof")).toBe(false);expect(readFileSync(join(scratch,"receipts/physical-1.sse")).length).toBeLessThan(readFileSync(join(scratch,"receipts/sentinel-1.sse")).length);return;
        }
        if(mode==="binary-error"){
          expect(requests).toHaveLength(1);expect(requests[0].status).toBe(503);expect(requests[0].usage).toBeNull();expect(result.record.completed).toBe(false);expect(result.billing.additionalBilledUsd).toBeNull();
          const raw=readFileSync(join(scratch,"receipts/physical-1.error-body"));
          expect(raw,"failed native response must retain literal invalid-UTF8/NUL bytes before decoding").toEqual(Buffer.from([0xff,0x00,0xc3,0x28,0x4f,0x64,0x79,0x73,0x73,0x65,0x75,0x73]));
          expect(raw).toEqual(readFileSync(join(scratch,"receipts/sentinel-1.sse")));return;
        }
        expect(requests[0].usage).toEqual(mode==="usage"||mode==="eof"||mode==="not-sse"?null:{input_tokens:120,output_tokens:24,total_tokens:144,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}});
        if (mode==="invalid-block") {expect(result.record.completed).toBe(true);expect(result.record.showBlockCalls).toEqual([{kind:"comparison",ok:false}]);}
        else {expect(result.record.completed).toBe(false);expect(requests[0].terminal).toBe(false);expect(String(requests[0].error)).toContain(mode==="model"?"model mismatch":mode==="usage"?"usage is unknown":"EOF before completed");}
        expect(readFileSync(join(scratch,"receipts/physical-1.sse"))).toEqual(readFileSync(join(scratch,"receipts/sentinel-1.sse")));
        return;
      }
      expect(result.record.completed,"successful SSE with compatible media type must complete the actual turn").toBe(true);
      expect(result.record.showBlockCalls).toEqual([{ kind: "comparison", ok: true }]);
      const requests = JSON.parse(readFileSync(join(scratch, "receipts/physical-requests.json"), "utf8"));
      expect(requests).toHaveLength(mode==="fixture-tools"?4:mode==="tool-guard"?3:2);
      for (const row of requests) { expect(row.terminal).toBe(true); expect(row.eof).toBe(true); expect(row.error).toBeNull(); expect(row.auth.bearerMatchesNativeAccess).toBe(true); expect(row.servedModel).toBe("gpt-6.1-sol"); expect(row.wireSha256).toBe(readFileSync(join(scratch, `receipts/sentinel-${row.sequence}-wire-sha.txt`),"utf8")); expect(readFileSync(join(scratch, `receipts/physical-${row.sequence}.sse`))).toEqual(readFileSync(join(scratch, `receipts/sentinel-${row.sequence}.sse`))); }
      if(mode==="late-eof"||mode==="late-eof-final")for(const row of requests){const events=row.streamLifecycle;expect(events.some((event:any)=>event.event==="consumer-cancelled"&&event.afterTerminal)).toBe(true);expect(events.filter((event:any)=>event.event==="natural-upstream-eof")).toHaveLength(1);expect(events.findIndex((event:any)=>event.event==="consumer-cancelled")).toBeLessThan(events.findIndex((event:any)=>event.event==="natural-upstream-eof"));}
      if(mode==="media-type-absent")expect(requests.every((row:any)=>!("content-type" in row.headers))).toBe(true);
      if(mode==="media-type-octet")expect(requests.every((row:any)=>row.headers["content-type"]==="application/octet-stream")).toBe(true);
      expect(requests.find((row:any)=>row.functionCalls.some((call:any)=>call.name==="show_block"))).toBeTruthy();
      const index=JSON.parse(readFileSync(join(scratch,"receipts/fixture-index.json"),"utf8"));
      expect(index.exit).toBe(0);
      expect(index.stdout.length).toBeGreaterThan(10);
      if(mode==="fixture-tools") {expect(result.record.toolNames).toContain("brain_list");expect(result.record.toolNames).toContain("brain_read");}
      if(mode==="credit-metadata"){const billing=JSON.parse(readFileSync(join(scratch,"receipts/billing-state.json"),"utf8"));expect(billing.stop).toBeNull();expect(billing.balance).toBe(100);expect(result.billing.additionalBilledUsd).toBeNull();}
      if(mode==="tool-guard") {expect(existsSync(join(brain,"forbidden-write.txt")),"actual blocked shell must not write its fixture").toBe(false);const admission=readFileSync(join(scratch,"receipts/tool-admission.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line));expect(admission.find((row:any)=>row.toolName==="bash").allowed).toBe(false);}
      expect(result.record.textParts.join(" ")).toContain("⚓");
    } finally { clearTimeout(processDeadline);if(child.exitCode===null){child.kill();await child.exited;}rmSync(scratch, { recursive: true, force: true }); }
  }, 90_000);
}


test("replay prefix hashes, exact original context and real handler-result history are mandatory",()=>{
  const scratch=mkdtempSync(join(tmpdir(),"pi-schema-replay-"));
  try{
    const dir=join(scratch,"flat/receipts");mkdirSync(dir,{recursive:true});
    const block={block:{kind:"comparison",columns:[{label:"Journal"},{label:"Topic"}],rows:[{label:"Use",cells:["Voyage events","Distilled themes"]}]}};
    const call={type:"function_call",name:"show_block",call_id:"call_odysseus",arguments:JSON.stringify(block)};
    const request={model:"gpt-6.1-sol",instructions:"Help Odysseus compare knowledge organization.",input:[{role:"user",content:[{type:"input_text",text:PI_SCHEMA_PROMPT}]}],tools:[{type:"function",name:"show_block",strict:null,description:SHOW_BLOCK_DESCRIPTION,parameters:toolInputJsonSchema(measurementSchema("flat"))}],prompt_cache_key:"fictional-original-session"};
    const original={sequence:1,form:"flat",status:200,requestedModel:"gpt-6.1-sol",route:"native-codex-subscription",auth:{bearerMatchesNativeAccess:true,accountHeaderMatchesNativeClaim:true,originator:"pi"},request,wireSha256:"fictional-wire-hash",encoding:"zstd",headers:{},error:"fictional old observer media-type rejection"};
    const raw=`data: ${JSON.stringify({type:"response.completed",response:{model:"gpt-6.1-sol",status:"completed",output:[call],usage:{input_tokens:120,output_tokens:24,total_tokens:144,input_tokens_details:{cached_tokens:0},output_tokens_details:{reasoning_tokens:0}}}})}`;
    const receiptBytes=JSON.stringify([original]);writeFileSync(join(dir,"physical-requests.json"),receiptBytes);writeFileSync(join(dir,"physical-1.error-body"),raw);
    const hash=(bytes:string)=>createHash("sha256").update(bytes).digest("hex");
    const expected={receiptSha256:hash(receiptBytes),rawSha256:hash(raw)};
    expect(()=>createPiSchemaReplay(scratch,{...expected,rawSha256:"wrong"},join(scratch,"wrong.log"))).toThrow("prefix hash mismatch");
    const fresh=()=>createPiSchemaReplay(scratch,expected,join(scratch,"replay.jsonl"));
    expect(()=>fresh().beforeRequest({...request,instructions:"Changed semantic context"},"newwire")).toThrow("semantic context");
    const replay=fresh();const first=replay.beforeRequest({...request,prompt_cache_key:"fictional-new-session"},"newwire")!;
    expect(first.provenance.kind).toBe("recovered-original-physical");expect(first.provenance.unchangedRequestWire).toBe(false);expect(first.provenance.sameServerSession).toBe(false);expect(first.provenance.originalObserverError).toBe(original.error);
    const continuation={...request,prompt_cache_key:"fictional-new-session",input:[...request.input,call,{type:"function_call_output",call_id:call.call_id,output:JSON.stringify(block)}]};
    expect(()=>replay.beforeRequest({...continuation,input:request.input},"missinghistory")).toThrow("original call");
    expect(()=>replay.beforeRequest({...continuation,input:[...request.input,{...call,arguments:"{}"},{type:"function_call_output",call_id:call.call_id,output:JSON.stringify(block)}]},"changedcall")).toThrow("original call");
    expect(()=>replay.beforeRequest({...continuation,input:[...request.input,call,{type:"function_call_output",call_id:call.call_id,output:"{}"}]},"changedresult")).toThrow("original call");
    expect(replay.beforeRequest(continuation,"continuedwire")).toBeNull();
    expect(()=>replay.beforeRequest(continuation,"fifthcontinuation")).toThrow("Continuation bound");
    const rows=readFileSync(join(scratch,"replay.jsonl"),"utf8").trim().split("\n").map(line=>JSON.parse(line));
    expect(rows.filter(row=>row.event==="prefix-replayed-once")).toHaveLength(1);expect(rows.filter(row=>row.event==="continuation-admitted")).toHaveLength(1);expect(rows.find(row=>row.event==="continuation-admitted").externalProviderDispatchAdmitted).toBe(true);expect(rows.find(row=>row.event==="continuation-admitted").externalProviderDispatch).toBeUndefined();
  }finally{rmSync(scratch,{recursive:true,force:true});}
});
