/** Explicit owned Linux UID qualification; root only selects the two fixture uids. */
import assert from "node:assert/strict";
import { chmodSync, chownSync, existsSync, mkdirSync, mkdtempSync, lstatSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { createUiDb } from "../src/db/client";
import { ledgerLine } from "../../ui-sdk/tests/maintenance-temp-ledger-protocol";
assert.equal(process.getuid?.(),0,"this explicit UID proof requires a root fixture launcher");
const previousMask=process.umask(0o007);
const root=mkdtempSync("/var/tmp/odysseus-maintenance-uid-");
const brain=join(root,"brain"); const state=join(root,"state"); mkdirSync(brain); mkdirSync(state);
chmodSync(root,0o755); chmodSync(brain,0o777); chownSync(state,65534,65534); chmodSync(state,0o700);
const dbPath=join(state,"ui.db"); createUiDb(dbPath).close(); chownSync(dbPath,65534,65534); chmodSync(dbPath,0o660);
const serverTemp=mkdtempSync("/tmp/odysseus-server-temp-");
const cronTemp=mkdtempSync("/tmp/odysseus-cron-temp-");chownSync(cronTemp,65534,65534);
const initialState=lstatSync(dbPath);
const children: ReturnType<typeof Bun.spawn>[]=[];
const limits={allowanceBytes:268435456,budgetBytes:268435456};
const spawn=(role:string,marker:string,uid:number)=>{
 const child=Bun.spawn([process.execPath,join(import.meta.dir,"maintenance-temp-boundary-child.ts"),brain,marker,role,JSON.stringify(limits),dbPath],{uid,gid:65534,stdin:"pipe",stdout:"pipe",stderr:"inherit",env:{...process.env,HOME:"/tmp",TMPDIR:uid===0?serverTemp:cronTemp}}); children.push(child);return child;
};
try {
 const held=spawn("server",join(brain,"server-marker"),0);
 assert.deepEqual(JSON.parse(await ledgerLine(held.stdout)),{held:true},"root server actually started maintenance");
 const refusedPath=join(brain,"refused-cron-marker");const refused=spawn("cron",refusedPath,65534);
 const refusal=JSON.parse(await ledgerLine(refused.stdout));console.log(JSON.stringify({phase:"refused",receipt:refusal}));assert.equal(await refused.exited,0);
 assert.equal(refusal.errorClass,"worker_state_busy","SHARED_UID_ADMISSION: cron in another UID refuses against the server reservation");assert.equal(existsSync(refusedPath),false,"refused cron ran no repository code");
 held.stdin!.end(); assert.equal(await held.exited,0);
 const admitted=spawn("cron",join(brain,"released-cron-marker"),65534);const receipt=JSON.parse(await ledgerLine(admitted.stdout));assert.equal(await admitted.exited,0);assert.equal(receipt.admitted,true,"SHARED_UID_RELEASE");assert.equal(receipt.result.exitCode,0);
 const crashed=spawn("server",join(brain,"crashed-server-marker"),0);assert.deepEqual(JSON.parse(await ledgerLine(crashed.stdout)),{held:true});crashed.kill("SIGKILL");await crashed.exited;
 let recovered=false;const marker=join(brain,"recovered-cron-marker");
 for(let i=0;i<50;i++) {
  const next=spawn("cron",marker,65534);const result=JSON.parse(await ledgerLine(next.stdout));assert.equal(await next.exited,0);
  if(result.admitted){assert.equal(result.result.exitCode,0);recovered=true;break;}
  assert.equal(result.errorClass,"worker_state_busy");await Bun.sleep(20);
 }
 assert.equal(recovered,true,"SHARED_UID_CRASH_RECOVERY");assert.equal(readFileSync(marker,"utf8"),"cron ran");
 const db=createUiDb(dbPath);
 try{const holders=db.query("SELECT * FROM writer_gate").all();assert.equal(holders.length,0,"writer gate released after real cron execution");}finally{db.close();}
 const finalState=lstatSync(dbPath);assert.deepEqual([finalState.uid,finalState.gid,finalState.mode,finalState.ino],[initialState.uid,initialState.gid,initialState.mode,initialState.ino],"existing UI state ownership/access remains unchanged");
 console.log(JSON.stringify({serverUid:0,cronUid:65534,sharedState:true,actualWorkerAdmission:true,normalRelease:true,crashRecovery:true,gateReleased:true}));
} finally {
 for(const child of children){try{child.kill("SIGKILL");}catch{}await child.exited;}
 rmSync(root,{recursive:true,force:true});rmSync(serverTemp,{recursive:true,force:true});rmSync(cronTemp,{recursive:true,force:true});process.umask(previousMask);
}
