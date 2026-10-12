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
 const db=createUiDb(path),journal=createTurnJournal(db,{brainPath:brain,dbPath:path,objectsRoot:join(root,"objects")}),gate=createWriterGate(db,brain,{pollMs:1});
 let authorized=true,refreshes=0;
 const reverts=createTurnReverts(db,{brainPath:brain,journal,gate,lock:createKeyedLock(),isAuthorized:id=>authorized&&id==="odysseus",refresh:()=>{refreshes++;}});
 function turn(id:string,actor:"interactive"|"voice"="interactive") {journal.begin(id,{sessionId:"ithaca",actor,model:null,profile:"governed",policyHash:null},error=>{throw error;});writeFileSync(join(brain,"fleet.bin"),Buffer.from([0,254,13]));writeFileSync(join(brain,"new.bin"),Buffer.from([0,253]));journal.finish(id);}
 return {root,brain,db,journal,gate,reverts,turn,get refreshes(){return refreshes;},revoke(){authorized=false;},close(){journal.close();db.close();rmSync(root,{recursive:true,force:true});}};
}
test("whole-turn revert journals the user action; Undo replays its observed bytes without invoking Git",async()=>{
 const f=fixture();try {f.turn("return");expect(()=>f.reverts.start("odysseus","ithaca","return",{id:"odysseus_empty_0001",path:""}),"REVERT_EMPTY_PATH_NEVER_BROADENS_SELECTION").toThrow("No retained eligible paths");const receipt=f.reverts.start("odysseus","ithaca","return",{id:"odysseus_revert_001"});await f.reverts.idle(receipt.id);
 expect(f.reverts.receipt(receipt.id,"odysseus","ithaca","return"),"REVERT_COMPLETE_RECEIPT").toMatchObject({state:"complete",paths:[{path:"fleet.bin",state:"restored"},{path:"new.bin",state:"restored"}]});
 expect(readFileSync(join(f.brain,"fleet.bin")),"REVERT_ORIGINAL_RAW_BYTES").toEqual(Buffer.from([0,255,10]));expect(existsSync(join(f.brain,"new.bin"))).toBe(false);
 const own=f.journal.details("ithaca",receipt.journalTurnId)!;expect(own.summary).toMatchObject({actor:"user",kind:"revert",sourceTurnId:"return",state:"complete"});expect(own.changes.every(item=>item.actor==="user")).toBe(true);
 const undo=f.reverts.start("odysseus","ithaca",receipt.journalTurnId,{id:"odysseus_undo_0001"});await f.reverts.idle(undo.id);
 expect(readFileSync(join(f.brain,"fleet.bin"))).toEqual(Buffer.from([0,254,13]));expect(readFileSync(join(f.brain,"new.bin"))).toEqual(Buffer.from([0,253]));expect(f.refreshes).toBe(2);
 }finally{f.close();}
});
test("later bytes conflict while another path restores; original request identity never performs a second effect",async()=>{
 const f=fixture();try{f.turn("return");writeFileSync(join(f.brain,"fleet.bin"),"Athena's later plan");
 const receipt=f.reverts.start("odysseus","ithaca","return",{id:"odysseus_revert_002"});await f.reverts.idle(receipt.id);
 expect(f.reverts.receipt(receipt.id,"odysseus","ithaca","return"),"REVERT_PARTIAL_CONFLICT_RECEIPT").toMatchObject({state:"partial",paths:[{path:"fleet.bin",state:"conflict"},{path:"new.bin",state:"restored"}]});
 expect(readFileSync(join(f.brain,"fleet.bin"),"utf8")).toBe("Athena's later plan");expect(existsSync(join(f.brain,"new.bin"))).toBe(false);
 writeFileSync(join(f.brain,"new.bin"),"Later new file");expect(f.reverts.start("odysseus","ithaca","return",{id:receipt.id}).state).toBe("partial");expect(readFileSync(join(f.brain,"new.bin"),"utf8"),"REVERT_IDEMPOTENT_NO_SECOND_EFFECT").toBe("Later new file");
 expect(()=>f.reverts.start("odysseus","ithaca","return",{id:receipt.id,path:"fleet.bin"}),"REVERT_IDENTITY_SELECTION_BOUND").toThrow("another request");expect(f.db.query("SELECT kind,actor FROM governance_events WHERE kind='revert_conflict'").get()).toEqual({kind:"revert_conflict",actor:"user"});
 }finally{f.close();}
});
test("queued revert waits for the running turn; revoked user and voice or other-session sources cannot write",async()=>{
 const f=fixture();try{f.turn("return");const hold=await f.gate.acquire("shared","turn:athena",{turn:true});
 const receipt=f.reverts.start("odysseus","ithaca","return",{id:"odysseus_revert_003"});expect(receipt.state).toBe("waiting");f.revoke();hold.release();await f.reverts.idle(receipt.id);
 expect(f.reverts.receipt(receipt.id,"odysseus","ithaca","return")?.state).toBe("failed");expect(readFileSync(join(f.brain,"fleet.bin"))).toEqual(Buffer.from([0,254,13]));
 expect(()=>f.reverts.plan("other","return")).toThrow("not available");f.turn("voice","voice");expect(()=>f.reverts.plan("ithaca","voice")).toThrow("not available");
 }finally{f.close();}
});

test("authenticated history routes reject absent, delegated, voice, and cross-session authority", async () => {
 const { Hono }=await import("hono"),{createTurnRevertRoutes}=await import("../src/routes/turn-revert.js");
 const f=fixture();try{f.turn("return");f.turn("voice","voice");
 const missing=createTurnRevertRoutes(f.reverts);expect((await missing.request("/sessions/ithaca/turns/return/revert/plan")).status,"REVERT_ROUTE_AUTH_REQUIRED").toBe(401);
 for(const kind of ["agent","owner"]){const app=new Hono<any>();app.use("*",async(c,next)=>{c.set("principal",{id:"odysseus",kind});await next();});app.route("/",createTurnRevertRoutes(f.reverts));
 const response=await app.request("/sessions/ithaca/turns/return/revert",{method:"POST",body:JSON.stringify({id:`odysseus_route_${kind}`}),headers:{"content-type":"application/json"}});
 expect(response.status).toBe(kind==="agent"?403:202);if(kind==="owner"){const receipt=await response.json() as {id:string};await f.reverts.idle(receipt.id);expect((await app.request("/sessions/ithaca/turns/voice/revert/plan")).status).toBe(409);expect((await app.request("/sessions/other/turns/return/revert/plan")).status).toBe(409);}}
 }finally{f.close();}
});

test("user restoration recovers observed quarantined bytes without exposing a private quarantine pathname, and Undo removes it",async()=>{
 const f=fixture();try{f.turn("return");const manifest={entries:[]};f.db.query("INSERT INTO governed_turn_manifests (turn_id,brain,pid,pid_start,manifest,started_at,ended_at,reconciliation) VALUES (?,?,?,?,?,?,?,?)").run("return",f.brain,process.pid,"",JSON.stringify(manifest),Date.now()-1,Date.now(),JSON.stringify({turnId:"return",quarantined:[{path:"new.bin",to:join(f.root,"quarantine","held-file")}],changed:[],failed:[]}));rmSync(join(f.brain,"new.bin"));
 const plan=f.reverts.plan("ithaca","return","restore");expect(plan.paths.find(path=>path.path==="new.bin")).toMatchObject({state:"eligible",quarantined:true});expect(JSON.stringify(plan)).not.toContain(f.root);
 const receipt=f.reverts.start("odysseus","ithaca","return",{id:"odysseus_restore_01",path:"new.bin",action:"restore"});await f.reverts.idle(receipt.id);expect(readFileSync(join(f.brain,"new.bin"))).toEqual(Buffer.from([0,253]));
 const undo=f.reverts.start("odysseus","ithaca",receipt.journalTurnId,{id:"odysseus_restore_undo"});await f.reverts.idle(undo.id);expect(existsSync(join(f.brain,"new.bin"))).toBe(false);
 }finally{f.close();}
});

test("expired Undo detail and an interrupted applying receipt never repeat or promise recovery",async()=>{
 const f=fixture();try{f.turn("return");const receipt=f.reverts.start("odysseus","ithaca","return",{id:"odysseus_expiry_001"});await f.reverts.idle(receipt.id);
 expect(f.reverts.receipt(receipt.id,"odysseus","ithaca","return")?.undoAvailable).toBe(true);
 f.db.query("UPDATE turn_journal_turns SET state='expired' WHERE turn_id=?").run(receipt.journalTurnId);
 expect(f.reverts.receipt(receipt.id,"odysseus","ithaca","return")?.undoAvailable,"REVERT_EXPIRED_UNDO_NOT_OFFERED").toBe(false);
 f.db.query("UPDATE turn_journal_revert_operations SET state='applying',pid=2147483647,pid_start='',error=? WHERE id=?").run("".padEnd(64),receipt.id);
 const recovered=f.reverts.start("odysseus","ithaca","return",{id:receipt.id});expect(recovered).toMatchObject({state:"unknown",undoAvailable:false,error:"interrupted_partial_work"});
 expect(readFileSync(join(f.brain,"fleet.bin")),"REVERT_INTERRUPTED_IDENTITY_NEVER_REPLAYS").toEqual(Buffer.from([0,255,10]));
 }finally{f.close();}
});
