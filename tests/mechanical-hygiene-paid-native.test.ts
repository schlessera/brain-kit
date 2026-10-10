import {beforeAll,test,expect} from "bun:test";
import {mkdtempSync,readFileSync,rmSync} from "node:fs";
import {join} from "node:path";
import {paidModes} from "../scripts/evals/mechanical-hygiene/offline-paid";
import {offlineSource} from "./mechanical-hygiene-offline-source";
const source=new URL("../",import.meta.url).pathname;
beforeAll(()=>{offlineSource(source);},30000);
for(const mode of paidModes)test(`actual292 native paid transport ${mode} preserves allocation, usage and owned closure`,async()=>{
  const parent=mkdtempSync("/tmp/hygiene-paid-control-");
  try{
    const output=join(parent,mode),child=Bun.spawn(["unshare","--user","--map-current-user","--keep-caps","--net","sh","-c",
      'ip link set lo up && exec setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all "$@"',"hygiene-paid",process.execPath,"scripts/evals/mechanical-hygiene/offline-paid.ts",mode,output],
      {cwd:offlineSource(source),env:{PATH:`${process.execPath.slice(0,process.execPath.lastIndexOf("/"))}:/usr/bin:/bin`,BRAIN_HYGIENE_OFFLINE:"1",TZ:"UTC"},stdout:"pipe",stderr:"pipe"});
    let watchdog=false;const timer=setTimeout(()=>{watchdog=true;child.kill("SIGKILL");},25000);
    const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);clearTimeout(timer);
    expect(watchdog,"Owned native deadline/drain must precede watchdog").toBe(false);expect(code,stdout+stderr).toBe(0);
    const control=JSON.parse(readFileSync(join(output,"control.json"),"utf8"));expect(control.semanticApproval).toBe(false);expect(control.externalRequests).toBe(0);expect(control.invoiceUsd).toBeNull();
  }finally{rmSync(parent,{recursive:true,force:true});}
},30000);
