/** Runtime proof runs in its own loopback-only namespace, with fake credentials. */
import { beforeAll,expect,test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, existsSync, mkdirSync, writeFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
const source = new URL("../", import.meta.url).pathname;
import {offlineSource} from "./mechanical-hygiene-offline-source";
beforeAll(()=>{offlineSource(source);},30000);
async function probe(script: string, args: string[],stopAfterMs=25000, failureDirectory?:string) {
  const command = ["unshare","--user","--map-current-user","--keep-caps","--net","sh","-c",
    'ip link set lo up && exec setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all "$@"',"hygiene-offline",process.execPath,script,...args];
  const child = Bun.spawn(command,{cwd:offlineSource(source),env:{PATH:`${process.execPath.slice(0,process.execPath.lastIndexOf("/"))}:/usr/bin:/bin`,BRAIN_HYGIENE_OFFLINE:"1",TZ:"UTC"},stdout:"pipe",stderr:"pipe"});
  let watchdog=false;const timer=setTimeout(()=>{watchdog=true;child.kill("SIGKILL");},stopAfterMs);
  const [out,err,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);clearTimeout(timer);
  if((watchdog||code!==0)&&failureDirectory){
    const files:Record<string,string>={};
    function capture(directory:string,prefix="") {for(const name of readdirSync(directory)){const path=join(directory,name),stat=lstatSync(path);if(stat.isSymbolicLink())continue;
      if(stat.isDirectory())capture(path,`${prefix}${name}/`);else if(stat.isFile())files[`${prefix}${name}`]=readFileSync(path).toString("base64");}}
    capture(failureDirectory);mkdirSync("tmp",{recursive:true});
    const diagnosticError=err.replaceAll(offlineSource(source),"<owned-source>");
    writeFileSync("tmp/mechanical-hygiene-deadline-probe.json",JSON.stringify({watchdog,code,stdout:out,stderr:diagnosticError,files},null,2),{mode:0o600});
    console.error(err);
  }
  expect(watchdog,"Native proof watchdog fired instead of owned deadline/drain").toBe(false);
  expect(code,`${out}\n${err}`).toBe(0); return out;
}
test("actual installed native denies an outside source read before model input and executes shipped CLI tools",async()=>{
  const parent=mkdtempSync("/tmp/hygiene-native-proof-");const out=join(parent,"proof");
  try{
    const text=await probe("scripts/evals/mechanical-hygiene/offline-native.ts",[out]);
    const receipt=JSON.parse(readFileSync(join(out,"dry-run/receipt.json"),"utf8"));
    expect(text).toContain('"externalRequests":0');
    expect(receipt.native.failure).toBeNull();expect(receipt.native.overage).toBe("reported inactive");
    expect(receipt.native.calls.length).toBeGreaterThan(0);
    expect(receipt.native.calls.every((c:any)=>c.completed&&c.servedModel==="claude-sonnet-5-5")).toBe(true);
    expect(receipt.tools[0].allowed).toBe(false);expect(receipt.tools.slice(1).every((t:any)=>t.allowed)).toBe(true);
    expect(receipt.native.ownedChildDrained).toBe(true);expect(receipt.native.naturalStdoutEof).toBe(true);
    expect(JSON.stringify(receipt.physicalCalls)).not.toContain("OUTSIDE_HYGIENE_PRIVATE_SENTINEL");
  }finally{rmSync(parent,{recursive:true,force:true});}
},30000);
test("actual current native runs dry/apply/repeat through exact CLI scratch and full log effects",async()=>{
  const parent=mkdtempSync("/tmp/hygiene-native-cycle-");const out=join(parent,"cycle");
  try{
    await probe("scripts/evals/mechanical-hygiene/offline-cycle.ts",[out,"ogygia-raft-status","20"]);
    const control=JSON.parse(readFileSync(join(out,"control-summary.json"),"utf8"));
    expect(control.complete).toBe(true);expect(control.semanticApproval).toBe(false);
    const rows=JSON.parse(readFileSync(join(out,"phases.json"),"utf8")).rows;
    expect(rows.map((r:any)=>r.phase)).toEqual(["dry-run","apply","repeat"]);
    expect(rows.every((r:any)=>r.receipt.native.ownedChildDrained&&r.receipt.native.naturalStdoutEof)).toBe(true);
    expect(rows[1].effects.changes.content).toContain("context/ogygia/raft/_index.md");
    expect(rows[2].effects.changes.content.filter((p:string)=>p.endsWith(".md"))).toEqual([]);
  }finally{rmSync(parent,{recursive:true,force:true});}
},30000);

test("actual native helper-auth settings keep the user prompt held with zero physical model requests",async()=>{
  const text=await probe("scripts/evals/mechanical-hygiene/offline-auth.ts",[]);
  expect(text).toContain('"promptReleased":false');expect(text).toContain('"modelRequests":0');
},30000);


test("actual complete native collector stops before repeat on an unexpected file",async()=>{
  const parent=mkdtempSync("/tmp/hygiene-native-effect-veto-"),out=join(parent,"cycle");
  try{
    const child=Bun.spawn(["unshare","--user","--map-current-user","--keep-caps","--net","sh","-c",'ip link set lo up && exec setpriv --bounding-set=-all --inh-caps=-all --ambient-caps=-all "$@"',"hygiene-offline",process.execPath,"scripts/evals/mechanical-hygiene/offline-cycle.ts",out,"ogygia-raft-status","20","--controlled-unexpected-write"],{cwd:offlineSource(source),env:{PATH:`${process.execPath.slice(0,process.execPath.lastIndexOf("/"))}:/usr/bin:/bin`,BRAIN_HYGIENE_OFFLINE:"1",TZ:"UTC"},stdout:"pipe",stderr:"pipe"});
    const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
    expect(code,stdout+stderr).toBe(1);const rows=JSON.parse(readFileSync(join(out,"phases.json"),"utf8"));
    expect(rows.rows).toHaveLength(2);expect(rows.complete).toBe(false);expect(rows.failure).toContain("Unapproved complete native apply effects");
    expect(rows.rows[1].effects.problems).toContain("unapproved file: context/unapproved.md");
    expect(existsSync(join(out,"repeat"))).toBe(false);
  }finally{rmSync(parent,{recursive:true,force:true});}
},30000);

test("actual native deadline aborts an active SDK query and closes its incomplete physical stream",async()=>{
  const parent=mkdtempSync("/tmp/hygiene-native-deadline-");
  try{const text=await probe("scripts/evals/mechanical-hygiene/offline-deadline.ts",[parent],6000,parent);expect(text).toContain('"unknownCostsPreserved":true');expect(text).toContain('"physical":1');}
  finally{rmSync(parent,{recursive:true,force:true});}
},10000);


test("actual native vetoes the fixture Write after an actual UTC write-day mismatch and drains",async()=>{
  const parent=mkdtempSync("/tmp/hygiene-native-write-day-");
  try {const text=await probe("scripts/evals/mechanical-hygiene/offline-write-day.ts",[join(parent,"proof")]);expect(text).toContain('"writeDayRefused":true');expect(text).toContain('"ownedChildDrained":true');}
  finally {rmSync(parent,{recursive:true,force:true});}
},30000);
