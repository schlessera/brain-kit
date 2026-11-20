import { WorkerStateError } from "@schlessera/brain-ui-sdk/internal";
import { expect, test } from "bun:test";
import { maintenancePackingCommand, runHostedMaintenance } from "../src/brain/maintenance-packing.js";
import type { BrainExecution, ExecutionResult } from "../src/brain/host-boundary.js";
const execution:BrainExecution={argv:["brain","maintain","--json"],env:{},credentials:true,gate:"exclusive",purpose:"cron maintain"};
const answer=(value:unknown,exitCode=0):ExecutionResult=>({stdout:JSON.stringify(value),stderr:"",exitCode});

test("hosted packing uses a separate calculated stage and preserves ordinary maintenance results",async()=>{
 const calls:BrainExecution[]=[];
 const result=await runHostedMaintenance(execution,1,async selected=>{
  calls.push(selected);
  if(calls.length===1)return answer([{step:"index",result:"ok — 1 added"},{step:"git",result:"skipped — --no-git"}]);
  if(calls.length===2)return answer({state:"complete",reason:null,headroom:{packingRequiredBytes:400*1024**2}});
  return answer({state:"complete",packed:1,garbage:{count:0,bytes:0}});
 });
 expect(calls[0]!.argv).toContain("--no-git");
 expect(calls[0]!.discardGit,"ORDINARY_PASS_DISCARDS_GIT_SCAFFOLDING").toBe(true);
 expect(calls[0]!.packingAllowanceBytes,"GENERIC_STAGE_KEEPS_DEFAULT").toBeUndefined();
 expect(calls[1]!.publish).toBe(false);
 expect(calls[2],"PACKING_HAS_ITS_OWN_STAGE").toMatchObject({packingAllowanceBytes:416*1024**2,outputAreas:[".git"],credentials:false});
 expect(JSON.parse(result.stdout)).toEqual([{step:"index",result:"ok — 1 added"},{step:"git",result:"ok — packed 1 loose object(s)"}]);
 expect(result.exitCode).toBe(0);
});
test("a store capacity refusal names a retryable packing skip and retains index success",async()=>{
 let calls=0;
 const result=await runHostedMaintenance(execution,1,async()=>{
  if(++calls===1)return answer([{step:"index",result:"ok — 1 added"},{step:"git",result:"skipped — --no-git"}]);
  if(calls===2)return answer({state:"complete",reason:null,headroom:{packingRequiredBytes:400*1024**2}});
  throw new WorkerStateError("worker_state_busy","packing_headroom: managed store cannot reserve stage above floor");
 });
 expect(JSON.parse(result.stdout),"PACKING_SKIP_RETAINS_OTHER_OUTPUTS").toMatchObject([{step:"index",result:"ok — 1 added"},{step:"git",result:expect.stringContaining("skipped — packing_headroom")}]);
 expect(result.exitCode).toBe(0);
});
test("a malformed plan never starts the packing command",async()=>{
 let calls=0;
 const result=await runHostedMaintenance(execution,1,async()=>++calls===1?answer([{step:"git",result:"skipped"}]):answer({state:"complete",headroom:{packingRequiredBytes:-1}}));
 expect(calls,"NO_GIT_WITH_UNKNOWN_SIZE").toBe(2);expect(result.stdout).toContain("packing_headroom");
 expect(maintenancePackingCommand({...execution,argv:["brain","maintain","--no-git"]})).toBe(-1);
});


test("an unknown staging failure keeps its cause and fails only the packing step",async()=>{
 let calls=0;
 const result=await runHostedMaintenance(execution,1,async()=>{
  if(++calls===1)return answer([{step:"index",result:"ok — 1 added"},{step:"git",result:"skipped"}]);
  throw Error("staging identity changed");
 });
 expect(result.exitCode).toBe(2);
 expect(result.stdout,"PACKING_UNKNOWN_IS_NOT_CAPACITY").toContain("FAILED — git packing: staging identity changed");
 expect(result.stdout).toContain("ok — 1 added");
});
