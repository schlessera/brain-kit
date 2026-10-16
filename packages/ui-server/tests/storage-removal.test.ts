import { expect, test } from "bun:test";
import { readFileSync, writeFileSync, existsSync, linkSync, symlinkSync, chmodSync } from "node:fs";
import { join } from "node:path";
import { createTurnJournal } from "../src/brain/turn-journal.js";
import { createWriterGate } from "../src/brain/writer-gate.js";
import { createUiDb } from "../src/db/client.js";
import { createStorageRemoval } from "../src/storage/removal.js";
import { storageRemovalFixture } from "./helpers/storage-removal-fixture.js";

test("exact removal retains original bytes, keeps references and history facts separate, and Undo survives readback", async () => {
  const f = storageRemovalFixture(), id = "odysseus-removal-0001";
  try {
    const review = await f.removal.review("odysseus", id, ["attachments/chart.pdf"]);
    expect(review.review.files[0], "STORAGE_REMOVAL_REVIEW_COVERAGE").toMatchObject({ eligible: true, recovery: "requires-retention", references: [{source:"voyage.md",certainty:"resolved"}] });
    expect(readFileSync(join(f.brain,"attachments/chart.pdf"))).toEqual(f.original);
    expect(f.removal.start("odysseus", id, review.review.fingerprint).state).toBe("waiting"); await f.removal.idle();
    const result = f.removal.receipt("odysseus", id);
    expect(result, "STORAGE_REMOVAL_DURABLE_RESULT").toMatchObject({state:"complete",items:[{state:"removed",undoAvailable:true}],commit:"not-requested",sync:"not-requested",index:"complete"});
    expect(existsSync(join(f.brain,"attachments/chart.pdf"))).toBe(false);
    expect(readFileSync(join(f.brain,"voyage.md"),"utf8")).toContain("attachments/chart.pdf");
    expect(result.after?.attribution).toBe("concurrent-writers-possible");
    expect(f.calls.filter(call=>call.purpose==="storage-removal-review").every(call=>call.publish===false && call.credentials===false)).toBe(true);
    const db = createUiDb(f.dbPath), journal = createTurnJournal(db, {brainPath:f.brain,dbPath:f.dbPath,objectsRoot:join(f.root,"objects"),nativeManager:f.native.manager}), reopened = createStorageRemoval(db, {...f.options,journal,gate:createWriterGate(db,f.brain,{pollMs:1})});
    try {
      expect(reopened.start("odysseus", id, review.review.fingerprint).state, "STORAGE_REMOVAL_NO_REPLAY").toBe("complete");
      const undo = await reopened.review("odysseus", "odysseus-undo-0001", ["attachments/chart.pdf"], id);
      expect(undo.review.files[0], "STORAGE_UNDO_CURRENT_REVIEW").toMatchObject({eligible:true,recovery:"retained"});
      reopened.start("odysseus",undo.review.id,undo.review.fingerprint); await reopened.idle();
      expect(reopened.receipt("odysseus",undo.review.id), "STORAGE_UNDO_RECEIPT").toMatchObject({state:"complete",items:[{state:"restored"}]});
      expect(readFileSync(join(f.brain,"attachments/chart.pdf")), "STORAGE_UNDO_INDEPENDENT_ORIGINAL_BYTES").toEqual(f.original);
    } finally { await reopened.close(); await journal.close(); db.close(); }
  } finally { await f.close(); }
});

test("changed bytes keep a mixed batch partial, changed consequences refuse, and stale Undo preserves replacements", async () => {
  const f = storageRemovalFixture();
  try {
    const review = await f.removal.review("odysseus", "odysseus-mixed-0001", ["attachments/chart.pdf","attachments/score.pdf"]);
    writeFileSync(join(f.brain,"attachments/score.pdf"),"Athena's revised score");
    f.removal.start("odysseus",review.review.id,review.review.fingerprint); await f.removal.idle();
    expect(f.removal.receipt("odysseus",review.review.id), "STORAGE_REMOVAL_EXACT_REVIEWED_VERSION").toMatchObject({state:"partial",items:[{state:"removed"},{state:"changed"}]});
    expect(readFileSync(join(f.brain,"attachments/score.pdf"),"utf8")).toBe("Athena's revised score");
    const undo = await f.removal.review("odysseus","odysseus-stale-undo",["attachments/chart.pdf"],review.review.id);
    writeFileSync(join(f.brain,"attachments/chart.pdf"),"Penelope's replacement");
    f.removal.start("odysseus",undo.review.id,undo.review.fingerprint); await f.removal.idle();
    expect(f.removal.receipt("odysseus",undo.review.id).items[0]?.state, "STORAGE_UNDO_NEVER_OVERWRITES").toBe("changed");
    expect(readFileSync(join(f.brain,"attachments/chart.pdf"),"utf8")).toBe("Penelope's replacement");
    const reference = await f.removal.review("odysseus","odysseus-ref-000001",["attachments/score.pdf"]);
    writeFileSync(join(f.brain,"new-voyage.md"),"[New score](attachments/score.pdf)\n");
    f.removal.start("odysseus",reference.review.id,reference.review.fingerprint); await f.removal.idle();
    expect(f.removal.receipt("odysseus",reference.review.id).items[0], "STORAGE_REMOVAL_CONSEQUENCES_RECHECKED").toMatchObject({state:"changed",reason:"consequences_changed"});
    expect(existsSync(join(f.brain,"attachments/score.pdf"))).toBe(true);
  } finally { await f.close(); }
});

test("ignored, protected, linked, executable and uncovered attachments never become eligible", async () => {
  const f = storageRemovalFixture();
  try {
    writeFileSync(join(f.brain,".gitignore"),"attachments/chart.pdf\n");
    linkSync(join(f.brain,"attachments/score.pdf"),join(f.brain,"attachments/alias.pdf"));
    symlinkSync("score.pdf",join(f.brain,"attachments/link.pdf"));
    writeFileSync(join(f.brain,"attachments/exec.pdf"),"executable"); chmodSync(join(f.brain,"attachments/exec.pdf"),0o700);
    f.options.protectedPaths.push("attachments/private.pdf"); writeFileSync(join(f.brain,"attachments/private.pdf"),"protected");
    const review = await f.removal.review("odysseus","odysseus-protected-1",["attachments/chart.pdf","attachments/score.pdf","attachments/link.pdf","attachments/exec.pdf","attachments/private.pdf"]);
    expect(review.review.files.every(file=>!file.eligible), "STORAGE_REMOVAL_PROTECTED_SELECTION").toBe(true);
    expect(()=>f.removal.start("odysseus",review.review.id,review.review.fingerprint)).toThrow("Refresh");
    expect(readFileSync(join(f.brain,"attachments/chart.pdf"))).toEqual(f.original);
  } finally { await f.close(); }
});

test("authority, item-intent storage and missing retained bytes each stop before unlink", async () => {
  const f = storageRemovalFixture();
  try {
    const review = await f.removal.review("odysseus","odysseus-revoked-01",["attachments/chart.pdf"]);
    const hold = await f.gate.acquire("shared","turn:athena",{turn:true});
    f.removal.start("odysseus",review.review.id,review.review.fingerprint); f.revoke(); hold.release(); await f.removal.idle(); f.allow();
    expect(readFileSync(join(f.brain,"attachments/chart.pdf")), "STORAGE_REMOVAL_CURRENT_AUTHORITY").toEqual(f.original);
    const blocked = await f.removal.review("odysseus","odysseus-intent-001",["attachments/chart.pdf"]);
    f.db.exec("CREATE TRIGGER refuse_removal_intent BEFORE UPDATE ON turn_journal_storage_operations WHEN json_extract(NEW.receipt,'$.items[0].state')='applying' BEGIN SELECT RAISE(ABORT,'SQLITE_FULL'); END");
    f.removal.start("odysseus",blocked.review.id,blocked.review.fingerprint); await f.removal.idle();
    expect(readFileSync(join(f.brain,"attachments/chart.pdf")), "STORAGE_REMOVAL_DURABLE_ITEM_INTENT").toEqual(f.original);
    f.db.exec("DROP TRIGGER refuse_removal_intent");
    const unavailable = await f.removal.review("odysseus","odysseus-retain-001",["attachments/chart.pdf"]);
    f.db.exec("CREATE TRIGGER refuse_original BEFORE INSERT ON turn_journal_reservations WHEN NEW.kind='copy' BEGIN SELECT RAISE(ABORT,'SQLITE_FULL'); END");
    f.removal.start("odysseus",unavailable.review.id,unavailable.review.fingerprint); await f.removal.idle();
    expect(existsSync(join(f.brain,"attachments/chart.pdf")), "STORAGE_REMOVAL_RETAIN_BEFORE_UNLINK").toBe(true);
    expect(readFileSync(join(f.brain,"attachments/chart.pdf"))).toEqual(f.original);
  } finally { await f.close(); }
});

test("cancellation completes the current item acknowledgement and leaves later items not started", async () => {
  const f=storageRemovalFixture(),id="odysseus-cancel-001";
  try {
    const review=await f.removal.review("odysseus",id,["attachments/chart.pdf","attachments/score.pdf"]);
    const write=f.journal.writeOperation.bind(f.journal);let cancelled=false;
    f.journal.writeOperation=<T>(apply:()=>T):T=>{const result=write(apply);const row=f.db.query("SELECT receipt FROM turn_journal_storage_operations WHERE id=?").get(id) as {receipt:string}|null;
      if(!cancelled&&row&&JSON.parse(row.receipt).items[0].state==="removed"){cancelled=true;f.removal.cancel("odysseus",id);}return result;};
    f.removal.start("odysseus",id,review.review.fingerprint);await f.removal.idle();
    expect(f.removal.receipt("odysseus",id),"STORAGE_CANCEL_PRESERVES_ACK_AND_UNSTARTED").toMatchObject({state:"partial",items:[{state:"removed",undoAvailable:true},{state:"not-started"}]});
    expect(readFileSync(join(f.brain,"attachments/score.pdf"))).toEqual(f.original);
  }finally{await f.close();}
});

test("expired detail hides Undo and changed ignore policy cannot expand recovery coverage",async()=>{
  const f=storageRemovalFixture(),id="odysseus-expiry-001";
  try{
    const review=await f.removal.review("odysseus",id,["attachments/chart.pdf"]);f.removal.start("odysseus",id,review.review.fingerprint);await f.removal.idle();
    const undo=await f.removal.review("odysseus","odysseus-ignore-undo",["attachments/chart.pdf"],id);
    writeFileSync(join(f.brain,".gitignore"),"attachments/chart.pdf\n");f.removal.start("odysseus",undo.review.id,undo.review.fingerprint);await f.removal.idle();
    expect(existsSync(join(f.brain,"attachments/chart.pdf")),"STORAGE_UNDO_CURRENT_IGNORE_POLICY").toBe(false);
    expect(f.removal.receipt("odysseus",undo.review.id).items[0]?.state).toBe("protected");
    f.db.query("UPDATE turn_journal_turns SET state='expired' WHERE turn_id=?").run(`storage_${id}`);
    expect(f.removal.receipt("odysseus",id).items[0],"STORAGE_UNDO_EXPIRY_VISIBLE").toMatchObject({undoAvailable:false,undoReason:"retained_detail_expired_or_unavailable"});
  }finally{await f.close();}
});


test("revocation after retained-original admission still refuses the file effect",async()=>{
  const f=storageRemovalFixture(),id="odysseus-late-revoke";
  try{
    const review=await f.removal.review("odysseus",id,["attachments/chart.pdf"]);
    const retain=f.journal.retainBefore.bind(f.journal);
    f.journal.retainBefore=async(...args)=>{const original=await retain(...args);f.revoke();return original;};
    f.removal.start("odysseus",id,review.review.fingerprint);await f.removal.idle();f.allow();
    expect(existsSync(join(f.brain,"attachments/chart.pdf")),"STORAGE_REMOVAL_AUTHORITY_BEFORE_EFFECT").toBe(true);
    expect(readFileSync(join(f.brain,"attachments/chart.pdf"))).toEqual(f.original);
  }finally{await f.close();}
});

test("Undo leases only originals still owned at the atomic retention admission boundary",async()=>{
  const f=storageRemovalFixture(),id="odysseus-lease-original";
  try{
    const review=await f.removal.review("odysseus",id,["attachments/chart.pdf"]);f.removal.start("odysseus",id,review.review.fingerprint);await f.removal.idle();
    const undo=await f.removal.review("odysseus","odysseus-lease-undo",["attachments/chart.pdf"],id),write=f.journal.writeOperation.bind(f.journal);let expired=false;
    f.journal.writeOperation=<T>(apply:()=>T):T=>{const result=write(apply);const row=f.db.query("SELECT receipt FROM turn_journal_storage_operations WHERE id=?").get(undo.review.id) as {receipt:string}|null;
      if(!expired&&row&&JSON.parse(row.receipt).items[0].state==="applying"){expired=true;f.db.query("UPDATE turn_journal_turns SET state='expired' WHERE turn_id=?").run(`storage_${id}`);}return result;};
    f.removal.start("odysseus",undo.review.id,undo.review.fingerprint);await f.removal.idle();
    expect(existsSync(join(f.brain,"attachments/chart.pdf")),"STORAGE_UNDO_RETENTION_CHECK_AT_LEASE").toBe(false);
  }finally{await f.close();}
});
