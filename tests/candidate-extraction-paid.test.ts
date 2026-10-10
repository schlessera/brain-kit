import {expect,test} from "bun:test";
import {mkdtempSync,readFileSync,readlinkSync,rmSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {extractionPaidFreeze,openExtractionPaid} from "../scripts/evals/candidate-extraction/paid";
import {validateExtractionPaidArtifacts} from "../scripts/evals/candidate-extraction/paid-evidence";
import {digest} from "../scripts/evals/native-paid-policy";
import {NativeEvidence} from "../scripts/evals/candidate-extraction/native-evidence";

for(const newline of [true,false])test(`extraction native USER guard precedes forwarding, including EOF=${!newline}`,async()=>{
  const observer=new NativeEvidence(()=>{throw Error("controlled Root refusal before USER");});
  const script='process.stdin.on("data",chunk=>process.stdout.write(chunk));process.stdin.on("end",()=>process.exit());';
  const child=observer.spawn({command:process.execPath,args:["-e",script],cwd:process.cwd(),env:{PATH:"/usr/bin:/bin"},signal:new AbortController().signal});
  const input=JSON.stringify({type:"user",message:{role:"user",content:"CONTROLLED_USER_SENTINEL"}})+(newline?"\n":"");
  child.stdin.end(input);child.stdout.resume();await observer.drain();
  expect(observer.rawInput().toString()).toBe(input);
  expect(observer.rawBytes().toString()).not.toContain("CONTROLLED_USER_SENTINEL");
  expect(observer.native.processes[0]!.error).toContain("controlled Root refusal before USER");
  expect(observer.native.processes[0]!.closed).toBe(true);
});
for(const mode of ["paid-extra","paid-inactive","paid-rejected","paid-http402","paid-http429","paid-missing","paid-wrong-model","paid-partial"]){
 test(`actual native293 extraction ${mode} retains Root accounting and bounded closure`,async()=>{
  const root=mkdtempSync(join(tmpdir(),"extraction-paid-test-")),output=join(root,"receipt");
  try{
    const command=['ip link set lo up && exec setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all "$@"'];
    const child=Bun.spawn(["unshare","--user","--map-current-user","--keep-caps","--net","sh","-c",command[0]!,"extraction-paid",process.execPath,
      "scripts/evals/candidate-extraction/paid-offline.ts",mode,output],{cwd:process.cwd(),env:{PATH:`${join(process.execPath,"..")}:/usr/bin:/bin`,BRAIN_EXTRACTION_OFFLINE:"1",BRAIN_EXTRACTION_PARENT_NET:readlinkSync("/proc/self/ns/net")},stdout:"pipe",stderr:"pipe"});
    const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect({exit,stdout,stderr}).toMatchObject({exit:0});
    const c=JSON.parse(readFileSync(join(output,"control.json"),"utf8")),r=JSON.parse(readFileSync(join(output,"receipt.json"),"utf8"));
    expect(c).toMatchObject({passed:true,forwarded:1,semanticApproval:false,providerRequests:0});
    expect(r.paid.policy).toMatchObject({issue:849,control:"offline",purpose:"review",perIssueCapUsd:15,aggregateCapUsd:150,invoiceUsd:null});
    expect(r.paid.entries).toHaveLength(1);expect(r.paid.entries[0].reservedUpperUsd).toBeGreaterThanOrEqual(8);
    expect(r.processes.every((p:any)=>p.closed&&p.stdoutFinished)).toBe(true);
    if(mode==="paid-extra"){
      expect(validateExtractionPaidArtifacts(output)).toBe(true);
      const path=join(output,"receipt.json"),raw=readFileSync(path);
      for(const change of [(v:any)=>{v.account.tokenSource="ANTHROPIC_API_KEY";},(v:any)=>{v.paid.entries[0].pricedUpperUsd=0;},(v:any)=>{v.raw.stdinSha=digest("wrong stdin");}]){
        const value=JSON.parse(raw.toString());change(value);writeFileSync(path,JSON.stringify(value));
        expect(validateExtractionPaidArtifacts(output)).toBe(false);writeFileSync(path,raw);
      }
      expect(validateExtractionPaidArtifacts(output)).toBe(true);
    }
  }finally{rmSync(root,{recursive:true,force:true});}
 },30000);
}

test("extraction paid adapter binds actual complete closure and refuses absent live proof",()=>{
  const root=mkdtempSync(join(tmpdir(),"extraction-paid-binding-"));
  try{
    const frozen=extractionPaidFreeze(),prompt="Odysseus independent source guard";
    expect(()=>openExtractionPaid({output:root,prompt,frozen,offline:false})).toThrow("Explicit protected native authority file required");
    const stale={...frozen,freezeSha:digest("wrong complete source")};
    const paid=openExtractionPaid({output:root,prompt,frozen:stale,offline:true});
    expect(()=>paid.verify()).toThrow("Complete extraction source/runtime changed before paid forwarding");
    const policy=paid.evidence.policy;
    expect(()=>openExtractionPaid({output:root,prompt,frozen,offline:true,offlinePolicy:{...policy,expiresAt:policy.issuedAt}})).toThrow("Missing, stale or mismatched root native paid allocation");
  }finally{rmSync(root,{recursive:true,force:true});}
});

test("actual native API credential is refused before extraction USER and physical forwarding",async()=>{
  const root=mkdtempSync(join(tmpdir(),"extraction-auth-test-")),output=join(root,"receipt");
  try{
    const child=Bun.spawn(["unshare","--user","--map-current-user","--keep-caps","--net","sh","-c",'ip link set lo up && exec setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all "$@"',"extraction-paid",process.execPath,
      "scripts/evals/candidate-extraction/paid-offline.ts","paid-wrong-auth",output],{cwd:process.cwd(),env:{PATH:`${join(process.execPath,"..")}:/usr/bin:/bin`,BRAIN_EXTRACTION_OFFLINE:"1",BRAIN_EXTRACTION_PARENT_NET:readlinkSync("/proc/self/ns/net")},stdout:"pipe",stderr:"pipe"});
    const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    const receipt=JSON.parse(readFileSync(join(output,"receipt.json"),"utf8"));
    expect(receipt.promptReleased).toBe(false);expect(receipt.paid.entries).toHaveLength(0);expect(receipt.account.apiKeySource).toBe("ANTHROPIC_API_KEY");
    expect(readFileSync(join(output,"stdin.jsonl"),"utf8")).not.toContain('"type":"user"');
    expect({exit,stdout,stderr}).toMatchObject({exit:0});
  }finally{rmSync(root,{recursive:true,force:true});}
},30000);

test("extraction Root review admits the exact literal formatted proof hash used by its packets",()=>{
 const root=mkdtempSync(join(tmpdir(),"extraction-literal-proof-")),prefix="BRAIN_EXTRACTION";
 const names=[`${prefix}_PAID_PROOF`,`${prefix}_PAID_POLICY`,`${prefix}_PAID_POLICY_SHA`,`${prefix}_LEDGER`,`${prefix}_ADMISSION`],saved=names.map(n=>process.env[n]);
 try{
  const frozen=extractionPaidFreeze(),prompt="Odysseus literal proof control";
  const proof={freezeSha:frozen.freezeSha,testsExitCode:0,typecheckExitCode:0,lintExitCode:0,originalNativeExitCode:0,paidNativeExitCodes:{"paid-extra":0}};
  const raw=JSON.stringify(proof,null,2)+"\n",proofSha=digest(raw);expect(proofSha).not.toBe(digest(JSON.stringify(proof)));
  const synthetic=openExtractionPaid({output:root,prompt,frozen,offline:true}),binding={...synthetic.evidence.binding,proofSha},nonce=digest(root+"live-format-only");
  const policy={...synthetic.evidence.policy,...binding,control:"live" as const,grantNonce:nonce,consumedMarkerPath:join(root,nonce+".json")};
  const policySha=digest(JSON.stringify(policy)),intent={...binding,issue:849,subscriptionWindowOwner:849,extraUsageAuthorized:true,sourceAuditApproved:true,paidPolicySha:policySha,expiresAt:policy.expiresAt};
  const proofPath=join(root,"proof.json"),policyPath=join(root,"policy.json"),ledgerPath=join(root,"ledger.json"),intentPath=join(root,"intent.json");
  for(const [path,value]of [[proofPath,raw],[policyPath,JSON.stringify(policy)],[ledgerPath,JSON.stringify({capUsd:150,perIssueCapUsd:15,basis:policy.basis,reservations:{849:15}})],[intentPath,JSON.stringify(intent)]])writeFileSync(path!,value!,{mode:0o600});
  [proofPath,policyPath,policySha,ledgerPath,intentPath].forEach((v,i)=>process.env[names[i]!]=v);
  expect(()=>openExtractionPaid({output:root,prompt,frozen,offline:false,proofSha})).not.toThrow();
 }finally{names.forEach((n,i)=>{if(saved[i]===undefined)delete process.env[n];else process.env[n]=saved[i];});rmSync(root,{recursive:true,force:true});}
});
