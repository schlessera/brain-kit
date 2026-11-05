import { expectRejection } from "./helpers/expect-rejection";
import { expect,test } from "bun:test";
import { mkdtempSync,rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createUiDb } from "../src/db/client";
import { openSqliteWriter } from "../src/db/write-worker";
import { createGovernanceWrites } from "../src/governance/event-writes";
import { createSafetyCollector } from "../src/governance/safety-collector";
import { safetyCatalogCreated,safetyProjection,safetyRecords,pruneSafetyDetail } from "../src/governance/safety-store";
import { governanceEventRow } from "../src/governance/events";
import * as procedures from "../src/governance/event-writes";
import * as decisions from "./fixtures/safety-decision-seed";

function fixture(){const root=mkdtempSync(join(tmpdir(),"odysseus-safety-ledger-")),path=join(root,"ui.db");
 const db=createUiDb(path),writer=openSqliteWriter(db),writes=createGovernanceWrites(db,writer);
 return {root,path,db,writer,writes,async close(){await writer.close();db.close();rmSync(root,{recursive:true,force:true});}};}
async function fresh(f:ReturnType<typeof fixture>,turnId="voyage",sessionId="ithaca"){
 const bindingId=crypto.randomUUID();await f.writes.safetyBegin({turnId,bindingId,sessionId:null,principalId:"odysseus",backendId:"claude",at:0});
 f.db.query("INSERT INTO sessions(id,created_at,last_active_at,backend_id) VALUES(?,0,0,'claude')").run(sessionId);
 f.db.query("INSERT INTO chat_session_owners VALUES(?,'odysseus',0)").run(sessionId);
 safetyCatalogCreated(f.db,sessionId,"odysseus",turnId);
 await f.writes.bind(turnId,sessionId);
 const collector=createSafetyCollector(f.db,f.writes,{turnId,bindingId,sessionId:()=>sessionId,backendId:"claude",signal:new AbortController().signal,shellProxied:()=>true,brainPath:"/srv/ithaca"});
 await collector.ready("claude",1);return {bindingId,collector};
}
const triggers=(f:ReturnType<typeof fixture>,sid="ithaca")=>safetyRecords(f.db,sid).filter(r=>r.kind==="occurrence");

test("complete durable aggregate retains B/C after a committed decision for A, independently of pruned pages",async()=>{
 const f=fixture();try{const {collector}=await fresh(f);
 expect(f.writes.safety("voyage","ithaca").restriction,"SAFETY_NEW_CONNECTED_COLLECTION_CAN_BE_NORMAL").toBe("normal");
 for(const id of ["A","B","C"]){await collector.begin(id,"WebFetch",{url:"https://ithaca.invalid/notice"});await collector.result(id,"WebFetch","Ithaca",true);}
 const [a,b,c]=triggers(f),seed=f.writer.channel(decisions,undefined);
 await seed.call("seed",a!.id,"ithaca");
 const remaining=f.writes.safety("voyage","ithaca");
 expect(remaining.unresolvedCount,"SAFETY_REMAINING_TRIGGER_RESTRICTION").toBe(2);
 expect(remaining.restriction,"SAFETY_REMAINING_TRIGGER_RESTRICTION").toBe("restricted");
 expect(remaining.earliestUnresolvedId).toBe(b!.id);
 pruneSafetyDetail(f.db,Number.MAX_SAFE_INTEGER);
 expect(safetyRecords(f.db,"ithaca",1)[0]?.detailPruned).toBe(true);
 expect(f.writes.safety(null,"ithaca").unresolvedCount,"SAFETY_DETAIL_PRUNING_NEVER_CLEARS").toBe(2);
 await seed.call("seed",b!.id,"ithaca");expect(f.writes.safety(null,"ithaca").unresolvedCount).toBe(1);
 await seed.call("seed",c!.id,"ithaca");expect(f.writes.safety(null,"ithaca").restriction).toBe("normal");
 }finally{await f.close();}});

test("real upgrade classifies old sessions both with and without first-taint rows",async()=>{
 const f=fixture();await f.writer.close();
 try{
 f.db.exec("PRAGMA foreign_keys=OFF");
 const triggers=f.db.query("SELECT name FROM sqlite_master WHERE type='trigger' AND name LIKE 'safety_%'").all() as {name:string}[];
 for(const {name} of triggers)f.db.exec(`DROP TRIGGER ${name}`);
 const tables=f.db.query("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'safety_%'").all() as {name:string}[];
 for(const {name} of tables)f.db.exec(`DROP TABLE ${name}`);
 f.db.query("DELETE FROM _migrations WHERE filename='081_session_safety.sql'").run();
 f.db.exec("INSERT INTO sessions(id,created_at,last_active_at) VALUES('legacy-clean',0,0),('legacy-tainted',0,0); INSERT INTO dialogue_owners VALUES('legacy-provisional','odysseus',NULL,1,'complete',0)");
 f.db.query("INSERT INTO governance_events(session_id,turn_id,at,kind,schema_version,actor,payload) VALUES('legacy-tainted','old-turn',0,'taint',1,'interactive',?)")
 .run(JSON.stringify({source:"web_fetch",tool:"WebFetch",detail:null}));
 f.db.close();const restored=createUiDb(f.path),replayWriter=openSqliteWriter(restored),replayWrites=createGovernanceWrites(restored,replayWriter);
 try{
 const clean=safetyProjection(restored,null,"legacy-clean"),tainted=safetyProjection(restored,null,"legacy-tainted");
 expect(clean.restriction,"SAFETY_LEGACY_NO_ROW_IS_NOT_CLEAN").toBe("restricted");expect(clean.coverage.state).toBe("incomplete");expect(clean.unresolvedCount).toBe(0);
 expect(tainted.unresolvedCount,"SAFETY_LEGACY_ROW_MIGRATES_AS_ONE_KNOWN_EVENT").toBe(1);expect(tainted.coverage.state).toBe("incomplete");
 expect(tainted.coverage.epochs.some(e=>e.reason==="missing_historical_signals")).toBe(true);
 await replayWrites.safetyBegin({turnId:"legacy-provisional-resume",bindingId:crypto.randomUUID(),historyOwnerId:"legacy-provisional",principalId:"odysseus",sessionId:null,backendId:"claude",at:1});
 await replayWrites.safetyReady("legacy-provisional-resume","claude",1);
 expect(replayWrites.safety("legacy-provisional-resume",null).coverage.state,"SAFETY_LEGACY_PROVISIONAL_NO_ROW_IS_NOT_CLEAN").toBe("incomplete");
 }finally{await replayWriter.close();restored.close();}
 }finally{rmSync(f.root,{recursive:true,force:true});}});

test("an admitted reservation survives real writer restart and fences a new facade and new chat",async()=>{
 const f=fixture();try{await fresh(f);
 const row=governanceEventRow({kind:"taint",turnId:"voyage",sessionId:"ithaca",actor:"interactive",model:null,profile:null,payload:{source:"web_fetch",tool:"WebFetch",detail:null}});
 const channel=f.writer.channel(procedures,undefined);await channel.call("safetyReserve",row,"pending-restart",128);
 expect(f.writes.safety(null,"ithaca").pendingCount).toBe(1);
 await f.writer.close();f.db.close();const db=createUiDb(f.path),writer=openSqliteWriter(db),writes=createGovernanceWrites(db,writer);
 try{const state=writes.safety(null,"ithaca");expect(state.restriction,"SAFETY_PENDING_RESTART_NEVER_APPEARS_NORMAL").toBe("restricted");expect(state.reasons).toContain("recording_failed");
 await expectRejection(writes.safetyBegin({turnId:"new-chat",bindingId:crypto.randomUUID(),sessionId:null,principalId:"odysseus",backendId:"claude",at:1}),"recovery");
 }finally{await writer.close();db.close();}
 }finally{rmSync(f.root,{recursive:true,force:true});}});

test("brain row capacity uses a preallocated durable failure cell and refuses another chat",async()=>{
 const f=fixture();try{const {collector}=await fresh(f);
 f.db.query("UPDATE safety_meta SET used_rows=999999").run();
 const refused=await collector.begin("overflow","WebFetch",{url:"https://ithaca.invalid"}).then(()=>null,error=>error);
 expect(String(refused),"SAFETY_CAPACITY_REFUSAL").toContain("capacity");
 expect(f.db.query("SELECT length(padding) n FROM safety_emergency_reserve").get(),"SAFETY_EMERGENCY_CELL_PREALLOCATED").toEqual({n:0});
 const another=createGovernanceWrites(f.db,f.writer);expect(another.safety(null,"ithaca").restriction).toBe("restricted");
 await expectRejection(another.safetyBegin({turnId:"new-chat",bindingId:crypto.randomUUID(),sessionId:null,principalId:"odysseus",backendId:"claude",at:1}),"recovery");
 }finally{await f.close();}});

test("backend change and resume retain epochs; inherited fork restrictions and coverage never reset",async()=>{
 const f=fixture();try{const {collector}=await fresh(f);
 await collector.begin("notice","WebFetch",{url:"https://ithaca.invalid"});await collector.result("notice","WebFetch","Ithaca",true);await f.writes.safetyEnd("voyage");
 const id=crypto.randomUUID();await f.writes.safetyBegin({turnId:"resumed",bindingId:id,sessionId:"ithaca",principalId:"odysseus",backendId:"pi",at:1});
 expect(f.writes.safety(null,"ithaca").coverage.state).toBe("incomplete");await f.writes.safetyReady("resumed","pi",1);
 expect(f.writes.safety(null,"ithaca").coverage.epochs.map(e=>e.backendId)).toEqual(["claude","pi"]);
 expect(f.writes.safety(null,"ithaca").coverage.epochs[1]?.reason).toBe("backend_history_not_reconstructed");
 await f.writes.safetyBegin({turnId:"fork",bindingId:crypto.randomUUID(),sessionId:null,principalId:"odysseus",backendId:"claude",sourceSessionId:"ithaca",at:2});
 expect(f.writes.safety("fork",null).unresolvedCount,"SAFETY_FORK_INHERITS_UNRESOLVED_CONTEXT").toBe(1);
 expect(f.writes.safety("fork",null).restriction).toBe("restricted");
 await f.writes.safetyReady("fork","claude",1);
 expect(f.writes.safety("fork",null).coverage.state,"SAFETY_FORK_ACK_CANNOT_RECONSTRUCT_NATIVE_HISTORY").toBe("incomplete");
 }finally{await f.close();}});

test("a later durable occurrence cannot disappear from the remaining-restriction aggregate",async()=>{
 const f=fixture();try{const {bindingId}=await fresh(f);
 const {occurrence}=await import("../src/governance/occurrence");
 for(const call of ["A","B","C"]){const item=occurrence(bindingId,"tool_web_input",call,"finalized");await f.writes.firstTaint({kind:"taint",turnId:"voyage",sessionId:"ithaca",actor:"interactive",model:null,profile:null,payload:{source:"web_fetch",tool:"WebFetch",detail:null,occurrence:item}});}
 const first=triggers(f)[0]!;await f.writer.channel(decisions,undefined).call("seed",first.id,"ithaca");
 const projection=f.writes.safety(null,"ithaca");
 expect(projection.unresolvedCount,"SAFETY_DROPPED_LATER_OCCURRENCE_REMAINS_RESTRICTED").toBe(2);
 expect(projection.restriction,"SAFETY_DROPPED_LATER_OCCURRENCE_REMAINS_RESTRICTED").toBe("restricted");
 }finally{await f.close();}});

test("provisional retirement refuses null-session late callbacks even after private safety detail removal",async()=>{
 const f=fixture();try{
 const {createPrincipal}=await import("../src/db/principals"),{retireChat}=await import("../src/ws/chat-lifecycle");
 const {cleanChatStore}=await import("../src/ws/chat-store-cleanup");
 const principal=createPrincipal(f.db,{authMethod:"password",label:"Odysseus",ttlSeconds:60});
 f.db.query("INSERT INTO dialogue_owners VALUES('provisional',?,NULL,1,'complete',0)").run(principal.id);
 await f.writes.safetyBegin({turnId:"provisional-turn",bindingId:crypto.randomUUID(),historyOwnerId:"provisional",principalId:principal.id,sessionId:null,backendId:"claude",at:0});
 await f.writes.firstTaint({kind:"taint",turnId:"provisional-turn",sessionId:null,actor:"interactive",model:null,profile:null,payload:{source:"web_fetch",tool:"WebFetch",detail:null}});
 const retired=retireChat(f.db,{operationId:"retire-provisional",principalId:principal.id,target:{ownerId:"provisional"},expected:{backendId:null,generation:1},removableBackends:[],at:Date.now()});
 expect(retired.status).toBe("retired");if(retired.status!=="retired")throw new Error("Expected retirement");
 cleanChatStore(f.db,retired.lifecycleId,"projections",Date.now());
 expect(f.db.query("SELECT COUNT(*) n FROM safety_records").get(),"SAFETY_PRIVATE_DETAIL_REMOVED").toEqual({n:0});
 await f.writer.close();const replay=createUiDb(f.path),replayWriter=openSqliteWriter(replay),replayWrites=createGovernanceWrites(replay,replayWriter);
 try{
  expect(replay.query("SELECT COUNT(*) n FROM safety_records").get(),"SAFETY_RESTART_NEVER_REIMPORTS_RETIRED_PRIVATE_EVIDENCE").toEqual({n:0});
  await expectRejection(replayWrites.firstTaint({kind:"taint",turnId:"provisional-turn",sessionId:null,actor:"interactive",model:null,profile:null,payload:{source:"web_fetch",tool:"WebFetch",detail:null}}),"retired");
  expect(replay.query("SELECT failed FROM safety_meta").get(),"SAFETY_RETIRED_CALLBACK_CANNOT_DISABLE_ANOTHER_CHAT").toEqual({failed:0});
  await replayWrites.safetyBegin({turnId:"another-chat",bindingId:crypto.randomUUID(),principalId:principal.id,sessionId:null,backendId:"claude",at:1});
 }finally{await replayWriter.close();replay.close();}
 }finally{await f.close();}});

test("explicit recording recovery keeps old gaps restricted and re-arms capacity for future collection",async()=>{
 const f=fixture();try{await fresh(f);
 const {recoverSafetyRecording}=await import("../src/governance/safety-store");
 expect(()=>recoverSafetyRecording(f.db)).toThrow("Stop all safety producers");
 await f.writes.safetyFail("voyage");await f.writes.safetyEnd("voyage");
 recoverSafetyRecording(f.db);
 expect(f.writes.safety(null,"ithaca").restriction,"SAFETY_RECOVERY_NEVER_CLEARS_HISTORY").toBe("restricted");
 expect(f.db.query("SELECT length(padding) n FROM safety_emergency_reserve").get()).toEqual({n:65536});
 await createGovernanceWrites(f.db,f.writer).safetyBegin({turnId:"after-recovery",bindingId:crypto.randomUUID(),principalId:"odysseus",sessionId:null,backendId:"claude",at:1});
 }finally{await f.close();}});

test("unbound ceilings refuse overflow without removing unresolved evidence",async()=>{
 const f=fixture();try{
 await f.writes.safetyBegin({turnId:"unbound-first",bindingId:crypto.randomUUID(),principalId:"odysseus",sessionId:null,backendId:"claude",at:0});
 await f.writes.firstTaint({kind:"taint",turnId:"unbound-first",sessionId:null,actor:"interactive",model:null,profile:null,payload:{source:"web_fetch",tool:"WebFetch",detail:null}});
 f.db.exec(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<1023)
 INSERT INTO safety_collections(id,turn_id,backend_id,started_at,ended,gap,start_revision)
 SELECT 'retained_'||x,'unbound_'||x,'unknown',0,1,'missing_historical_signals','0' FROM n`);
 await expectRejection(f.writes.safetyBegin({turnId:"overflow",bindingId:crypto.randomUUID(),principalId:"odysseus",sessionId:null,backendId:"claude",at:1}),"coverage capacity");
 expect(f.writes.safety("unbound-first",null).unresolvedCount).toBe(1);
 expect(f.writes.safety("unbound-first",null).restriction).toBe("restricted");
 }finally{await f.close();}});

test("external result segments and multi-URL input keep distinct admission facts",async()=>{
 const f=fixture();try{const {collector}=await fresh(f);
 await collector.begin("pages","fetch_content",{urls:["https://ithaca.invalid/a","https://troy.invalid/b"]});
 await collector.result("pages","fetch_content","A\nB",true,["A","B"]);
 await collector.begin("compute","brain_compute_collect",{job:"voyage"});
 await collector.result("compute","brain_compute_collect","A\nB",true,["A","B"]);
 const records=triggers(f);
 expect(records.length,"SAFETY_EVERY_EXTERNAL_SEGMENT_RECORDED").toBe(6);
 expect(records.every(r=>(r.payload as {occurrence:{admission:{trusted:boolean}}}).occurrence.admission.trusted===false)).toBe(true);
 expect(f.writes.safety(null,"ithaca").unresolvedCount).toBe(6);
 }finally{await f.close();}});

test("an edited admission and a newly added explicit mark cannot borrow a prior clean input",async()=>{
 const f=fixture();try{const {collector}=await fresh(f);
 await collector.begin("read","Read",{file_path:"notes/voyage.md"});
 await collector.begin("read","Read",{file_path:"workspaces/voyage/map.md"});
 const {untrustedMarkOperations}=await import("../src/files/untrusted-marks");untrustedMarkOperations(f.db).mark("workspaces/voyage/map.md",null,0);
 await collector.begin("read","Read",{file_path:"workspaces/voyage/map.md"});
 await collector.result("read","Read","Ithaca",true);
 expect(triggers(f).map(r=>(r.payload as {source:string}).source)).toEqual(["workspace_read","user_marked"]);
 await expectRejection(collector.begin("read","Read",{file_path:"workspaces/voyage/map.md"}),"already completed");
 }finally{await f.close();}});

test("parallel hook deliveries share the same host occurrence and wait for one result commit",async()=>{
 const f=fixture();try{const {collector}=await fresh(f);
 await Promise.all(Array.from({length:8},()=>collector.begin("parallel","Read",{file_path:"workspaces/voyage/map.md"})));
 expect(triggers(f),"SAFETY_PARALLEL_IDENTICAL_ADMISSION_DEDUPLICATES").toHaveLength(1);
 await Promise.all(Array.from({length:8},()=>collector.result("parallel","Read","Ithaca",true)));
 expect(safetyRecords(f.db,"ithaca").filter(r=>r.kind==="exposure")).toHaveLength(1);
 }finally{await f.close();}});

test("a typed first-turn owner can retire before session_info and cannot create a session afterwards",async()=>{
 const f=fixture();try{
 const {createPrincipal}=await import("../src/db/principals"),{retireChat}=await import("../src/ws/chat-lifecycle");
 const {createSessionCatalog}=await import("../src/ws/session-catalog");
 const principal=createPrincipal(f.db,{authMethod:"password",label:"Odysseus",ttlSeconds:60}),bindingId=crypto.randomUUID();
 await f.writes.safetyBegin({turnId:"typed-before-name",bindingId,principalId:principal.id,sessionId:null,backendId:"claude",at:0});
 const retired=retireChat(f.db,{operationId:"retire-before-name",principalId:principal.id,target:{ownerId:bindingId},expected:{backendId:null,generation:1},removableBackends:[],at:Date.now()});
 expect(retired.status,"SAFETY_TYPED_PROVISIONAL_HAS_REAL_OWNER").toBe("retired");
 const catalog=createSessionCatalog(()=>f.db);catalog.persistSessionStub("late-session","Voyage",null,"claude",principal.id,"typed-before-name");
 expect(f.db.query("SELECT 1 FROM sessions WHERE id='late-session'").get(),"SAFETY_RETIRED_PROVISIONAL_CANNOT_CREATE_SESSION").toBeNull();
 await expectRejection(f.writes.bind("typed-before-name","late-session"),"retired");
 }finally{await f.close();}});

test("reserved terminal evidence commits at a full brain ledger while new ingestion is refused",async()=>{
 const f=fixture();try{const {collector}=await fresh(f);
 await collector.begin("retained","WebFetch",{url:"https://ithaca.invalid"});
 f.db.exec("UPDATE safety_meta SET used_rows=1000000-scope_rows");
 await expectRejection(f.writes.safetyBegin({turnId:"overflow-scope",bindingId:crypto.randomUUID(),sessionId:null,principalId:"odysseus",backendId:"claude",at:1}),"capacity");
 await collector.result("retained","WebFetch","Ithaca",true);
 expect(safetyRecords(f.db,"ithaca").filter(r=>r.kind==="exposure"),"SAFETY_TERMINAL_USES_PRE_RESERVED_CAPACITY").toMatchObject([{state:"finalized"}]);
 expect(f.writes.safety(null,"ithaca").restriction).toBe("restricted");
 }finally{await f.close();}});

test("byte exhaustion and revision exhaustion persist failure without accepting an exposure",async()=>{
 for(const exhausted of ["bytes","revision"]){const f=fixture();try{const {collector}=await fresh(f);
 if(exhausted==="bytes")f.db.exec("UPDATE safety_meta SET used_bytes=536870912-scope_bytes");
 else f.db.exec("UPDATE safety_meta SET revision='18446744073709551615'");
 await expectRejection(collector.begin("refused","WebFetch",{url:"https://ithaca.invalid"}),exhausted==="bytes"?"capacity":"revision exhausted");
 expect(triggers(f),"SAFETY_OVERFLOW_REFUSES_BEFORE_DELIVERY").toHaveLength(0);
 expect(f.writes.safety(null,"ithaca").restriction).toBe("restricted");
 if(exhausted==="revision")expect(f.writes.safety(null,"ithaca").evidenceRevision).toBe("18446744073709551615");
 }finally{await f.close();}}
});

test("imported and legacy provisional histories remain unknown after new detector acknowledgements",async()=>{
 const f=fixture();try{
 f.db.exec("INSERT INTO sessions(id,created_at,last_active_at,backend_id) VALUES('imported',0,0,'pi')");
 await f.writes.safetyBegin({turnId:"import-resume",bindingId:crypto.randomUUID(),sessionId:"imported",principalId:null,backendId:"pi",at:0});
 await f.writes.safetyReady("import-resume","pi",1);
 expect(f.writes.safety(null,"imported").coverage.state,"SAFETY_IMPORT_ACK_CANNOT_RECONSTRUCT_HISTORY").toBe("incomplete");
 expect(f.writes.safety(null,"imported").restriction).toBe("restricted");
 }finally{await f.close();}});

test("detector overflow stops collection rather than silently truncating later paths",async()=>{
 const f=fixture();try{const {collector}=await fresh(f);
 await collector.begin("many","Grep",{path:"notes"});
 const output=Array.from({length:257},(_,i)=>`workspaces/voyage/map-${i}.md`).join("\n");
 await expectRejection(collector.result("many","Grep",output,true),"signal capacity");
 expect(f.writes.safety(null,"ithaca").reasons,"SAFETY_DETECTOR_OVERFLOW_LATCHED").toContain("recording_failed");
 }finally{await f.close();}});

test("Claude delivery hooks await real SQLite commits before tool contact and result delivery, and refuse recorder loss",async()=>{
 const f=fixture();const origin=Bun.serve({hostname:"127.0.0.1",port:0,fetch:()=>new Response("Ithaca")});
 try{const {collector}=await fresh(f);
 const {createPermissionWiring}=await import("../../ui-backend-claude/src/permission-hooks");
 const probe=await import("./fixtures/write-worker-probe");
 const wiring=createPermissionWiring({req:{prompt:"Return to Ithaca.",signal:new AbortController().signal,bridge:{emit(){},requestPermission:async()=>({behavior:"allow"}),inputSafety:collector}},allowedTools:["WebFetch"],confirmPatterns:[],brainPath:f.root,turnLock:{acquireForTool:async()=>({ok:true}),releaseForTool(){}} as never,childEnv:{},log(){}});
 const hold=f.writer.channel(probe,{table:"odysseus_log"});await hold.ready;
 const slow=hold.call("slow","Ithaca",200);let contacted=false;
 const pre=wiring.hooks!.PreToolUse!.find(group=>!group.matcher)!.hooks[0]!;
 const admitting=pre({hook_event_name:"PreToolUse",tool_use_id:"actual-hook",tool_name:"WebFetch",tool_input:{url:origin.url.href}} as never,undefined,{signal:new AbortController().signal}).then(()=>{contacted=true;return fetch(origin.url);});
 await Bun.sleep(20);
 expect(contacted,"SAFETY_BACKEND_CONTACT_WAITS_FOR_DURABLE_ADMISSION").toBe(false);
 expect(f.writes.safety(null,"ithaca").pendingCount).toBe(1);
 const response=await admitting;await slow;
 const post=wiring.hooks!.PostToolUse!.find(group=>!group.matcher)!.hooks[0]!;
 await post({hook_event_name:"PostToolUse",tool_use_id:"actual-hook",tool_name:"WebFetch",tool_response:await response.text()} as never,undefined,{signal:new AbortController().signal});
 expect(safetyRecords(f.db,"ithaca").filter(r=>r.kind==="exposure"),"SAFETY_RESULT_HOOK_DURABLE_BEFORE_DELIVERY").toMatchObject([{state:"finalized"}]);
 f.db.exec("UPDATE safety_meta SET used_bytes=536870912-scope_bytes");
 const refused=await pre({hook_event_name:"PreToolUse",tool_use_id:"failed-hook",tool_name:"WebFetch",tool_input:{url:origin.url.href}} as never,undefined,{signal:new AbortController().signal});
 expect(refused,"SAFETY_BACKEND_REFUSES_UNRECORDED_INPUT").toMatchObject({hookSpecificOutput:{permissionDecision:"deny"}});
 }finally{origin.stop(true);await f.close();}});

test("independent SQLite connections share the durable pending ceiling and failure fence",async()=>{
 const f=fixture();const {Database}=await import("bun:sqlite");let peer:InstanceType<typeof Database>|undefined,peerWriter:ReturnType<typeof openSqliteWriter>|undefined;
 try{const {bindingId}=await fresh(f);
 f.db.query(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<255)
 INSERT INTO safety_pending SELECT 'prior_'||x,?,100,4,7000 FROM n`).run(bindingId);
 peer=new Database(f.path);peer.exec("PRAGMA busy_timeout=5000; PRAGMA foreign_keys=ON");peerWriter=openSqliteWriter(peer);
 const one=f.writer.channel(procedures,undefined),two=peerWriter.channel(procedures,undefined);
 const row=governanceEventRow({kind:"taint",turnId:"voyage",sessionId:"ithaca",actor:"interactive",model:null,profile:null,payload:{source:"web_fetch",tool:"WebFetch",detail:null}});
 const results=await Promise.allSettled([one.call("safetyReserve",row,"race-a",100),two.call("safetyReserve",row,"race-b",100)]);
 expect(results.map(r=>r.status).sort(),"SAFETY_CROSS_CONNECTION_CAPACITY_SERIALIZES").toEqual(["fulfilled","rejected"]);
 expect(f.db.query("SELECT COUNT(*) n FROM safety_pending").get()).toEqual({n:256});
 expect(createGovernanceWrites(peer,peerWriter).safety(null,"ithaca").restriction).toBe("restricted");
 await expectRejection(createGovernanceWrites(peer,peerWriter).safetyBegin({turnId:"other",bindingId:crypto.randomUUID(),sessionId:null,principalId:"odysseus",backendId:"claude",at:1}),"recovery");
 }finally{await peerWriter?.close();peer?.close();await f.close();}});

test("128 retained epochs fence a 129th resume without dropping earlier facts",async()=>{
 const f=fixture();try{const {bindingId}=await fresh(f);await f.writes.safetyEnd("voyage");
 f.db.query(`WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n WHERE x<127)
 INSERT INTO safety_collections(id,turn_id,session_id,history_owner_id,generation,backend_id,started_at,ended,acknowledged,start_revision,end_revision)
 SELECT 'epoch_'||x,'turn_'||x,session_id,history_owner_id,generation,'claude',0,1,acknowledged,'0','0' FROM n,safety_collections WHERE id=?`).run(bindingId);
 await expectRejection(f.writes.safetyBegin({turnId:"too-many",bindingId:crypto.randomUUID(),sessionId:"ithaca",principalId:"odysseus",backendId:"pi",at:1}),"coverage capacity");
 expect(f.writes.safety(null,"ithaca").coverage.epochs).toHaveLength(128);
 expect(f.writes.safety(null,"ithaca").restriction).toBe("restricted");
 }finally{await f.close();}});

test("a clean search input cannot suppress mixed JSON paths, an explicit mark or a truncated remainder",async()=>{
 const f=fixture();try{const {collector}=await fresh(f);
 const {untrustedMarkOperations}=await import("../src/files/untrusted-marks");untrustedMarkOperations(f.db).mark("notes/voyage.md",null,0);
 await collector.begin("mixed","Grep",{path:"notes"});
 await collector.result("mixed","Grep",JSON.stringify({filenames:["workspaces/voyage/map.md","notes/voyage.md"],truncated:true}),true);
 expect(triggers(f).map(r=>(r.payload as {source:string}).source),"SAFETY_CLEAN_INPUT_CANNOT_HIDE_UNTRUSTED_JSON_OUTPUT").toEqual(["workspace_read","user_marked","legacy_unknown"]);
 }finally{await f.close();}});

test("an unsupported recorder stops and persists a gap when input detection exceeds its bound",async()=>{
 const f=fixture();try{await fresh(f);
 const {createTurnRecorder}=await import("../src/activity/recorder"),{createActivityStore}=await import("../src/activity/store");let stopped:Error|undefined;
 const recorder=createTurnRecorder({store:createActivityStore(f.db,{writer:"test"}),governanceDb:f.db,governanceWrites:f.writes,governance:event=>f.writes.record(event),abort:error=>{stopped=error;}},{turnId:"voyage",sessionId:"ithaca",profile:"governed"});
 recorder.observeFrame({type:"tool_use_complete",sessionId:"ithaca",toolUseId:"too-long",toolName:"Read",input:{file_path:`workspaces/${"x".repeat(1024)}.md`}});
 expect(stopped?.message,"SAFETY_FALLBACK_DETECTOR_OVERFLOW_STOPS_TURN").toContain("detection failed");
 await recorder.settled();expect(f.writes.safety(null,"ithaca").reasons).toContain("recording_failed");
 }finally{await f.close();}});
