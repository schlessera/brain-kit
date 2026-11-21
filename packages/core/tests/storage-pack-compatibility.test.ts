/** Frozen pre-change CLI fields: additions must not extend an existing enum. */
import { expect, spyOn, test } from "bun:test";
import { z } from "zod";
import * as fs from "node:fs";
import { makeTempBrain, cleanup, runCli } from "./cli-harness";
import { runStoragePack } from "../src/cli/commands/storage.js";

const previousPack = z.looseObject({
  schema_version:z.literal(1),action:z.literal("pack"),state:z.enum(["complete","refused","partial"]),
  packed:z.number().nullable(),reason:z.enum(["no_space","not_a_git_worktree","git_maintenance_unavailable"]).nullable(),
  headroom:z.looseObject({availableBytes:z.number().nullable(),requiredBytes:z.null(),reason:z.string()}).nullable(),
});
const previousMaintain=z.array(z.looseObject({step:z.enum(["registry","index","vectors","audit","stats","tags","git","scratch"]),result:z.string(),trends:z.unknown().optional()}));

test("the previous CLI schema parses packing additions and named preflight skips",async()=>{
  const root=makeTempBrain();
  try {
    const init=Bun.spawnSync(["git","-C",root,"init","-q"],{stdout:"pipe",stderr:"pipe"});expect(init.exitCode).toBe(0);
    const actual=await runCli(root,["storage","pack","--json"]);
    expect(previousPack.safeParse(JSON.parse(actual.stdout)).success,"PREVIOUS_PACK_SCHEMA_ACCEPTS_ADDITIONS").toBe(true);
    const observed=fs.statfsSync(root,{bigint:true});
    for(const available of [0n,1n,null]) {
      let printed="";
      const capacity=spyOn(fs,"statfsSync").mockImplementation((()=>{if(available===null)throw Error("capacity unknown");return {...observed,bavail:available,bsize:4096n};}) as unknown as typeof fs.statfsSync);
      const output=spyOn(console,"log").mockImplementation(value=>{printed=String(value);});
      let code=-1;
      try{code=runStoragePack(["pack","--json"],root,true);}finally{output.mockRestore();capacity.mockRestore();}
      const result=JSON.parse(printed);
      expect(code).toBe(2);expect(result.skipReason).toBe("packing_headroom");
      expect(previousPack.safeParse(result).success,"PREVIOUS_PACK_SCHEMA_ACCEPTS_PREFLIGHT_SKIP").toBe(true);
      expect(previousPack.safeParse({...result,reason:"packing_headroom"}).success,"PREVIOUS_PACK_ENUM_NEGATIVE_CONTROL").toBe(false);
    }
    const maintained=await runCli(root,["maintain","--json"]);
    expect(previousMaintain.safeParse(JSON.parse(maintained.stdout)).success,"PREVIOUS_MAINTAIN_SCHEMA_ACCEPTS_RESULTS").toBe(true);
  } finally {cleanup(root);}
});

test("packing uses the single headroom measurement it reports",()=>{
 const root=makeTempBrain();let output:ReturnType<typeof spyOn>|undefined,capacity:ReturnType<typeof spyOn>|undefined;
 try{
 expect(Bun.spawnSync(["git","-C",root,"init","-q"]).exitCode).toBe(0);
 const actual=fs.statfsSync(root,{bigint:true});let reads=0,printed="";
 capacity=spyOn(fs,"statfsSync").mockImplementation((()=>{reads++;return reads===1?actual:{...actual,bavail:0n};}) as unknown as typeof fs.statfsSync);
 output=spyOn(console,"log").mockImplementation(value=>{printed=String(value);});
 expect(runStoragePack(["pack","--json"],root,true),"PACK_USES_REPORTED_HEADROOM").toBe(0);
 expect(reads,"PACK_PREFLIGHT_ENUMERATES_ONCE").toBe(1);
 expect(JSON.parse(printed)).toMatchObject({state:"complete",headroom:{availableBytes:Number(actual.bavail*actual.bsize)}});
 }finally{output?.mockRestore();capacity?.mockRestore();cleanup(root);}
});
