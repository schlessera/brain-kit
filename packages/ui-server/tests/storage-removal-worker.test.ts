import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, readdirSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { createNativeBrainManagerClient } from "@schlessera/brain-ui-sdk/internal";
import { createNativeAppFixture } from "./helpers/native-app-fixture";
import { createHostBoundary } from "../src/brain/host-boundary";
import { createUiDb } from "../src/db/client";
import { createWriterGate } from "../src/brain/writer-gate";
import { readRemovalFacts } from "../src/storage/removal-facts";
function files(root: string): string[] { return readdirSync(root).sort().flatMap(name => { const file=join(root,name);return lstatSync(file).isDirectory()?files(file).map(value=>`${name}/${value}`):[`${name}:${createHash("sha256").update(readFileSync(file)).digest("hex")}`]; }); }

test("real removal review evaluates Git in a disposable native worker without loading brain config or publishing incidental objects", async () => {
  const root=mkdtempSync(join(tmpdir(),"odysseus-removal-worker-")),brain=join(root,"brain"),marker=join(root,"config-executed");mkdirSync(brain);
  writeFileSync(join(brain,"brain.config.ts"),`await Bun.write(${JSON.stringify(marker)},"unexpected evaluation");export default {};\n`);
  mkdirSync(join(brain,"attachments"));writeFileSync(join(brain,"attachments/chart.pdf"),Buffer.from([0,255,13]));writeFileSync(join(brain,"voyage.md"),"[Chart](attachments/chart.pdf)\n");
  const git=(...args:string[])=>{const result=Bun.spawnSync(["git","-C",brain,...args],{env:{...process.env,GIT_CONFIG_GLOBAL:"/dev/null",GIT_CONFIG_NOSYSTEM:"1"},stdout:"pipe",stderr:"pipe"});expect(result.exitCode,result.stderr.toString()).toBe(0);return result.stdout.toString();};
  git("init");git("add","attachments/chart.pdf");
  const native=createNativeAppFixture(brain),dbPath=join(root,"ui.sqlite"),db=createUiDb(dbPath),gate=createWriterGate(db,brain,{pollMs:1});
  const boundary=createHostBoundary({brainPath:brain,dbPath,gate:()=>gate,history:()=>true,nativeManager:createNativeBrainManagerClient(native.nativeBrain)});
  try {
    const before=files(join(brain,".git")),hold=await gate.acquire("exclusive","storage-review-proof");
    let facts;
    try{facts=await readRemovalFacts(boundary,brain,["attachments/chart.pdf"],new AbortController().signal,()=>{});}finally{hold.release();}
    expect(facts.files[0],"STORAGE_REAL_WORKER_REFERENCE_FACTS").toMatchObject({git:"tracked",references:[{source:"voyage.md",certainty:"resolved"}]});
    expect(existsSync(marker),"STORAGE_REVIEW_NO_BRAIN_CONFIG").toBe(false);
    expect(files(join(brain,".git")),"STORAGE_REVIEW_NO_INCIDENTAL_GIT_PUBLICATION").toEqual(before);
    const output=await boundary.run({argv:[process.execPath,"--config=/dev/null","--no-env-file","-e",'await Bun.write(process.env.BRAIN_WORKER_DATA_ROOT+"/unexpected.pdf","unexpected write");console.log("read complete");'],env:process.env,credentials:false,gate:"shared",purpose:"storage-read-discard-proof",publish:false,outputBytes:1024,timeoutMs:5000});
    expect(output.exitCode,output.stderr).toBe(0);expect(existsSync(join(brain,"unexpected.pdf")),"STORAGE_REVIEW_DISCARDS_WORKER_WRITES").toBe(false);
  } finally{db.close();await native.close();rmSync(root,{recursive:true,force:true});}
});
