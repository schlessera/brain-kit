import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUiDb } from "../src/db/client.js";
import * as journalStore from "../src/brain/journal-store.js";
import { createJournalAccounting } from "../src/brain/journal-accounting.js";
import { createJournalObjects } from "../src/brain/journal-objects.js";
import { SELF } from "../src/brain/writer-gate.js";

const sha=(s:string)=>createHash("sha256").update(s).digest("hex");
function fixture() {
 const root=mkdtempSync(join(tmpdir(),"odysseus-scrub-")),path=join(root,"ui.db"),objects=join(root,"objects"),db=createUiDb(path);
 const store=journalStore.setup(db,{dbPath:path,objectsRoot:objects}) as unknown as {statements(list:journalStore.JournalStatement[]):number[];reserve(bytes:number,hash:string):string;scrubObjects():import("../src/brain/journal-scrub.js").JournalScrubResult;usage():number;close():void};
 return {root,path,objects,db,store,close(){store.close!();db.close();rmSync(root,{recursive:true,force:true});}};
}
test("scrub quarantines only verified unaccounted files, retaining rows, references and live reservations",()=>{
 const f=fixture();
 try {
   for(const text of ["orphan","present","pending","reserved"])writeFileSync(join(f.objects,sha(text)),text);
   f.store.statements!([{sql:"INSERT INTO turn_journal_objects VALUES (?,7,'present'),(?,7,'pending')",params:[sha("present"),sha("pending")]}]);
   f.store.reserve!(8,sha("reserved"));
   writeFileSync(join(f.objects,sha("bad")),"corrupt");
   const result=f.store.scrubObjects!();
   expect(result,"SCRUB_ORPHAN_QUARANTINE").toMatchObject({unaccounted:2,unaccountedBytes:13,quarantined:1,quarantinedBytes:6,corrupt:1,corruptBytes:7});
   expect(existsSync(join(f.objects,sha("orphan")))).toBe(false);
   expect(existsSync(join(join(f.objects,"quarantine"),sha("orphan")))).toBe(true);
   for(const text of ["present","pending","reserved"])expect(existsSync(join(f.objects,sha(text)))).toBe(true);
   expect(existsSync(join(f.objects,sha("bad"))),"SCRUB_NEVER_REMOVES_CORRUPT").toBe(true);
   expect(f.db.query("SELECT sum(bytes) AS bytes FROM turn_journal_scrub_quarantine").get()).toEqual({bytes:6});
   expect(createJournalAccounting(f.db,f.path).usage()).toBeGreaterThan(6);
 } finally{f.close();}
});
test("scrub durably skips while a turn holds the journal and resumes after it ends",()=>{
 const f=fixture();try{
  writeFileSync(join(f.objects,sha("orphan")),"orphan");
  f.store.statements!([{sql:"INSERT INTO turn_journal_turns (turn_id,actor,profile,started_at,state) VALUES ('voyage','interactive','governed',1,'recording')"}]);
  expect(f.store.scrubObjects!(),"SCRUB_BUSY_SKIP").toMatchObject({state:"skipped",reason:"journal_busy",listed:0});
  expect(existsSync(join(f.objects,sha("orphan")))).toBe(true);
  f.store.statements!([{sql:"UPDATE turn_journal_turns SET ended_at=2"}]);
  expect(f.store.scrubObjects!()).toMatchObject({state:"complete",quarantined:1});
 }finally{f.close();}
});
test("a file published before a failed row commit is protected by its reservation, then recovered",async()=>{
 const f=fixture();try{
  const accounting=createJournalAccounting(f.db,f.path);
  const objects=createJournalObjects(f.objects,{async reserve(bytes,hash){const held=await accounting.reserve(bytes,hash);return {id:held.id,finish(){throw Error("interrupted after file before row");},cancel:()=>held.cancel()};}});
  try{await expect(objects.putBytes(Buffer.from("interrupted"))).rejects.toThrow("interrupted after file before row");}
  finally{objects.close();}
  expect(f.store.scrubObjects!()).toMatchObject({unaccounted:0,quarantined:0});
  // A real restart sees a positively dead producer; the existing recovery
  // converts its already-published verified object to accounted present state.
  f.store.statements!([{sql:"UPDATE turn_journal_reservations SET pid=?,pid_start='0'",params:[SELF.pid]}]);
  const recovered=createJournalObjects(f.objects,accounting);
  try{accounting.recover(recovered);}finally{recovered.close();}
  expect(f.store.scrubObjects!()).toMatchObject({unaccounted:0,quarantined:0});
  expect(f.db.query("SELECT state FROM turn_journal_objects WHERE hash=?").get(sha("interrupted"))).toEqual({state:"present"});
 }finally{f.close();}
});
test("scrub lists at most 64 entries and resumes the next batch",()=>{
 const f=fixture();try{
  for(let n=0;n<140;n++)writeFileSync(join(f.objects,sha(`Ithaca ${n}`)),`Ithaca ${n}`);
  let total=0;
  for(let n=0;n<4;n++){const result=f.store.scrubObjects!() as {listed:number;quarantined:number};expect(result.listed).toBeLessThanOrEqual(64);total+=result.quarantined;}
  expect(total,"SCRUB_RESUMES_TO_COMPLETION").toBe(140);
 }finally{f.close();}
});

test("quarantined payload bytes remain charged to the aggregate quota",()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-quarantine-charge-")),db=createUiDb(":memory:"),objects=join(root,"objects");
 const store=journalStore.setup(db,{dbPath:":memory:",objectsRoot:objects});
 try {
  writeFileSync(join(objects,sha("orphan")),"orphan");
  expect(store.usage!()).toBe(0);
  store.scrubObjects!();
  expect(store.usage!(),"SCRUB_QUARANTINE_BYTES_STAY_CHARGED").toBe(6);
 }finally{store.close!();db.close();rmSync(root,{recursive:true,force:true});}
});

for (const recreated of [false,true]) test(`an interrupted quarantine commit keeps its charge and resumes the already moved file, recreated=${recreated}`,()=>{
 const f=fixture();try{
  writeFileSync(join(f.objects,sha("orphan")),"orphan");
  f.db.exec("CREATE TEMP TRIGGER interrupt_quarantine BEFORE UPDATE ON journal.turn_journal_scrub_quarantine BEGIN SELECT RAISE(ABORT,'interrupted quarantine commit'); END");
  expect(()=>f.store.scrubObjects(),"SCRUB_INTERRUPTED_AFTER_MOVE").toThrow("interrupted quarantine commit");
  expect(f.db.query("SELECT bytes,state FROM turn_journal_scrub_quarantine").get(),"SCRUB_INTERRUPTED_CHARGE_SURVIVES").toEqual({bytes:6,state:"reserved"});
  expect(existsSync(join(join(f.objects,"quarantine"),sha("orphan")))).toBe(true);
  if(recreated) {
    writeFileSync(join(f.objects,sha("orphan")),"orphan");
    f.store.statements([{sql:"INSERT INTO turn_journal_objects VALUES (?,6,'present')",params:[sha("orphan")]}]);
  }
  f.db.exec("DROP TRIGGER interrupt_quarantine");
  expect(f.store.scrubObjects(),"SCRUB_INTERRUPTED_MOVE_RESUMES").toMatchObject({quarantined:1,quarantinedBytes:6});
  expect(f.db.query("SELECT bytes,state FROM turn_journal_scrub_quarantine").get(),"SCRUB_RECREATED_HASH_KEEPS_QUARANTINE_CHARGE").toEqual({bytes:6,state:"quarantined"});
  if(recreated)expect(existsSync(join(f.objects,sha("orphan")))).toBe(true);
 }finally{f.close();}
});

test("a missing interrupted candidate remains charged and reports an unresolved quarantine",()=>{
 const f=fixture();try{
  f.store.statements([{sql:"INSERT INTO turn_journal_scrub_quarantine VALUES (?,6,'reserved')",params:[sha("orphan")]}]);
  expect(f.store.scrubObjects(),"SCRUB_UNKNOWN_STAYS_PENDING").toMatchObject({state:"partial",reason:"quarantine_pending",pending:1,pendingBytes:6});
  expect(f.db.query("SELECT bytes FROM turn_journal_scrub_quarantine").get()).toEqual({bytes:6});
 }finally{f.close();}
});

test("pending reservations do not starve new orphans and a full batch stays partial",()=>{
 const f=fixture();try{
 for(let n=0;n<64;n++)f.store.statements([{sql:"INSERT INTO turn_journal_scrub_quarantine VALUES (?,6,'reserved')",params:[sha(`missing ${n}`)]}]);
 writeFileSync(join(f.objects,sha("orphan")),"orphan");
 expect(f.store.scrubObjects(),"SCRUB_PENDING_CANNOT_STARVE_LISTING").toMatchObject({quarantined:1,pending:64,state:"partial"});
 }finally{f.close();}
 const g=fixture();try{
 for(let n=0;n<65;n++)writeFileSync(join(g.objects,sha(`Ithaca ${n}`)),`Ithaca ${n}`);
 expect(g.store.scrubObjects(),"SCRUB_FULL_BATCH_IS_NOT_COMPLETE").toMatchObject({state:"partial"});
 }finally{g.close();}
});
test("a recreated unaccounted source is quarantined and charged separately",()=>{
 const f=fixture();try{
 for(let n=0;n<3;n++){
 writeFileSync(join(f.objects,sha("orphan")),"orphan");
 expect(f.store.scrubObjects(),"SCRUB_RECREATED_ORPHAN_MOVES").toMatchObject({quarantined:1,unaccounted:1});
 expect(f.db.query("SELECT sum(bytes) AS bytes FROM turn_journal_scrub_quarantine").get(),"SCRUB_EVERY_COPY_CHARGED").toEqual({bytes:6*(n+1)});
 expect(existsSync(join(f.objects,sha("orphan")))).toBe(false);
 }
 }finally{f.close();}
});
