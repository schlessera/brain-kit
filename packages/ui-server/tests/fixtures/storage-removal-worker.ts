import { existsSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { storageRemovalFixture } from "../helpers/storage-removal-fixture.js";
import { createUiDb } from "../../src/db/client.js";
import { createWriterGate } from "../../src/brain/writer-gate.js";
const [root,phase,id,marker]=process.argv.slice(2) as [string,string,string,string];
if(phase==="writer") {
  const db=createUiDb(join(root,"ui.db")),gate=createWriterGate(db,join(root,"brain"),{pollMs:1}),hold=await gate.acquire("shared","turn:athena",{turn:true});
  try { writeFileSync(marker,"holding");while(!existsSync(marker+"-release"))await Bun.sleep(5);writeFileSync(join(root,"brain/attachments/chart.pdf"),"Athena's concurrent revision"); }
  finally{hold.release();db.close();}
} else {
  const f=storageRemovalFixture(root),target=join(f.brain,"attachments/chart.pdf");
  const pause=()=>{writeFileSync(marker,phase);Atomics.wait(new Int32Array(new SharedArrayBuffer(4)),0,0);};
  const retain=f.journal.retainBefore.bind(f.journal),write=f.journal.writeOperation.bind(f.journal);
  if(phase==="after-retain")f.journal.retainBefore=async(...args)=>{const result=await retain(...args);pause();return result;};
  f.journal.writeOperation=<T>(apply:()=>T):T=>{
    const state=()=>{const row=f.db.query("SELECT receipt FROM turn_journal_storage_operations WHERE id=?").get(id) as {receipt:string}|null;return row?JSON.parse(row.receipt).items[0].state:null;};
    if(phase==="after-unlink"&&state()==="applying"&&!existsSync(target))pause();
    const result=write(apply);
    if(phase==="after-intent"&&state()==="applying")pause();
    if(phase==="after-ack"&&state()==="removed")pause();
    return result;
  };
  try{const review=await f.removal.review("odysseus",id,["attachments/chart.pdf"]);f.removal.start("odysseus",id,review.review.fingerprint);await f.removal.idle();throw Error("Crash boundary was not reached");}
  finally{await f.close();}
}
