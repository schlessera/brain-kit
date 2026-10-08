/** Reparse terminal physical body usage; positive request counts never replace receipts. */
import { createHash } from "node:crypto";
import { priceSonnet55Usage } from "../../measure-sonnet55-cost";
const sha=(v:Buffer)=>createHash("sha256").update(v).digest("hex");
const counter=(v:unknown):number|null=>typeof v==="number"&&Number.isSafeInteger(v)&&v>=0?v:null;
export function physicalAccounting(calls:Array<Record<string,any>>,native:Array<{model:string,input:number|null,output:number|null,cacheRead:number|null,cacheWrite:number|null}>){
 const rows=calls.map(c=>{
  try{const request=Buffer.from(c.requestBase64,"base64"),bytes=Buffer.from(c.responseBase64,"base64"),body=JSON.parse(request.toString("utf8"));
   if(sha(request)!==c.requestSha||sha(bytes)!==c.responseSha)throw Error("physical bytes changed");
   const frames=new TextDecoder("utf8",{fatal:true}).decode(bytes).replaceAll("\r\n","\n").split("\n\n").flatMap(f=>{
    const data=f.split("\n").filter(l=>l.startsWith("data: ")).map(l=>l.slice(6)).join("\n");return data?[JSON.parse(data)]:[];});
   const starts=frames.filter(f=>f.type==="message_start"),deltas=frames.filter(f=>f.type==="message_delta"&&f.usage),stops=frames.filter(f=>f.type==="message_stop");
   const start=starts[0]?.message,terminal=deltas.at(-1)?.usage,usage={input:counter(start?.usage?.input_tokens),output:counter(terminal?.output_tokens),cacheRead:counter(start?.usage?.cache_read_input_tokens),cacheWrite:counter(start?.usage?.cache_creation_input_tokens)};
   const tokensKnown=starts.length===1&&[usage.input,usage.output,usage.cacheRead,usage.cacheWrite].every(v=>v!==null)&&body.model==="claude-sonnet-5-5"&&start?.model===body.model;
   const diagnostic=tokensKnown?priceSonnet55Usage({modelUsage:{"claude-sonnet-5-5":{inputTokens:usage.input!,outputTokens:usage.output!,cacheReadInputTokens:usage.cacheRead!,cacheCreationInputTokens:usage.cacheWrite!}}}):null;
   return {complete:tokensKnown&&c.path==="/v1/messages"&&c.status===200&&c.naturalEof===true&&stops.length===1,model:start?.model??null,...usage,diagnostic,actualInvoiceUsd:null};
  }catch(error){return {complete:false,model:null,input:null,output:null,cacheRead:null,cacheWrite:null,diagnostic:null,actualInvoiceUsd:null,error:String(error)};}
 });
 const sums={input:0,output:0,cacheRead:0,cacheWrite:0};for(const r of rows)for(const key of Object.keys(sums) as Array<keyof typeof sums>)sums[key]+=r[key]??0;
 const reconciled=native.length===1&&native[0]?.model==="claude-sonnet-5-5"&&(Object.keys(sums) as Array<keyof typeof sums>).every(k=>native[0]![k]===sums[k]);
 return {complete:rows.length>0&&rows.every(r=>r.complete)&&reconciled,physicalRequests:rows.length,rows,knownTokenSubtotal:sums,reconciled,actualInvoiceUsd:null};
}
