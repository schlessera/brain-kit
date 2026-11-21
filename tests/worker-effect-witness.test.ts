import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createWorkerEffectWitness } from "../scripts/worker-effect-witness";
import { scriptedModel } from "../scripts/measure-claude-runtime";
import { compileSocketPolicy, nativeTestHead, startNativeTestRelay } from "../scripts/test-native-guard";

test("worker effect witness records through the registered scripted service path and Unix relay",async()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-effect-witness-")),marker=join(root,"loom");writeFileSync(marker,"");
 const witness=createWorkerEffectWitness({marker}),model=scriptedModel();model.plan(null,witness);
 const relay=startNativeTestRelay(model.url);
 try{
  const child=Bun.spawn(["/bin/sh","-c",witness.command],{env:{PATH:"/usr/bin:/bin",ANTHROPIC_BASE_URL:"http://localhost",ANTHROPIC_UNIX_SOCKET:join(relay.directory,"relay.sock")},stdout:"pipe",stderr:"pipe"});
  const [code,errors]=await Promise.all([child.exited,new Response(child.stderr).text()]);
  expect(code,errors).toBe(0);expect(witness.effects.marker,"EFFECT_RECORDED_ON_SCRIPTED_SERVICE").toBe(true);
  const source=readFileSync(join(import.meta.dir,"../scripts/measure-claude-delegation.ts"),"utf8");
  expect(source).toContain("pathname===witness.path)return witness.fetch(req)");
 }finally{relay.dispose();model.stop();rmSync(root,{recursive:true,force:true});}
});

test("native connect policy continues to deny a separate TCP loopback endpoint",()=>{
 const proof=Bun.spawnSync([compileSocketPolicy(),"--probe",nativeTestHead()],{env:{PATH:"/usr/bin:/bin"},stdout:"pipe",stderr:"pipe",timeout:5000});
 expect(proof.exitCode,proof.stderr.toString()).toBe(0);
 expect(proof.stdout.toString(),"SEPARATE_TCP_ENDPOINT_DENIED").toContain("NATIVE_SOCKET_POLICY_HELD");
});
