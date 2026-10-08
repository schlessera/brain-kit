import {test,expect} from "bun:test";
import {createHash} from "node:crypto";
import {rawTee,NativeEvidence} from "../scripts/evals/candidate-extraction/native-evidence";
import {physicalAccounting} from "../scripts/evals/candidate-extraction/native-accounting";
import {validateNativeProof} from "../scripts/evals/candidate-extraction/native-proof";
const sha=(v:string)=>createHash("sha256").update(v).digest("hex");
function physical(){const request=JSON.stringify({model:"claude-sonnet-5-5"}),response=[{type:"message_start",message:{model:"claude-sonnet-5-5",usage:{input_tokens:17,output_tokens:1,cache_read_input_tokens:0,cache_creation_input_tokens:0}}},{type:"message_delta",usage:{output_tokens:23}},{type:"message_stop"}].map(v=>`data: ${JSON.stringify(v)}\n\n`).join("");return {path:"/v1/messages",status:200,naturalEof:true,requestSha:sha(request),responseSha:sha(response),requestBase64:Buffer.from(request).toString("base64"),responseBase64:Buffer.from(response).toString("base64")};}
const native=[{model:"claude-sonnet-5-5",input:17,output:23,cacheRead:0,cacheWrite:0}];
test("terminal physical output23 reconciles to native; provisional1 never completes",()=>{
 const call=physical(),actual=physicalAccounting([call],native);expect(actual.knownTokenSubtotal.output).toBe(23);expect(actual.complete).toBe(true);expect(actual.rows[0]!.diagnostic).not.toBeNull();expect(actual.actualInvoiceUsd).toBeNull();
 expect(physicalAccounting([call],[{...native[0]!,output:1}]).complete).toBe(false);
 expect(physicalAccounting([],native).complete).toBe(false);
 for(const change of [{naturalEof:false},{status:500},{responseBase64:Buffer.from("malformed").toString("base64")},{requestSha:"changed"}])expect(physicalAccounting([{...call,...change}],native).complete).toBe(false);
 const failed=physicalAccounting([{...call,status:500}],native);expect(failed.rows[0]!.diagnostic).not.toBeNull();expect(failed.complete).toBe(false);
});
test("native tee preserves split UTF8 and final unterminated error frame",async()=>{
 const text=JSON.stringify({type:"result",is_error:true,errors:["Athena’s 🌊 control"]}),bytes=Buffer.from(text),at=bytes.indexOf(Buffer.from("🌊")),retained:Buffer[]=[],lines:string[]=[];
 const tee=rawTee(b=>retained.push(b),s=>lines.push(s));tee.resume();tee.write(bytes.subarray(0,at+1));tee.write(bytes.subarray(at+1,at+3));tee.end(bytes.subarray(at+3));await new Promise<void>((resolve,reject)=>{tee.once("finish",resolve);tee.once("error",reject);});
 expect(Buffer.concat(retained)).toEqual(bytes);expect(lines).toEqual([text]);expect(JSON.parse(lines[0]!).is_error).toBe(true);
});
test("actual native sentinel nonzero error close retains raw result after reader throws",async()=>{
 const evidence=new NativeEvidence(),text=JSON.stringify({type:"result",subtype:"error_during_execution",is_error:true,errors:["controlled-error"]});
 const child=evidence.spawn({command:process.execPath,args:["-e",`process.stdout.write(${JSON.stringify(text)});process.exitCode=1;`],cwd:process.cwd(),env:{PATH:process.env.PATH}} as any);
 try{for await(const _ of child.stdout)throw Error("controlled-reader-error");}catch{}
 expect(await evidence.drain()).toBe(true);expect(evidence.rawBytes().toString("utf8")).toBe(text);expect(evidence.native.processes[0]?.code).toBe(1);expect(evidence.native.results[0]?.is_error).toBe(true);expect(evidence.accounting().complete).toBe(false);
});
test("complete fixture format is reparsed; flags cannot hide disk writes, EOF or no-tools roster drift",()=>{
 const runs=["cfp-tools","job-tools","no-tools","review"].map((mode,i)=>{
  const messages=[{role:"user",content:[{type:"tool_result",is_error:true,content:"denies writes and outside reads"},{type:"tool_result",is_error:true,content:"denies writes and outside reads"}]}];
  const request=JSON.stringify({model:"claude-sonnet-5-5",tools:i<2?[{name:"Read"},{name:"Write"}]:[],messages}),n=i<2?4:1,call={...physical(),requestBase64:Buffer.from(request).toString("base64"),requestSha:sha(request)};
  const result={type:"result",is_error:false,subtype:"success",modelUsage:{"claude-sonnet-5-5":{inputTokens:n*17,outputTokens:n*23,cacheReadInputTokens:0,cacheCreationInputTokens:0}}};
  const init={type:"system",subtype:"init",model:"claude-sonnet-5-5",claude_code_version:"2.1.293"};
  return {mode,error:null,semanticApproval:false,reviewAdmission:false,writeAuthority:false,coreAutoMeasured:false,before:{owner:"unchanged"},after:{owner:"unchanged"},processes:[{code:0,signal:null,closed:true,stdoutFinished:true,forcedKill:false,error:null}],physical:Array.from({length:n},()=>({...call})),result,rawStdoutBase64:Buffer.from([init,result].map(f=>JSON.stringify(f)).join("\n")).toString("base64")};
 });
 const proof={sdk:"0.3.293",failure:null,drained:true,runs};expect(validateNativeProof(proof)).toBe(true);
 const written=structuredClone(proof);written.runs[0]!.after.owner="overwritten";expect(validateNativeProof(written)).toBe(false);
 const eof=structuredClone(proof);eof.runs[0]!.physical[0]!.naturalEof=false;expect(validateNativeProof(eof)).toBe(false);
 const tools=structuredClone(proof),request=JSON.stringify({model:"claude-sonnet-5-5",tools:[{name:"Write"}]});tools.runs[2]!.physical[0]!.requestBase64=Buffer.from(request).toString("base64");tools.runs[2]!.physical[0]!.requestSha=sha(request);expect(validateNativeProof(tools)).toBe(false);
});
