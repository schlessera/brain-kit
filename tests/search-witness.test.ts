import {expect,test} from "bun:test";
import {mkdtempSync,writeFileSync,existsSync,readFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {searchWitnessScript} from "../packages/ui-server/tests/helpers/search-witness";
for(const code of [0,1,127]) test(`search witness requires successful nested rg: ${code}`,()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-search-"));
 try {
  const rg=join(root,"rg"),wrapper=join(root,"wrapper"),marker=join(root,"marker"),status=join(root,"status");
  if(code!==127)writeFileSync(rg,`#!/bin/sh\nexit ${code}\n`,{mode:0o755});
  writeFileSync(wrapper,searchWitnessScript(rg,marker,status,0));
  const child=Bun.spawnSync(["/bin/sh",wrapper,"sirens"],{stderr:"pipe"});
  expect(child.exitCode).toBe(code);expect(readFileSync(status,"utf8").trim()).toBe(String(code));
  expect(existsSync(marker)).toBe(code===0);
 }finally{rmSync(root,{recursive:true,force:true});}
});
