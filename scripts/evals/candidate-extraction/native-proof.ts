/** Rebuild manual fixture evidence from literal native/physical bodies, not approval flags. */
import { physicalAccounting } from "./native-accounting";
export function validateNativeProof(proof:any){
 try{
  if(proof.sdk!=="0.3.293"||proof.failure!==null||proof.drained!==true||proof.runs?.length!==4)return false;
  const modes=["cfp-tools","job-tools","no-tools","review"];
  return proof.runs.every((r:any,i:number)=>{
   if(r.mode!==modes[i]||r.error!==null||r.semanticApproval!==false||r.reviewAdmission!==false||r.writeAuthority!==false||r.coreAutoMeasured!==false||JSON.stringify(r.before)!==JSON.stringify(r.after)||r.processes?.length!==1||r.processes.some((p:any)=>p.code!==0||p.signal!==null||!p.closed||!p.stdoutFinished||p.forcedKill||p.error!==null))return false;
   const frames=new TextDecoder("utf8",{fatal:true}).decode(Buffer.from(r.rawStdoutBase64,"base64")).split("\n").filter(s=>s.trim()).map(s=>JSON.parse(s));
   const results=frames.filter(f=>f.type==="result"),inits=frames.filter(f=>f.type==="system"&&f.subtype==="init"),result=results[0],init=inits[0];
   if(results.length!==1||inits.length!==1||result.is_error!==false||result.subtype!=="success"||init.model!=="claude-sonnet-5-5"||init.claude_code_version!=="2.1.293"||JSON.stringify(result)!==JSON.stringify(r.result))return false;
   const usage=result.modelUsage;if(!usage||Object.keys(usage).length!==1||!usage["claude-sonnet-5-5"])return false;
   const rows=Object.entries(usage).map(([model,v])=>{const u=v as any;return{model,input:u.inputTokens,output:u.outputTokens,cacheRead:u.cacheReadInputTokens,cacheWrite:u.cacheCreationInputTokens};});
   if(!physicalAccounting(r.physical,rows).complete||r.physical.length!==(i<2?4:1))return false;
   for(const c of r.physical){const request=JSON.parse(Buffer.from(c.requestBase64,"base64").toString("utf8"));
    const names=(request.tools??[]).map((t:any)=>t.name).sort();if(JSON.stringify(names)!==JSON.stringify(i<2?["Read","Write"]:[]))return false;}
   if(i<2){const last=JSON.parse(Buffer.from(r.physical.at(-1).requestBase64,"base64").toString("utf8"));const blocks=last.messages.flatMap((m:any)=>Array.isArray(m.content)?m.content:[]);
    const failed=blocks.filter((b:any)=>b.type==="tool_result"&&b.is_error===true&&typeof b.content==="string"&&b.content.includes("denies writes and outside reads"));if(failed.length!==2)return false;}
   return true;
  });
 }catch{return false;}
}
