import {expect,test} from "bun:test";
import {mkdtempSync,rmSync,readFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {tmpdir} from "node:os";
/** Python launch enters a real unshared namespace. It supplies no ambient HOME/auth/network. */
for(const mode of ["read","write-denial","review","cli-direct","archive","cli","current-cell","cli-escape"] as const)test(`actual isolated native/CLI full speaking control: ${mode}`,async()=>{
 const output=mkdtempSync(join(tmpdir(),"brain-speaking-integration-")),path=join(output,"proof.json");
 const child=Bun.spawn(["python3",resolve("scripts/evals/speaking-lifecycle/launch.py"),mode,path],{cwd:resolve("."),env:{PATH:process.env.PATH},stdout:"pipe",stderr:"pipe",signal:AbortSignal.timeout(45000)});
 try{const [code,stdout,stderr]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);expect({code,stdout,stderr}).toMatchObject({code:0});const proof=JSON.parse(readFileSync(path,"utf8"));expect(proof.passed).toBe(true);expect(proof.mode).toBe(mode);expect(proof.semanticApproval).toBe(false);
 if(mode==="cli"){expect(proof.currentArmComplete).toBe(false);expect(proof.native.init.permissionMode).toBe("default");expect(proof.native.stdoutDrained).toBe(true);expect(proof.before).toEqual(proof.after);const physical=JSON.parse(readFileSync(`${path}.raw/physical.json`,"utf8"));expect(physical.every((call:any)=>call.requestedModel==="claude-sonnet-5-5"&&call.status===200&&call.forwarded)).toBe(true);expect(proof.toolResults.some((text:string)=>{const content=JSON.parse(text);const texts=typeof content==="string"?[content]:Array.isArray(content)?content.filter((b:any)=>b.type==="text").map((b:any)=>b.text):[];return texts.some((raw:string)=>{try{const value=JSON.parse(raw);return value.valid===true||value.data?.valid===true;}catch{return false;}});})).toBe(true);expect(physical.filter((call:any)=>call.forwarded).every((call:any)=>call.requestedModel==="claude-sonnet-5-5")).toBe(true);}
 if(mode==="current-cell"){expect(proof.row.candidateSize).toBe(32);expect(proof.row.quality.semanticQuality).toBeNull();expect(proof.row.native.accounting.physicalRoundTrips).toBe(3);expect(proof.row.before["assets/guard.bin"].bytes).toBe(proof.row.after["assets/guard.bin"].bytes);expect(proof.row.retainedNative.stdoutDrained).toBe(true);}
 if(mode==="archive"){expect(proof.native.stdoutDrained).toBe(true);expect(proof.toolResults.some((raw:string)=>raw.includes("archived"))).toBe(true);expect(proof.before).not.toEqual(proof.after);}
 if(mode==="cli-direct"){expect(proof.actualNative).toBe(false);expect(proof.currentAgentBaseline).toBe(false);expect(proof.commands).toHaveLength(5);}
 }finally{child.kill();await child.exited;rmSync(output,{recursive:true,force:true});}
},60000);
