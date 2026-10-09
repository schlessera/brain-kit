import { describe, expect, test } from "bun:test";
import { mkdtempSync,writeFileSync,chmodSync,symlinkSync,unlinkSync,linkSync,rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { once } from "node:events";
import { ownedClosure,closureDigest } from "../evals/triage/experiment/closure";
import { NativeEvidence, rawTee } from "../evals/triage/experiment/native-evidence";
const result={type:"result",subtype:"success",is_error:false,result:"Odysseus \u03a9",modelUsage:{"claude-sonnet-5-5":{inputTokens:9,outputTokens:11,cacheReadInputTokens:0,cacheCreationInputTokens:0}}};
const fakeOptions=(script:string)=>({command:process.execPath,args:["-e",script],cwd:process.cwd(),env:{PATH:"/usr/bin:/bin"},signal:new AbortController().signal});
describe("protected native evidence entry controls",()=>{
 test("direct native chunks split Unicode and final line preserve parsed receipt and exact bytes",async()=>{
  const bytes=Buffer.from(JSON.stringify(result)),point=bytes.indexOf(Buffer.from("\u03a9"))+1,raw:Buffer[]=[],lines:string[]=[];
  const tee=rawTee(chunk=>raw.push(chunk),line=>lines.push(line));tee.resume();tee.write(bytes.subarray(0,point));tee.end(bytes.subarray(point));await once(tee,"finish");
  expect(JSON.parse(lines[0]!).result).toBe("Odysseus \u03a9");expect(lines).toHaveLength(1);expect(Buffer.concat(raw)).toEqual(bytes);
 });
 test("real native exit and final-no-newline result retain terminal output, not provisional frame",async()=>{
  const evidence=new NativeEvidence();const child=evidence.spawn(fakeOptions(`process.stdout.write(JSON.stringify({type:'assistant',usage:{output_tokens:1}})+'\\n');process.stdout.write(${JSON.stringify(JSON.stringify(result))});`));
  for await(const _chunk of child.stdout) { /* Exercise native pipe to EOF. */ }
  expect(await evidence.drain()).toBe(true);expect(evidence.accounting().complete).toBe(true);expect(evidence.accounting().rows[0]!.output).toBe(11);expect(evidence.native.processes[0]!.closed).toBe(true);
 });
 test("reader throws after error frame; raw failed terminal result remains accessible after actual drain",async()=>{
  const failed={...result,is_error:true,subtype:"error_during_execution"};const evidence=new NativeEvidence();
  const child=evidence.spawn(fakeOptions(`process.stdout.write(JSON.stringify({type:'error',message:'scripted error'})+'\\n');setTimeout(()=>{process.stdout.write(${JSON.stringify(JSON.stringify(failed))});},20);`));
  try{for await(const _chunk of child.stdout)throw Error("scripted SDK reader failed");}catch{/* Deliberate reader failure. */}
  expect(await evidence.drain()).toBe(true);expect(evidence.accounting().retainedResults).toHaveLength(1);expect(evidence.accounting().result!.is_error).toBe(true);expect(evidence.rawBytes().toString()).toContain("error_during_execution");expect(evidence.accounting().rows[0]!.output).toBe(11);
 });
 test("forced native kill cannot manufacture complete usage or natural closure",async()=>{
  const evidence=new NativeEvidence();evidence.spawn(fakeOptions(`process.stdout.write(JSON.stringify({type:"error"})+"\\n");setInterval(()=>{},1000);`));
  expect(await evidence.drain(20)).toBe(false);expect(evidence.native.processes[0]!.forcedKill).toBe(true);expect(evidence.native.processes[0]!.closed).toBe(true);expect(evidence.accounting().complete).toBe(false);
 });
 test("unknown auxiliary model remains unpriced/unknown even with terminal result",async()=>{
  const evidence=new NativeEvidence(),extra={...result,modelUsage:{...result.modelUsage,other:{inputTokens:1,outputTokens:1,cacheReadInputTokens:0,cacheCreationInputTokens:0}}};
  const child=evidence.spawn(fakeOptions(`process.stdout.write(${JSON.stringify(JSON.stringify(extra))});`));for await(const _ of child.stdout){}
  expect(await evidence.drain()).toBe(true);expect(evidence.accounting().complete).toBe(false);expect(evidence.accounting().rows).toHaveLength(2);expect(evidence.rawBytes().length).toBeGreaterThan(0);
 });
});
describe("owned execution closure, actual filesystem mutations",()=>{
 test("file/directory modes, resolved symlink targets and target bytes change complete digest",()=>{
  const root=mkdtempSync(join(tmpdir(),"triage-closure-"));try{
   writeFileSync(join(root,"a"),"alpha");writeFileSync(join(root,"b"),"beta");symlinkSync("a",join(root,"selected"));
   const first=closureDigest(ownedClosure(root));chmodSync(join(root,"a"),0o700);expect(closureDigest(ownedClosure(root))).not.toBe(first);
   const second=closureDigest(ownedClosure(root));chmodSync(root,0o755);expect(closureDigest(ownedClosure(root))).not.toBe(second);
   const third=closureDigest(ownedClosure(root));unlinkSync(join(root,"selected"));symlinkSync("b",join(root,"selected"));expect(closureDigest(ownedClosure(root))).not.toBe(third);
   const fourth=closureDigest(ownedClosure(root));writeFileSync(join(root,"b"),"changed");expect(closureDigest(ownedClosure(root))).not.toBe(fourth);
  }finally{rmSync(root,{recursive:true,force:true});}
 });
 test("external target and external inode sharing rejected; internal hardlinks still represented",()=>{
  const root=mkdtempSync(join(tmpdir(),"triage-owned-")),other=mkdtempSync(join(tmpdir(),"triage-other-"));try{
   writeFileSync(join(root,"a"),"bytes");linkSync(join(root,"a"),join(root,"b"));expect(ownedClosure(root).a!.links).toBe("2");
   linkSync(join(root,"a"),join(other,"shared"));expect(()=>ownedClosure(root)).toThrow("shares inode outside owned tree");unlinkSync(join(other,"shared"));
   writeFileSync(join(other,"private"),"outside");symlinkSync(join(other,"private"),join(root,"outside"));expect(()=>ownedClosure(root)).toThrow("link leaves owned tree");
  }finally{rmSync(root,{recursive:true,force:true});rmSync(other,{recursive:true,force:true});}
 });
});
