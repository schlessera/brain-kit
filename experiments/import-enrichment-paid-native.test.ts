import {beforeAll,expect,test} from "bun:test";
import {mkdtempSync,readFileSync} from "node:fs";
import {join} from "node:path";
import {tmpdir} from "node:os";
import {offlineSource} from "./mechanical-hygiene-offline-source";
let source:string;
beforeAll(()=>{source=offlineSource(process.cwd());},30000);
const output=mkdtempSync(join(tmpdir(),"import-enrichment-paid-controls-"));
for(const mode of ["paid-extra","paid-inactive","paid-rejected","paid-http402","paid-http429","paid-missing","paid-wrong-model","paid-partial"]){
  test(`actual native293 retains root paid reservation and clean refusal/drain: ${mode}`,async()=>{
    const destination=join(output,`${mode}.json`),child=Bun.spawn(["python3","scripts/evals/import-enrichment/launch.py",mode,destination],{cwd:source,env:{PATH:process.env.PATH!,HOME:output},stdout:"pipe",stderr:"pipe"});
    const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    expect({exit,stdout,stderr}).toMatchObject({exit:0});
    expect(JSON.parse(readFileSync(destination,"utf8"))).toMatchObject({passed:true,forwarded:1,drained:true,providerRequests:0,semanticApproval:false});
  },30000);
}
