import { expect, test } from "bun:test";
import { lstatSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createFixture } from "../scripts/turn-surface-fixture";
import { disableMeasurementMemory } from "../scripts/measurement-isolation";

test("owned live fixture materializes unchanged skills and remains symlink-free through every layout", () => {
  const fixture = createFixture({corpus:true});
  try {
    expect(()=>disableMeasurementMemory(fixture.root)).not.toThrow();
    const before=fixture.skillFiles();
    for(const skill of fixture.skills){
      expect(lstatSync(join(fixture.root,".claude/skills",skill.name)).isDirectory()).toBe(true);
      expect(before[skill.name]).toBe(readFileSync(join(fixture.root,".agents/skills",skill.name,"SKILL.md"),"utf8"));
    }
    fixture.pruneSkills(["voyage-plan"]);
    expect(Object.keys(fixture.skillFiles())).toEqual(["voyage-plan"]);
    expect(()=>disableMeasurementMemory(fixture.root)).not.toThrow();
    fixture.restoreSkills();
    expect(fixture.skillFiles()).toEqual(before);
    expect(()=>disableMeasurementMemory(fixture.root)).not.toThrow();
    symlinkSync("/controlled-fictional-outside",join(fixture.root,"controlled-escape"));
    expect(()=>disableMeasurementMemory(fixture.root)).toThrow("must not contain symlinks");
  }finally{fixture.close();}
});
test("whole live collector indexes, routes, claims, executes and drains all four arms keylessly",async()=>{
  const scratch=mkdtempSync(join(tmpdir(),"surface-whole-test-")),out=join(scratch,"control.json");
  try{
    const child=Bun.spawn([process.execPath,"scripts/check-turn-surface-live-offline.ts",out],{
      cwd:join(import.meta.dir,".."),env:{PATH:"/usr/bin:/bin",HOME:scratch,BRAIN_LIVE_EVAL:"587_OFFLINE"},stdout:"pipe",stderr:"pipe"});
    const stdout=await new Response(child.stdout).text(),stderr=await new Response(child.stderr).text(),exit=await child.exited;
    if(exit!==0)throw Error(`Whole controlled collector failed:${stdout}\n${stderr}`);
    const receipt=JSON.parse(readFileSync(out,"utf8"));
    expect(receipt.evidence).toBe("offline-scripted-full-collector-control");
    expect(receipt.rows).toHaveLength(20);expect(receipt.nativeProcessReceipts).toHaveLength(20);
    expect(receipt.indexReceipt).toMatchObject({total:25,chunks:25,embeddings:0});
    expect(receipt.jevAttempts).toBe(27);expect(receipt.nativeRequests).toBe(54);
    expect(receipt.models).toEqual(["claude-sonnet-5-5"]);
    expect(receipt.layouts.filter((layout:any)=>layout.arm==="hard-prune").map((layout:any)=>layout.skills.length).sort())
      .toEqual([0,0,1,1,1]);
    expect(receipt.rows.every((row:any)=>row.score.contentPass===true)).toBe(true);
  }finally{rmSync(scratch,{recursive:true,force:true});}
});
