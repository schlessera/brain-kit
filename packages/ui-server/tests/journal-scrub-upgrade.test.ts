import {expect,test} from "bun:test";
import {createHash} from "node:crypto";
import {mkdtempSync,rmSync,statSync,writeFileSync,existsSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {createUiDb} from "../src/db/client.js";
import {journalDatabasePath} from "../src/db/journal-database.js";
import {createJournalAccounting} from "../src/brain/journal-accounting.js";
import * as journalStore from "../src/brain/journal-store.js";
import {SELF} from "../src/brain/writer-gate.js";

test("upgrading a near-cap journal preserves writes and defers scrub schema until room is released",()=>{
 const root=mkdtempSync(join(tmpdir(),"odysseus-scrub-upgrade-")),path=join(root,"ui.db"),objects=join(root,"objects");
 let db=createUiDb(path),store:ReturnType<typeof journalStore.setup>|undefined;
 try {
  // Model the pre-PR store without quarantine DDL or its migration receipt.
  // Vacuum removes the dropped schema's free pages so an upgrade must pay
  // for new pages rather than reusing a fixture artefact.
  db.exec("DROP TABLE IF EXISTS journal.turn_journal_scrub_quarantine");
  db.query("DELETE FROM journal.turn_journal_migrations WHERE filename='095_journal_scrub.journal.sql'").run();
  const id="aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",reserved=128*1024;
  db.query("INSERT INTO turn_journal_reservations(id,bytes,pid,pid_start,created_at,hash,kind) VALUES (?,?,?,?,0,NULL,'temporary')").run(id,reserved,SELF.pid,SELF.start);
  db.exec("VACUUM journal");db.exec("PRAGMA journal.wal_checkpoint(TRUNCATE)");
  const pageSize=(db.query("PRAGMA journal.page_size").get() as {page_size:number}).page_size,pages=statSync(journalDatabasePath(path)).size/pageSize;
  // Freeze the pre-upgrade accounting rule independently of the implementation.
  const standingWal=32+(pages+Math.ceil(pages/(pageSize/4-2)))*(pageSize+24),before=pages*pageSize+standingWal+reserved,cap=before+4096;
  db.close();db=createUiDb(path);
  const accounting=createJournalAccounting(db,path,{capBytes:cap});
  expect(()=>accounting.write(()=>db.query("UPDATE turn_journal_allocation SET index_purge=1 WHERE id=1").run()),"NEAR_CAP_UPGRADE_WRITES_REMAIN_USABLE").not.toThrow();
  expect(accounting.usage()).toBeLessThanOrEqual(cap);
  store=journalStore.setup(db,{dbPath:path,objectsRoot:objects,capBytes:cap});
  expect(store.scrubObjects!(),"NEAR_CAP_SCRUB_SCHEMA_HAS_NAMED_SKIP").toMatchObject({state:"skipped",reason:"quarantine_pending",schemaSkipReason:"quarantine_schema_not_admitted",listed:0});
  expect(db.query("SELECT 1 FROM journal.sqlite_schema WHERE name='turn_journal_scrub_quarantine'").get()).toBeNull();
  expect(existsSync(join(objects,"quarantine")),"SCHEMA_SKIP_PRECEDES_DIRECTORY_WORK").toBe(false);
  expect(()=>accounting.write(()=>{}),"SCHEMA_REFUSAL_LEAVES_WRITES_USABLE").not.toThrow();
  // The live owner releases its temporary capacity. Idle maintenance retries
  // the same optional schema without a restart and can quarantine an orphan.
  accounting.write(()=>db.query("DELETE FROM turn_journal_reservations WHERE id=?").run(id));
  const text="Ithaca",hash=createHash("sha256").update(text).digest("hex");writeFileSync(join(objects,hash),text);
  expect(store.scrubObjects!(),"SCRUB_SCHEMA_RETRIES_AFTER_CAPACITY_IS_FREED").toMatchObject({quarantined:1,quarantinedBytes:6});
  expect(accounting.usage()).toBeLessThanOrEqual(cap);
  expect(()=>db.query("INSERT INTO turn_journal_scrub_quarantine VALUES (?,0,'reserved')").run("b".repeat(64)),"NEW_SCHEMA_KEEPS_ACCOUNTING_ESCAPE_GUARD").toThrow("outside capacity accounting");
 }finally{store?.close?.();db.close();rmSync(root,{recursive:true,force:true});}
});
