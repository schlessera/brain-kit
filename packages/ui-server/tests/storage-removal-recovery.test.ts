import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storageRemovalFixture } from "./helpers/storage-removal-fixture.js";
const entry=join(import.meta.dir,"fixtures/storage-removal-worker.ts");
async function reached(marker:string,child:ReturnType<typeof Bun.spawn>) {
  for(let index=0;index<1000&&!existsSync(marker)&&child.exitCode===null;index++)await Bun.sleep(5);
  expect(existsSync(marker),"STORAGE_REMOVAL_REAL_CHILD_BOUNDARY").toBe(true);
}
for(const phase of ["after-retain","after-intent","after-unlink","after-ack"])test(`SIGKILL ${phase} preserves the original identity and never replays a removal`,async()=>{
  const f=storageRemovalFixture(),id=`odysseus-crash-${phase}`,marker=join(f.root,`reached-${phase}`),target=join(f.brain,"attachments/chart.pdf");
  const child=Bun.spawn([process.execPath,entry,f.root,phase,id,marker],{stdout:"pipe",stderr:"pipe"});
  try {
    await reached(marker,child);child.kill("SIGKILL");await child.exited;
    expect(child.signalCode).toBe("SIGKILL");
    const recovered=storageRemovalFixture(f.root);
    try {
      const result=recovered.removal.receipt("odysseus",id);
      expect(result.state,"STORAGE_REMOVAL_CRASH_UNKNOWN").toBe("unknown");
      expect(existsSync(target)).toBe(["after-retain","after-intent"].includes(phase));
      expect(result.items[0]?.state).toBe(phase==="after-ack"?"removed":phase==="after-retain"?"not-started":"unknown");
      expect(result.items[0]?.undoAvailable).toBe(phase==="after-ack");
      if(phase==="after-ack"){
        const undo=await recovered.removal.review("odysseus","odysseus-crash-undo",["attachments/chart.pdf"],id);
        recovered.removal.start("odysseus",undo.review.id,undo.review.fingerprint);await recovered.removal.idle();
        expect(readFileSync(target),"STORAGE_CRASH_RETAINED_ORIGINAL_UNDO").toEqual(f.original);
      }
      writeFileSync(target,"Penelope's later replacement");
      expect(recovered.removal.start("odysseus",id,result.review.fingerprint).state).toBe("unknown");await recovered.removal.idle();
      expect(readFileSync(target,"utf8"),"STORAGE_CRASH_NO_REPLAY_ON_REPLACEMENT").toBe("Penelope's later replacement");
    } finally{await recovered.close();}
  }finally{child.kill("SIGKILL");await child.exited;await f.close();}
});

test("an actual other-process writer finishes before removal validation while nested shared work remains admissible",async()=>{
  const f=storageRemovalFixture(),id="odysseus-writer-001",marker=join(f.root,"writer-holding");
  const reviewed=await f.removal.review("odysseus",id,["attachments/chart.pdf"]);
  const child=Bun.spawn([process.execPath,entry,f.root,"writer",id,marker],{stdout:"pipe",stderr:"pipe"});
  try {
    await reached(marker,child);f.removal.start("odysseus",id,reviewed.review.fingerprint);
    for(let i=0;i<500&&!(f.db.query("SELECT count(*) AS n FROM writer_gate_turn_waiters").get() as {n:number}).n;i++)await Bun.sleep(5);
    expect((f.db.query("SELECT count(*) AS n FROM writer_gate_turn_waiters").get() as {n:number}).n,"STORAGE_REMOVAL_QUEUED_EXCLUSIVE").toBe(1);
    expect(readFileSync(join(f.brain,"attachments/chart.pdf")),"STORAGE_REMOVAL_WAITS_FOR_LIVE_WRITER").toEqual(f.original);
    const nested=await f.gate.acquire("shared","nested-index",{signal:AbortSignal.timeout(2000)});nested.release();
    writeFileSync(marker+"-release","finish");expect(await child.exited,await new Response(child.stderr).text()).toBe(0);await f.removal.idle();
    expect(f.removal.receipt("odysseus",id).items[0],"STORAGE_REMOVAL_VALIDATES_AFTER_WRITER").toMatchObject({state:"changed"});
    expect(readFileSync(join(f.brain,"attachments/chart.pdf"),"utf8")).toBe("Athena's concurrent revision");
  }finally{child.kill("SIGKILL");await child.exited;await f.close();}
});
