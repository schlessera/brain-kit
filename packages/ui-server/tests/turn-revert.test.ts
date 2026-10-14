import { createNativeJournalFixture } from "./helpers/native-journal-fixture.js";
import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createKeyedLock } from "@schlessera/brain-ui-sdk/server";
import { createUiDb } from "../src/db/client.js";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { createWriterGate } from "../src/brain/writer-gate.js";
import { createTurnReverts } from "../src/brain/turn-revert.js";
function fixture() {
 const root=mkdtempSync(join(tmpdir(),"odysseus-revert-")),brain=join(root,"brain"),path=join(root,"ui.db");mkdirSync(brain);
 writeFileSync(join(brain,"fleet.bin"),Buffer.from([0,255,10]));
 const native=createNativeJournalFixture(brain,root);
 const db=createUiDb(path),journal=createTurnJournal(db,{nativeManager:native.manager,brainPath:brain,dbPath:path,objectsRoot:join(root,"objects")}),gate=createWriterGate(db,brain,{pollMs:1});
 let authorized=true,refreshes=0;
 const reverts=createTurnReverts(db,{brainPath:brain,journal,gate,lock:createKeyedLock(),isAuthorized:id=>authorized&&id==="odysseus",refresh:()=>{refreshes++;}});
 async function turn(id:string,actor:"interactive"|"voice"="interactive") {await journal.begin(id,{sessionId:"ithaca",actor,model:null,profile:"governed",policyHash:null},error=>{throw error;});writeFileSync(join(brain,"fleet.bin"),Buffer.from([0,254,13]));writeFileSync(join(brain,"new.bin"),Buffer.from([0,253]));await journal.finish(id);}
 return {root,brain,db,journal,gate,reverts,turn,get refreshes(){return refreshes;},revoke(){authorized=false;},async close(){await journal.close();await native.close();db.close();rmSync(root,{recursive:true,force:true});}};
}
test("whole-turn revert journals the user action; Undo replays its observed bytes without invoking Git",async()=>{
 const f=fixture();try {await f.turn("return");expect(()=>f.reverts.start("odysseus","ithaca","return",{id:"odysseus_empty_0001",path:""}),"REVERT_EMPTY_PATH_NEVER_BROADENS_SELECTION").toThrow("No retained eligible paths");const receipt=f.reverts.start("odysseus","ithaca","return",{id:"odysseus_revert_001"});await f.reverts.idle(receipt.id);
 expect(f.reverts.receipt(receipt.id,"odysseus","ithaca","return"),"REVERT_COMPLETE_RECEIPT").toMatchObject({state:"complete",paths:[{path:"fleet.bin",state:"restored"},{path:"new.bin",state:"restored"}]});
 expect(readFileSync(join(f.brain,"fleet.bin")),"REVERT_ORIGINAL_RAW_BYTES").toEqual(Buffer.from([0,255,10]));expect(existsSync(join(f.brain,"new.bin"))).toBe(false);
 const own=f.journal.details("ithaca",receipt.journalTurnId)!;expect(own.summary).toMatchObject({actor:"user",kind:"revert",sourceTurnId:"return",state:"complete"});expect(own.changes.every(item=>item.actor==="user")).toBe(true);
 const undo=f.reverts.start("odysseus","ithaca",receipt.journalTurnId,{id:"odysseus_undo_0001"});await f.reverts.idle(undo.id);
 expect(readFileSync(join(f.brain,"fleet.bin"))).toEqual(Buffer.from([0,254,13]));expect(readFileSync(join(f.brain,"new.bin"))).toEqual(Buffer.from([0,253]));expect(f.refreshes).toBe(2);
 }finally{await f.close();}
});
test("later bytes conflict while another path restores; original request identity never performs a second effect",async()=>{
 const f=fixture();try{await f.turn("return");writeFileSync(join(f.brain,"fleet.bin"),"Athena's later plan");
 const receipt=f.reverts.start("odysseus","ithaca","return",{id:"odysseus_revert_002"});await f.reverts.idle(receipt.id);
 expect(f.reverts.receipt(receipt.id,"odysseus","ithaca","return"),"REVERT_PARTIAL_CONFLICT_RECEIPT").toMatchObject({state:"partial",paths:[{path:"fleet.bin",state:"conflict"},{path:"new.bin",state:"restored"}]});
 expect(readFileSync(join(f.brain,"fleet.bin"),"utf8")).toBe("Athena's later plan");expect(existsSync(join(f.brain,"new.bin"))).toBe(false);
 writeFileSync(join(f.brain,"new.bin"),"Later new file");expect(f.reverts.start("odysseus","ithaca","return",{id:receipt.id}).state).toBe("partial");expect(readFileSync(join(f.brain,"new.bin"),"utf8"),"REVERT_IDEMPOTENT_NO_SECOND_EFFECT").toBe("Later new file");
 expect(()=>f.reverts.start("odysseus","ithaca","return",{id:receipt.id,path:"fleet.bin"}),"REVERT_IDENTITY_SELECTION_BOUND").toThrow("another request");expect(f.db.query("SELECT kind,actor FROM governance_events WHERE kind='revert_conflict'").get()).toEqual({kind:"revert_conflict",actor:"user"});
 }finally{await f.close();}
});
test("queued revert waits for the running turn; revoked user and voice or other-session sources cannot write",async()=>{
 const f=fixture();try{await f.turn("return");const hold=await f.gate.acquire("shared","turn:athena",{turn:true});
 const receipt=f.reverts.start("odysseus","ithaca","return",{id:"odysseus_revert_003"});expect(receipt.state).toBe("waiting");f.revoke();hold.release();await f.reverts.idle(receipt.id);
 expect(f.reverts.receipt(receipt.id,"odysseus","ithaca","return")?.state).toBe("failed");expect(readFileSync(join(f.brain,"fleet.bin"))).toEqual(Buffer.from([0,254,13]));
 expect(()=>f.reverts.plan("other","return")).toThrow("not available");await f.turn("voice","voice");expect(()=>f.reverts.plan("ithaca","voice")).toThrow("not available");
 }finally{await f.close();}
});

test("authenticated history routes reject absent, delegated, voice, and cross-session authority", async () => {
 const { Hono }=await import("hono"),{createTurnRevertRoutes}=await import("../src/routes/turn-revert.js");
 const f=fixture();try{await f.turn("return");await f.turn("voice","voice");
 const missing=createTurnRevertRoutes(f.reverts);expect((await missing.request("/sessions/ithaca/turns/return/revert/plan")).status,"REVERT_ROUTE_AUTH_REQUIRED").toBe(401);
 for(const kind of ["agent","owner"]){const app=new Hono<any>();app.use("*",async(c,next)=>{c.set("principal",{id:"odysseus",kind});await next();});app.route("/",createTurnRevertRoutes(f.reverts));
 const response=await app.request("/sessions/ithaca/turns/return/revert",{method:"POST",body:JSON.stringify({id:`odysseus_route_${kind}`}),headers:{"content-type":"application/json"}});
 expect(response.status).toBe(kind==="agent"?403:202);if(kind==="owner"){const receipt=await response.json() as {id:string};await f.reverts.idle(receipt.id);expect((await app.request("/sessions/ithaca/turns/voice/revert/plan")).status).toBe(409);expect((await app.request("/sessions/other/turns/return/revert/plan")).status).toBe(409);}}
 }finally{await f.close();}
});

test("user restoration recovers observed quarantined bytes without exposing a private quarantine pathname, and Undo removes it",async()=>{
 const f=fixture();try{await f.turn("return");const manifest={entries:[]};f.db.query("INSERT INTO governed_turn_manifests (turn_id,brain,pid,pid_start,manifest,started_at,ended_at,reconciliation) VALUES (?,?,?,?,?,?,?,?)").run("return",f.brain,process.pid,"",JSON.stringify(manifest),Date.now()-1,Date.now(),JSON.stringify({turnId:"return",quarantined:[{path:"new.bin",to:join(f.root,"quarantine","held-file")}],changed:[],failed:[]}));rmSync(join(f.brain,"new.bin"));
 const plan=f.reverts.plan("ithaca","return","restore");expect(plan.paths.find(path=>path.path==="new.bin")).toMatchObject({state:"eligible",quarantined:true});expect(JSON.stringify(plan)).not.toContain(f.root);
 const receipt=f.reverts.start("odysseus","ithaca","return",{id:"odysseus_restore_01",path:"new.bin",action:"restore"});await f.reverts.idle(receipt.id);expect(readFileSync(join(f.brain,"new.bin"))).toEqual(Buffer.from([0,253]));
 const undo=f.reverts.start("odysseus","ithaca",receipt.journalTurnId,{id:"odysseus_restore_undo"});await f.reverts.idle(undo.id);expect(existsSync(join(f.brain,"new.bin"))).toBe(false);
 }finally{await f.close();}
});

test("expired Undo detail and an interrupted applying receipt never repeat or promise recovery",async()=>{
 const f=fixture();try{await f.turn("return");const receipt=f.reverts.start("odysseus","ithaca","return",{id:"odysseus_expiry_001"});await f.reverts.idle(receipt.id);
 expect(f.reverts.receipt(receipt.id,"odysseus","ithaca","return")?.undoAvailable).toBe(true);
 f.db.query("UPDATE turn_journal_turns SET state='expired' WHERE turn_id=?").run(receipt.journalTurnId);
 expect(f.reverts.receipt(receipt.id,"odysseus","ithaca","return")?.undoAvailable,"REVERT_EXPIRED_UNDO_NOT_OFFERED").toBe(false);
 f.db.query("UPDATE turn_journal_revert_operations SET state='applying',pid=2147483647,pid_start='',error=? WHERE id=?").run("".padEnd(64),receipt.id);
 const recovered=f.reverts.start("odysseus","ithaca","return",{id:receipt.id});expect(recovered).toMatchObject({state:"unknown",undoAvailable:false,error:"interrupted_partial_work"});
 expect(readFileSync(join(f.brain,"fleet.bin")),"REVERT_INTERRUPTED_IDENTITY_NEVER_REPLAYS").toEqual(Buffer.from([0,255,10]));
 }finally{await f.close();}
});

async function observedShellConflict(f: ReturnType<typeof fixture>) {
  const a = await f.gate.acquire("shared", "turn:odysseus", { turn: true }), b = await f.gate.acquire("shared", "turn:athena", { turn: true });
  const metadata = { sessionId: "ithaca", actor: "interactive" as const, model: null, profile: "governed" as const, policyHash: null };
  try {
    await f.journal.begin("shell-a", metadata, error => { throw error; }); await f.journal.begin("shell-b", metadata, error => { throw error; });
    for (const bytes of ["Odysseus observed version\n", "Athena observed version\n"]) {
      const child = Bun.spawn(["bash", "-c", 'printf "%s" "$2" > "$1"', "odysseus-fixture", join(f.brain, "fleet.bin"), bytes], { stdout: "pipe", stderr: "pipe", stdin: "ignore" });
      expect(await child.exited).toBe(0); expect(await new Response(child.stderr).text()).toBe("");
      await f.journal.observe();
      if (bytes.startsWith("Odysseus")) expect(f.journal.details("ithaca", "shell-a")!.changes[0], "CONFLICT_SINGLE_OVERLAP_IS_ONLY_SHARED").not.toHaveProperty("conflict");
    }
    await f.journal.finish("shell-a"); await f.journal.finish("shell-b");
  } finally { a.release(); b.release(); }
  return f.journal.details("ithaca", "shell-a")!;
}
test("overlapping actual shell writes retain explicit conflict versions and user keep-both creates a numbered sibling without overwriting", async () => {
  const f = fixture();
  try {
    const details = await observedShellConflict(f), change = details.changes.at(-1)!;
    expect(change.conflict, "CONFLICT_TWO_OBSERVED_VERSIONS").toBeDefined();
    const versions = change.conflict!.versions, expected = change.conflict!.latest;
    expect(versions).toHaveLength(2);
    expect(versions.map(ref => f.journal.version("ithaca", ref.turnId, ref.sequence, ref.side)!.bytes(1024).toString()), "CONFLICT_OBSERVED_RAW_VERSIONS").toEqual(["Odysseus observed version\n", "Athena observed version\n"]);
    writeFileSync(join(f.brain, "fleet.bin-remote"), "Penelope's existing sibling\n");
    const request = { id: "odysseus_keep_both_01", path: "fleet.bin", action: "keep_both" as const, version: versions[0]!, otherVersion: versions[1]!, expected };
    const receipt = f.reverts.start("odysseus", "ithaca", "shell-a", request); await f.reverts.idle(receipt.id);
    expect(f.reverts.receipt(receipt.id, "odysseus", "ithaca", "shell-a"), "CONFLICT_KEEP_BOTH_RECORDED").toMatchObject({ state: "complete", undoAvailable: true });
    expect(readFileSync(join(f.brain, "fleet.bin"), "utf8")).toBe("Odysseus observed version\n");
    expect(readFileSync(join(f.brain, "fleet.bin-remote"), "utf8"), "CONFLICT_EXISTING_SIBLING_PRESERVED").toBe("Penelope's existing sibling\n");
    expect(readFileSync(join(f.brain, "fleet.bin-remote-2"), "utf8")).toBe("Athena observed version\n");
    expect(f.journal.details("ithaca", receipt.journalTurnId)!.changes.map(item => item.path)).toEqual(["fleet.bin", "fleet.bin-remote-2"]);
    expect(f.refreshes).toBe(1);
    expect(f.reverts.start("odysseus", "ithaca", "shell-a", request).id).toBe(receipt.id);
    const undo = f.reverts.start("odysseus", "ithaca", receipt.journalTurnId, { id: "odysseus_keep_both_undo" }); await f.reverts.idle(undo.id);
    expect(readFileSync(join(f.brain, "fleet.bin"), "utf8")).toBe("Athena observed version\n"); expect(existsSync(join(f.brain, "fleet.bin-remote-2"))).toBe(false);
  } finally { await f.close(); }
});
test("explicit conflict choice refuses later current bytes, forged observations, other-session and voice authority", async () => {
  const f = fixture();
  try {
    const details = await observedShellConflict(f), conflict = details.changes.at(-1)!.conflict!;
    expect(conflict, "CONFLICT_CHOICE_HAS_RETAINED_EVIDENCE").toBeDefined();
    const request = { id: "odysseus_keep_version_01", path: "fleet.bin", action: "keep_version" as const, version: conflict.versions[0]!, expected: conflict.latest };
    expect(() => f.reverts.start("odysseus", "other", "shell-a", request)).toThrow();
    expect(() => f.reverts.start("odysseus", "ithaca", "shell-a", { ...request, version: { ...request.version, turnId: "shell-b" } }), "CONFLICT_SELECTION_CANNOT_BORROW_OBSERVATION").toThrow();
    writeFileSync(join(f.brain, "fleet.bin"), "Penelope's later work\n");
    const receipt = f.reverts.start("odysseus", "ithaca", "shell-a", request); await f.reverts.idle(receipt.id);
    expect(f.reverts.receipt(receipt.id, "odysseus", "ithaca", "shell-a"), "CONFLICT_REVIEWED_CURRENT_RAW_STATE").toMatchObject({ state: "partial", paths: [{ path: "fleet.bin", state: "conflict" }] });
    expect(readFileSync(join(f.brain, "fleet.bin"), "utf8")).toBe("Penelope's later work\n");
  } finally { await f.close(); }
});

test("keep-both explicitly covers its final sibling under ignored names and Undo retains that observed version", async () => {
  const f=fixture();
  try {
    writeFileSync(join(f.brain,".gitignore"),"fleet.bin-remote*\n");
    const details=await observedShellConflict(f), conflict=details.changes.at(-1)!.conflict!;
    const request={id:"odysseus_ignored_both",path:"fleet.bin",action:"keep_both" as const,version:conflict.versions[0]!,otherVersion:conflict.versions[1]!,expected:conflict.latest};
    const receipt=f.reverts.start("odysseus","ithaca","shell-a",request);await f.reverts.idle(receipt.id);
    const sibling=f.journal.details("ithaca",receipt.journalTurnId)!.changes.find(change=>change.path==="fleet.bin-remote")!;
    expect(sibling.after,"CONFLICT_IGNORED_SIBLING_EXPLICIT_RAW_COVERAGE").toMatchObject({ignored:false,hash:expect.any(String)});
    expect(f.journal.version("ithaca",receipt.journalTurnId,sibling.sequence,"after")!.bytes(1024).toString()).toBe("Athena observed version\n");
    const undo=f.reverts.start("odysseus","ithaca",receipt.journalTurnId,{id:"odysseus_ignored_undo"});await f.reverts.idle(undo.id);
    expect(existsSync(join(f.brain,"fleet.bin-remote"))).toBe(false);
  } finally {await f.close();}
});
