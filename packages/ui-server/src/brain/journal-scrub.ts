/** Bounded, host-private orphan quarantine. Only the journal write worker calls this. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, opendirSync, readSync, renameSync, type Dir } from "node:fs";
import type { Database } from "bun:sqlite";

const JOURNAL_SCRUB_FILES = 64;
export interface JournalScrubResult {
  state: "complete" | "partial" | "skipped";
  reason: "journal_busy" | "quarantine_pending" | null;
  listed: number; unaccounted: number; unaccountedBytes: number;
  corrupt: number; corruptBytes: number; quarantined: number; quarantinedBytes: number;
  pending: number; pendingBytes: number;
}
export function createJournalScrub(db: Database, root: string, write: <T>(operation: () => T) => T) {
  let listing: Dir | undefined, batch: readonly string[] | undefined;
  let retryAfter = "";
  const quarantine = `${root}/quarantine`;
  const protectedHash = (hash: string) => Boolean(db.query(`SELECT 1 FROM turn_journal_objects WHERE hash=?1
    UNION ALL SELECT 1 FROM turn_journal_object_refs WHERE hash=?1
    UNION ALL SELECT 1 FROM turn_journal_reservations WHERE hash=?1 LIMIT 1`).get(hash));
  const busy = () => Boolean(db.query("SELECT 1 FROM turn_journal_turns WHERE ended_at IS NULL LIMIT 1").get());
  return {
    run(): JournalScrubResult {
      const result: JournalScrubResult = { state:"complete",reason:null,listed:0,unaccounted:0,unaccountedBytes:0,corrupt:0,corruptBytes:0,quarantined:0,quarantinedBytes:0,pending:0,pendingBytes:0 };
      const skip = () => { result.state="skipped";result.reason="journal_busy";return result; };
      if (busy()) return skip();
      mkdirSync(quarantine,{mode:0o700,recursive:true});
      const source=openSync(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      let target: number;
      try { target=openSync(quarantine,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW); }
      catch(error) {closeSync(source);throw error;}
      try {
        if ((fstatSync(source).mode&0o077)||(fstatSync(target).mode&0o077)) throw Error("Journal scrub requires private directories");
        const at=(fd:number,name:string)=>`/proc/self/fd/${fd}/${name}`;
        const countedCorrupt=new Set<string>();
        const verify=(directory:number,name:string):{bytes:number|null;corrupt:boolean}=>{
          let fd:number;
          try { fd=openSync(at(directory,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK); }
          catch(error) { if((error as NodeJS.ErrnoException).code==="ENOENT") return {bytes:null,corrupt:false};throw error; }
          try {
            const info=fstatSync(fd);
            if(!info.isFile()||info.nlink!==1) throw Error("Journal scrub candidate is not a private regular file");
            const digest=createHash("sha256"),buffer=Buffer.alloc(64*1024);
            for(;;) {const count=readSync(fd,buffer,0,buffer.length,null);if(!count)break;digest.update(buffer.subarray(0,count));}
            const corrupt=digest.digest("hex")!==name.slice(0,64);
            const identity=`${info.dev}:${info.ino}`;
            if(corrupt && !countedCorrupt.has(identity)) {countedCorrupt.add(identity);result.corrupt++;result.corruptBytes+=info.size;}
            return {bytes:info.size,corrupt};
          } finally {closeSync(fd);}
        };
        const retry=(after:string)=>db.query("SELECT hash,bytes FROM turn_journal_scrub_quarantine WHERE state='reserved' AND hash>? ORDER BY hash LIMIT ?")
          .all(after,JOURNAL_SCRUB_FILES/2) as {hash:string;bytes:number}[];
        let rows=retry(retryAfter);if(!rows.length && retryAfter)rows=retry("");
        const nextRetry=rows.at(-1)?.hash ?? "";
        // Freeze cursor input outside replayable accounting callbacks. Keep the
        // batch until reservation commits, including across a refused run.
        if(!batch) {
          const names:string[]=[];listing ??= opendirSync(root);
          while(names.length<JOURNAL_SCRUB_FILES-rows.length) {
            const entry=listing.readSync();
            if(!entry){listing.closeSync();listing=undefined;break;}
            names.push(entry.name);
          }
          batch=Object.freeze(names);
        }
        const selected=batch.slice(0,JOURNAL_SCRUB_FILES-rows.length);
        result.listed=selected.length;
        const additions:{hash:string;bytes:number}[]=[];
        for(const hash of selected) {
          if(!/^[a-f0-9]{64}$/.test(hash)||protectedHash(hash))continue;
          const prior=db.query("SELECT hash FROM turn_journal_scrub_quarantine WHERE substr(hash,1,64)=? AND state='reserved' ORDER BY rowid DESC LIMIT 1").get(hash) as {hash:string}|null;
          if(prior){const previous=verify(target,prior.hash);if(previous.bytes===null)continue;}
          const candidate=verify(source,hash);if(candidate.bytes===null)continue;
          result.unaccounted++;result.unaccountedBytes+=candidate.bytes;
          if(candidate.corrupt)continue;
          const name=db.query("SELECT 1 FROM turn_journal_scrub_quarantine WHERE hash=?").get(hash)?`${hash}-${randomUUID()}`:hash;
          additions.push({hash:name,bytes:candidate.bytes});
        }
        // Only database operations are replayed: no cursor, UUID, counters or
        // filesystem mutation lives in either accounting.write callback.
        const admitted=write(()=>{
          if(busy())return false;
          for(const row of additions)db.query("INSERT OR IGNORE INTO turn_journal_scrub_quarantine VALUES (?,?,'reserved')").run(row.hash,row.bytes);
          return true;
        });
        if(!admitted)return skip();
        batch=batch.length>selected.length?batch.slice(selected.length):undefined;retryAfter=nextRetry;rows=[...rows,...additions];
        const completed:{hash:string;bytes:number}[]=[],cancelled:string[]=[];
        if(busy())return skip();
        // The procedure itself holds the writer lock. Charge is already FULL
        // committed before any rename, and survives a failed state update.
        for(const row of rows) {
          const already=verify(target,row.hash);if(already.corrupt)continue;
          if(already.bytes===null && protectedHash(row.hash.slice(0,64))){cancelled.push(row.hash);continue;}
          if(already.bytes===null) {
            const candidate=verify(source,row.hash.slice(0,64));if(candidate.bytes===null||candidate.corrupt)continue;
            if(candidate.bytes!==row.bytes)throw Error("Journal scrub candidate changed after reservation");
            renameSync(at(source,row.hash.slice(0,64)),at(target,row.hash));fsyncSync(target);fsyncSync(source);
          }else if(already.bytes!==row.bytes)throw Error("Journal scrub quarantine changed size");
          completed.push(row);
        }
        write(()=>{
          for(const hash of cancelled)db.query("DELETE FROM turn_journal_scrub_quarantine WHERE hash=? AND state='reserved'").run(hash);
          for(const row of completed)db.query("UPDATE turn_journal_scrub_quarantine SET state='quarantined' WHERE hash=?").run(row.hash);
        });
        result.quarantined=completed.length;result.quarantinedBytes=completed.reduce((sum,row)=>sum+row.bytes,0);
        const pending=db.query("SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM turn_journal_scrub_quarantine WHERE state='reserved'").get() as {count:number;bytes:number};
        result.pending=pending.count;result.pendingBytes=pending.bytes;
        if(pending.count||listing||batch){result.state="partial";if(pending.count)result.reason="quarantine_pending";}
        return result;
      }finally{closeSync(source);closeSync(target);}
    },
    close(){listing?.closeSync();listing=undefined;batch=undefined;},
  };
}
