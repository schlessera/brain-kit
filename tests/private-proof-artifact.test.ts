/** Local descriptor proof; the identity fixture supplies separate-UID kernel proof. */
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateProofArtifact } from "../packages/ui-sdk/tests/fixtures/private-proof-artifact";

test("private proof artifact belongs to the outer directory owner with mode 0600",()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-private-proof-"));
 try {
  const file=writePrivateProofArtifact(root,"audit.json","Odysseus private audit"),owner=statSync(root),result=statSync(file);
  expect(readFileSync(file,"utf8")).toBe("Odysseus private audit");
  expect([result.uid,result.gid,result.mode&0o7777]).toEqual([owner.uid,owner.gid,0o600]);
  expect(()=>writePrivateProofArtifact(root,"audit.json","replacement")).toThrow();
  writeFileSync(join(root,"target"),"unchanged");symlinkSync(join(root,"target"),join(root,"alias"));
  expect(()=>writePrivateProofArtifact(root,"alias","replacement")).toThrow();
  expect(readFileSync(join(root,"target"),"utf8")).toBe("unchanged");
  expect(()=>writePrivateProofArtifact(root,"../escape","replacement")).toThrow();
 }finally{rmSync(root,{recursive:true,force:true});}
});


test("private artifact handoff selects the proof owner rather than the writing UID",async()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-proof-owner-"));
 try {
  const script=join(root,"probe.ts");
  writeFileSync(script,`import * as fs from "node:fs";import {mock} from "bun:test";
   const original={...fs};let ownerFd,outputFd,handed=false;
   mock.module("node:fs",()=>({...original,
    openSync:(path,...args)=>{const fd=original.openSync(path,...args);if(path===${JSON.stringify(root)})ownerFd=fd;else outputFd=fd;return fd;},
    fstatSync:(fd)=>{const value=original.fstatSync(fd);return fd===ownerFd?{...value,uid:21001,gid:21003}:fd===outputFd&&handed?{...value,uid:21001,gid:21003}:value;},
    fchownSync:(fd,uid,gid)=>{if(fd!==outputFd||uid!==21001||gid!==21003)throw Error("WRONG_PROOF_OWNER");handed=true;}
   }));
   const {writePrivateProofArtifact}=await import(${JSON.stringify(join(import.meta.dir,"../packages/ui-sdk/tests/fixtures/private-proof-artifact.ts"))});
   writePrivateProofArtifact(${JSON.stringify(root)},"audit.json","Odysseus audit");
   if(!handed)throw Error("PRIVATE_ARTIFACT_NOT_HANDED_BACK");console.log("PRIVATE_ARTIFACT_HANDED_BACK");`);
  const child=Bun.spawn([process.execPath,script],{stdout:"pipe",stderr:"pipe"});
  const [code,out,err]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
  expect(code,err).toBe(0);expect(out.trim()).toBe("PRIVATE_ARTIFACT_HANDED_BACK");
 }finally{rmSync(root,{recursive:true,force:true});}
});
