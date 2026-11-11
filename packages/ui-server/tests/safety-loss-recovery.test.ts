/** Failed loss-notice COMMITs cannot turn retained input into clean history. */
import {expect,test} from "bun:test";
import {mkdtempSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createUiDb} from "../src/db/client";
import {openSqliteWriter} from "../src/db/write-worker";
import {createGovernanceWrites} from "../src/governance/event-writes";
import {createSafetyCollector} from "../src/governance/safety-collector";
import {holdSafetyRecovery} from "./helpers/hold-safety-recovery";
import {recoverSafetyRecording,safetyCatalogCreated,endSafetyCollection} from "../src/governance/safety-store";

async function fixture(stopThrows=false){
 const root=mkdtempSync(join(tmpdir(),"odysseus-loss-recovery-")),path=join(root,"ui.db"),db=createUiDb(path),writer=openSqliteWriter(db),writes=createGovernanceWrites(db,writer);
 // These tests drive recovery by hand; the automatic reconciler must not race them.
 holdSafetyRecovery(db);
 const controller=new AbortController(),bindingId=crypto.randomUUID();
 await writes.safetyBegin({turnId:"voyage",bindingId,sessionId:null,principalId:"odysseus",backendId:"pi",at:0});
 db.exec("INSERT INTO sessions(id,created_at,last_active_at) VALUES('ithaca',0,0); INSERT INTO chat_session_owners VALUES('ithaca','odysseus',0)");
 safetyCatalogCreated(db,"ithaca","odysseus","voyage");await writes.bind("voyage","ithaca");
 const collector=createSafetyCollector(db,writes,{turnId:"voyage",bindingId,sessionId:()=>"ithaca",backendId:"pi",shellProxied:()=>false,signal:controller.signal,stop:()=>{controller.abort();if(stopThrows)throw new Error("Producer stop failed");}});await collector.ready("pi",1);
 // This real deferred FK fails at COMMIT after the loss flag was written,
 // rolling back the complete notice transaction on the FULL writer.
 db.exec("CREATE TABLE loss_commit_probe(id TEXT REFERENCES safety_records(id) DEFERRABLE INITIALLY DEFERRED); CREATE TRIGGER fail_loss_notice AFTER UPDATE OF failed ON safety_meta WHEN NEW.failed=1 BEGIN INSERT INTO loss_commit_probe VALUES('missing-raft'); END; CREATE TRIGGER fail_loss_notice_chat AFTER UPDATE OF failure ON safety_collections WHEN NEW.failure IS NOT NULL AND EXISTS(SELECT 1 FROM sqlite_master WHERE type='trigger' AND name='fail_loss_notice') BEGIN INSERT INTO loss_commit_probe VALUES('missing-raft'); END");
 return {root,path,db,writer,writes,collector,async close(){await writer.close();db.close();rmSync(root,{recursive:true,force:true});}};
}

test("a failed collector-loss COMMIT fences every facade, completion and later collection",async()=>{
 const f=await fixture();try{
 expect(f.writes.safety(null,"ithaca").restriction).toBe("normal");
 const result=f.collector.unavailable!().then(()=>null,error=>error);
 const immediate=f.writes.recordingAvailable("voyage","ithaca");
 await result;
 expect(f.db.query("SELECT failed FROM safety_meta").get(),"SAFETY_LOSS_NOTICE_ACTUALLY_ROLLED_BACK").toEqual({failed:0});
 expect(f.db.query("SELECT COUNT(*) n FROM loss_commit_probe").get()).toEqual({n:0});
 expect(immediate,"SAFETY_LOSS_RESTRICTS_BEFORE_NOTICE_COMMIT").toBe(false);
 for(const [index,writes] of [f.writes,createGovernanceWrites(f.db,f.writer)].entries()){
  expect(writes.recordingAvailable("voyage","ithaca"),"SAFETY_FAILED_LOSS_NOTICE_REMAINS_UNAVAILABLE").toBe(false);
  expect(writes.safety(null,"ithaca").restriction).toBe("restricted");
  expect(writes.safety(null,"ithaca").coverage.state,"SAFETY_FAILED_NOTICE_NEVER_ADVERTISES_COMPLETE_COVERAGE").toBe("incomplete");
  // A later turn runs restricted (#3812): its permanent gap commits before any delivery.
  const turnId=`next-${index}`;
  await writes.safetyBegin({turnId,bindingId:crypto.randomUUID(),sessionId:"ithaca",principalId:"odysseus",backendId:"pi",at:1});
  expect(f.db.query("SELECT restricted_begin,gap FROM safety_collections WHERE turn_id=?").get(turnId),"SAFETY_FAILED_LOSS_NOTICE_BEGINS_RESTRICTED").toEqual({restricted_begin:1,gap:"recording_failed"});
  expect(writes.safety(turnId,"ithaca").restriction,"SAFETY_FAILED_LOSS_NOTICE_NEW_TURN_IS_RESTRICTED").toBe("restricted");
 }
 const end=await f.writes.safetyEnd("voyage").then(()=>null,error=>error);
 expect(String(end),"SAFETY_CANNOT_SEAL_HISTORY_WITHOUT_LOSS_FACT").toContain("FOREIGN KEY constraint failed");
 expect(f.db.query("SELECT ended FROM safety_collections WHERE turn_id='voyage'").get()).toEqual({ended:0});
 }finally{await f.close();}
});

for(const endedOutsideFacade of [false,true])test(`loss recovery retains its exact historical gap${endedOutsideFacade?" after an earlier producer completion":""}`,async()=>{
 const f=await fixture();try{
 await f.collector.unavailable!().catch(()=>{});
 f.db.exec("DROP TRIGGER fail_loss_notice");
 if(endedOutsideFacade)endSafetyCollection(f.db,"voyage");else await f.writes.safetyEnd("voyage");
 // Even when only the in-process loss marker survived COMMIT failure,
 // recovery must commit the affected history gap before resetting it.
 f.db.exec("CREATE TRIGGER refuse_loss_recovery AFTER UPDATE OF failed ON safety_meta WHEN NEW.failed=0 BEGIN INSERT INTO loss_commit_probe VALUES('missing-recovery'); END");
 expect(()=>recoverSafetyRecording(f.db)).toThrow("FOREIGN KEY constraint failed");
 expect(f.writes.recordingAvailable("voyage","ithaca")).toBe(false);
 f.db.exec("DROP TRIGGER refuse_loss_recovery");recoverSafetyRecording(f.db);
 const state=f.writes.safety(null,"ithaca");
 expect(state.coverage.state,"SAFETY_RECOVERY_COMMITS_FAILED_NOTICE_HISTORY_GAP").toBe("incomplete");
 expect(state.restriction).toBe("restricted");expect(state.unresolvedCount).toBe(0);
 const next=createGovernanceWrites(f.db,f.writer);
 await next.safetyBegin({turnId:"next",bindingId:crypto.randomUUID(),sessionId:"ithaca",principalId:"odysseus",backendId:"pi",at:1});await next.safetyReady("next","pi",1);
 expect(next.recordingAvailable("next","ithaca")).toBe(true);
 expect(next.safety("next","ithaca").coverage.state).toBe("incomplete");
 }finally{await f.close();}
});

test("restart cannot turn an uncommitted loss notice into complete history",async()=>{
 const f=await fixture();try{
 await f.collector.unavailable!().catch(()=>{});
 await f.writes.safetyEnd("voyage").catch(()=>{});
 await f.writer.close();f.db.close();
 const db=createUiDb(f.path),writer=openSqliteWriter(db),writes=createGovernanceWrites(db,writer);
 try{
  expect(writes.safety(null,"ithaca").coverage.state,"SAFETY_FAILED_LOSS_NOTICE_SURVIVES_RESTART").toBe("incomplete");
  expect(writes.safety(null,"ithaca").restriction).toBe("restricted");
 }finally{await writer.close();db.close();}
 }finally{rmSync(f.root,{recursive:true,force:true});}
});

test("a throwing producer-stop callback cannot bypass loss retention",async()=>{
 const f=await fixture(true);try{
 await f.collector.unavailable!().catch(()=>{});
 expect(f.writes.recordingAvailable("voyage","ithaca"),"SAFETY_STOP_EXCEPTION_NEVER_BYPASSES_LOSS_RETENTION").toBe(false);
 const end=await f.writes.safetyEnd("voyage").then(()=>null,error=>error);
 expect(String(end)).toContain("FOREIGN KEY constraint failed");
 f.db.exec("DROP TRIGGER fail_loss_notice");await f.writes.safetyEnd("voyage");recoverSafetyRecording(f.db);
 expect(f.writes.safety(null,"ithaca").coverage.state).toBe("incomplete");
 }finally{await f.close();}
});
