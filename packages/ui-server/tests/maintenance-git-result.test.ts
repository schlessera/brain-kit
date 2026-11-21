import {expect,test} from "bun:test";
import {existsSync,mkdtempSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {watchdogMs} from "../../../scripts/test-deadlines.js";

for(const human of [false,true])for(const result of ["ok — packed 7 loose object(s)","skipped — packing_headroom","FAILED — packing refused"])for(const code of [0,2])
test(`private Git result forwards ${human?"human":"JSON"} output, ${result}, exit ${code}`,async()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-git-result-")),receipt=join(root,"result");
 const report=human?`Maintenance run:\n\n  git        ${result}\n  scratch    FAILED — Athena refuses\n`:JSON.stringify([{step:"git",result},{step:"scratch",result:"FAILED — Athena refuses"}],null,2)+"\n";
 // More than the observer window; chunks also split the Git row's tokens.
 const chunks=["Ithaca ".repeat(10000)+"\n",...report.match(/.{1,3}|\n/g)!];
 const source=`for(const part of ${JSON.stringify(chunks)}){process.stdout.write(part);await Bun.sleep(0);}process.exitCode=${code};`;
 const child=Bun.spawn([process.execPath,join(import.meta.dir,"../src/brain/maintenance-git-result.ts"),receipt,process.execPath,"--config=/dev/null","-e",source],{stdout:"pipe",stderr:"pipe",timeout:watchdogMs(10000)});
 try {
  const [stdout,stderr,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect(exit,stderr).toBe(code);expect(stdout,"GIT_OBSERVER_PRESERVES_STREAM_BYTES").toBe(chunks.join(""));
  expect(existsSync(receipt),"GIT_RECEIPT_FOLLOWS_STEP_NOT_COMMAND_EXIT").toBe(result.startsWith("ok — packed"));
  if(existsSync(receipt))expect(readFileSync(receipt,"utf8")).toBe("packed\n");
 }finally{if(child.exitCode===null){child.kill("SIGKILL");await child.exited;}rmSync(root,{recursive:true,force:true});}
});

test("the real CLI keeps its Git receipt when scratch fails",async()=>{
 const {makeTempBrain,cleanup,keylessEnv}=await import("../../core/tests/cli-harness.js");
 const {writeFileSync}=await import("node:fs");const root=makeTempBrain();
 try {
  expect(Bun.spawnSync(["git","-C",root,"init","-q"]).exitCode).toBe(0);
  writeFileSync(join(root,".brain"),"Scratch is blocked.");const receipt=join(root,".git/result");
  const child=Bun.spawn([process.execPath,join(import.meta.dir,"../src/brain/maintenance-git-result.ts"),receipt,process.execPath,join(import.meta.dir,"../../core/src/cli/brain.ts"),"maintain","--json"],{cwd:root,env:keylessEnv(root),stdout:"pipe",stderr:"pipe",timeout:watchdogMs(10000)});
  const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect(code,stderr).toBe(2);expect(JSON.parse(stdout).find((row:{step:string})=>row.step==="git").result).toStartWith("ok — packed ");
  expect(readFileSync(receipt,"utf8"),"REAL_CLI_STEP_RECEIPT_SURVIVES_SCRATCH_FAILURE").toBe("packed\n");
 }finally{cleanup(root);}
});
