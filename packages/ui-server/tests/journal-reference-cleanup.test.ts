import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { FINISH_REFERENCE_CLEANUP } from "../src/brain/journal-reference-cleanup.js";

const previous = `DELETE FROM turn_journal_object_refs WHERE turn_id=?1 AND NOT EXISTS (SELECT 1 FROM turn_journal_changes c WHERE c.turn_id=?1 AND (json_extract(c.before_json,'$.hash')=turn_journal_object_refs.hash OR json_extract(c.after_json,'$.hash')=turn_journal_object_refs.hash)) AND NOT EXISTS (SELECT 1 FROM turn_journal_claude_memory m WHERE m.turn_id=?1 AND m.state!='saved' AND (json_extract(m.before_json,'$.hash')=turn_journal_object_refs.hash OR json_extract(m.after_json,'$.hash')=turn_journal_object_refs.hash))`;
function fixture() {
  const db = new Database(":memory:");
  db.exec(`CREATE TABLE turn_journal_object_refs(turn_id TEXT,hash TEXT); CREATE TABLE turn_journal_changes(turn_id TEXT,before_json TEXT,after_json TEXT); CREATE TABLE turn_journal_claude_memory(turn_id TEXT,before_json TEXT,after_json TEXT,state TEXT)`);
  return db;
}
function survivors(sql: string) {
  const db = fixture();
  try {
    for (const hash of ["before", "after", "unsaved", "saved", "unused"]) db.query("INSERT INTO turn_journal_object_refs VALUES ('turn',?)").run(hash);
    db.exec(`INSERT INTO turn_journal_object_refs VALUES ('other','unused'); INSERT INTO turn_journal_changes VALUES ('turn','{"hash":"before"}','{"hash":"after"}'), ('turn',NULL,'{}'); INSERT INTO turn_journal_claude_memory VALUES ('turn',NULL,'{"hash":"unsaved"}','unconfirmed'), ('turn','{"hash":"saved"}',NULL,'saved')`);
    db.query(sql).run("turn");
    return db.query("SELECT * FROM turn_journal_object_refs ORDER BY turn_id,hash").all();
  } finally { db.close(); }
}
test("finish retains exactly before, after, unsaved memory and other turns; missing hashes do not poison deletion", () => {
  expect(survivors(FINISH_REFERENCE_CLEANUP), "FINISH_REFERENCE_EQUIVALENCE").toEqual(survivors(previous));
  expect(survivors(FINISH_REFERENCE_CLEANUP)).toEqual([{turn_id:"other",hash:"unused"}, {turn_id:"turn",hash:"after"}, {turn_id:"turn",hash:"before"}, {turn_id:"turn",hash:"unsaved"}]);
});
test("5000 changes and references clean up at least ten times faster than the correlated predicate", () => {
  const db = fixture();
  try {
    db.transaction(() => {
      for (let n=0;n<5000;n++) db.query("INSERT INTO turn_journal_changes VALUES ('turn',?,NULL)").run(JSON.stringify({hash:`hash-${n}`}));
    })();
    const measure = (sql: string) => {
      db.exec("DELETE FROM turn_journal_object_refs");
      db.transaction(() => { for (let n=0;n<5000;n++) db.query("INSERT INTO turn_journal_object_refs VALUES ('turn',?)").run(`hash-${n}`); })();
      const start = performance.now(); db.query(sql).run("turn"); return performance.now()-start;
    };
    // Warm the JSON/parser paths before the measured pair.
    measure(FINISH_REFERENCE_CLEANUP);
    const oldMs=measure(previous), newMs=measure(FINISH_REFERENCE_CLEANUP);
    console.log(JSON.stringify({oldMs,newMs,ratio:oldMs/newMs}));
    expect(oldMs/newMs,"FINISH_REFERENCE_RATIO").toBeGreaterThan(10);
  } finally { db.close(); }
});

test("a refusal in finish reference cleanup rolls back its terminal record and manifest deletion together",async()=>{
  const {mkdtempSync,rmSync}=await import("node:fs");
  const {tmpdir}=await import("node:os");
  const {join}=await import("node:path");
  const {createUiDb}=await import("../src/db/client.js");
  const {setup}=await import("../src/brain/journal-store.js");
  const root=mkdtempSync(join(tmpdir(),"odysseus-finish-atomic-")),db=createUiDb(":memory:");
  const store=setup(db,{dbPath:":memory:",objectsRoot:join(root,"objects")}) as unknown as {statements(list:import("../src/brain/journal-store.js").JournalStatement[]):number[];close():void};
  try {
    store.statements([{sql:"INSERT INTO turn_journal_turns (turn_id,actor,profile,started_at,state) VALUES ('turn','interactive','governed',1,'recording')"},
      {sql:"INSERT INTO turn_journal_manifests VALUES ('turn','[]')"},
      {sql:"INSERT INTO turn_journal_objects VALUES (?,0,'present')",params:["a".repeat(64)]},
      {sql:"INSERT INTO turn_journal_object_refs VALUES ('turn',?)",params:["a".repeat(64)]}]);
    const finish=[{sql:"UPDATE turn_journal_turns SET ended_at=2,state='complete' WHERE turn_id='turn'"},
      {sql:"DELETE FROM turn_journal_manifests WHERE turn_id='turn'"}, {sql:FINISH_REFERENCE_CLEANUP,params:["turn"]}];
    db.exec("CREATE TEMP TRIGGER abort_finish_cleanup BEFORE DELETE ON journal.turn_journal_object_refs BEGIN SELECT RAISE(ABORT,'finish interrupted'); END");
    expect(()=>store.statements(finish),"FINISH_CLEANUP_FAULT_IN_TRANSACTION").toThrow("finish interrupted");
    expect(db.query("SELECT ended_at,state FROM turn_journal_turns WHERE turn_id='turn'").get(),"FINISH_RECORD_ROLLS_BACK_WITH_REFS").toEqual({ended_at:null,state:"recording"});
    expect(db.query("SELECT count(*) AS n FROM turn_journal_manifests").get()).toEqual({n:1});
    expect(db.query("SELECT count(*) AS n FROM turn_journal_object_refs").get()).toEqual({n:1});
    db.exec("DROP TRIGGER abort_finish_cleanup");store.statements(finish);
    expect(db.query("SELECT ended_at,state FROM turn_journal_turns WHERE turn_id='turn'").get()).toEqual({ended_at:2,state:"complete"});
    expect(db.query("SELECT count(*) AS n FROM turn_journal_object_refs").get()).toEqual({n:0});
  } finally {store.close();db.close();rmSync(root,{recursive:true,force:true});}
});
