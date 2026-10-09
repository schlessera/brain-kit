/** Runtime permission control; scripted model is not a provider/model-quality measurement. */
import { test,expect } from "bun:test";
import { mkdtempSync,readFileSync,rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
test("actual core default allows Bash Read Write while operator denied Write remains denied",async()=>{
 const parent=mkdtempSync(join(tmpdir(),"core-default-native-")),out=join(parent,"artifact");
 try{
 const child=Bun.spawn(["python3","scripts/fixtures/claude-core-default-launch.py","--bun",process.execPath,"--output",out],{cwd:process.cwd(),env:{PATH:process.env.PATH!,HOME:parent},stdout:"pipe",stderr:"pipe"});
 const [exit,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect({exit,stdout,stderr}).toMatchObject({exit:0});
 const r=JSON.parse(readFileSync(join(out,"receipt.json"),"utf8")),[allow,deny]=r.observations;
 // First behavioral assertion: dropping explicit default must fail the real Bash witness.
 expect(allow.bashMarker).toBe(true);expect(allow.bashContent).toBe("Odysseus 2026-07-12");
 expect(allow.allowedContent).toBe("Odysseus inspects the raft on 2026-07-12.\n");expect(deny.deniedWritten).toBe(false);
 for(const arm of [allow,deny]){
 expect(arm.forcedKill).toBe(false);expect(arm.exitCode).toBe(0);expect(arm.ownedDrained).toBe(true);expect(arm.error).toBeNull();
 const frames=arm.rawStdout.trim().split("\n").map((s:string)=>JSON.parse(s)),init=frames.find((f:any)=>f.type==="system"&&f.subtype==="init");
 expect(init.permissionMode).toBe("default");expect(init.claude_code_version).toBe("2.1.293");expect(init.model).toBe("claude-sonnet-5-5");
 expect(arm.physical.length).toBeGreaterThan(0);for(const call of arm.physical){expect(call.status).toBe(200);expect(call.forwarded).toBe(true);expect(call.requestedModel).toBe("claude-sonnet-5-5");expect(call.servedModel).toBe("claude-sonnet-5-5");expect(call.authRoute).toBe("synthetic-oauth");}
 const toolResults=arm.physical.flatMap((c:any)=>c.request.messages??[]).flatMap((m:any)=>Array.isArray(m.content)?m.content:[]).filter((b:any)=>b.type==="tool_result");
 expect(toolResults.length).toBeGreaterThan(0);
 if(arm===allow){const read=toolResults.find((b:any)=>b.tool_use_id==="tool_allow_1");expect(JSON.stringify(read.content)).toContain("Odysseus inspects the raft");expect(read.is_error??false).toBe(false);}
 else expect(toolResults.some((b:any)=>b.is_error===true)).toBe(true);
 }
 }finally{rmSync(parent,{recursive:true,force:true});}
},90000);
