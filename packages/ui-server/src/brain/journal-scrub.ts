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
  let listing: Dir | undefined;
  let batch: readonly {name:string;alternate:string}[] | undefined, retryAfter="";
  const quarantine=`${root}/quarantine`;
  const protectedHash=(hash:string)=>Boolean(db.query(`SELECT 1 FROM turn_journal_objects WHERE hash=?1
    UNION ALL SELECT 1 FROM turn_journal_object_refs WHERE hash=?1
    UNION ALL SELECT 1 FROM turn_journal_reservations WHERE hash=?1 LIMIT 1`).get(hash));
  const busy=()=>Boolean(db.query("SELECT 1 FROM turn_journal_turns WHERE ended_at IS NULL LIMIT 1").get());
  return {
    run(): JournalScrubResult {
      const result:JournalScrubResult={state:"complete",reason:null,listed:0,unaccounted:0,unaccountedBytes:0,corrupt:0,corruptBytes:0,quarantined:0,quarantinedBytes:0,pending:0,pendingBytes:0};
      const skip=()=>{result.state="skipped";result.reason="journal_busy";return result;};
      if(busy())return skip();
      mkdirSync(quarantine,{mode:0o700,recursive:true});
      const source=openSync(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      let target:number;
      try{target=openSync(quarantine,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);}catch(error){closeSync(source);throw error;}
      try{
        if((fstatSync(source).mode&0o077)||(fstatSync(target).mode&0o077))throw Error("Journal scrub requires private directories");
        const at=(fd:number,name:string)=>`/proc/self/fd/${fd}/${name}`;
        const verify=(directory:number,name:string,corruptCopies:Map<string,number>):{bytes:number|null;corrupt:boolean}=>{
          let fd:number;
          try{fd=openSync(at(directory,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
          catch(error){if((error as NodeJS.ErrnoException).code==="ENOENT")return {bytes:null,corrupt:false};throw error;}
          try{
            const info=fstatSync(fd);
            if(!info.isFile()||info.nlink!==1)throw Error("Journal scrub candidate is not a private regular file");
            const digest=createHash("sha256"),buffer=Buffer.alloc(64*1024);
            for(;;){const count=readSync(fd,buffer,0,buffer.length,null);if(!count)break;digest.update(buffer.subarray(0,count));}
            const corrupt=digest.digest("hex")!==name.slice(0,64);
            if(corrupt)corruptCopies.set(`${info.dev}:${info.ino}`,info.size);
            return {bytes:info.size,corrupt};
          }finally{closeSync(fd);}
        };
        // Directory iteration and random identities cannot be rolled back.
        // Freeze both before any replayable accounting callback, and retain
        // uncommitted input across a failed run.
        if(!batch){
          const names:{name:string;alternate:string}[]=[];listing??=opendirSync(root);
          while(names.length<JOURNAL_SCRUB_FILES/2){
            const entry=listing.readSync();if(!entry){listing.closeSync();listing=undefined;break;}
            names.push({name:entry.name,alternate:`${entry.name}-${randomUUID()}`});
          }
          batch=Object.freeze(names);
        }
        const frozen=batch;
        const reserved=write(()=>{
          if(busy())return null;
          const retry=(after:string)=>db.query("SELECT hash,bytes FROM turn_journal_scrub_quarantine WHERE state='reserved' AND hash>? ORDER BY hash LIMIT ?")
            .all(after,JOURNAL_SCRUB_FILES/2) as {hash:string;bytes:number}[];
          let rows=retry(retryAfter);if(!rows.length&&retryAfter)rows=retry("");
          const nextRetry=rows.at(-1)?.hash??"",selected=frozen.slice(0,JOURNAL_SCRUB_FILES-rows.length);
          const corruptCopies=new Map<string,number>();let unaccounted=0,unaccountedBytes=0;
          for(const entry of selected){
            const hash=entry.name;if(!/^[a-f0-9]{64}$/.test(hash)||protectedHash(hash))continue;
            const prior=db.query("SELECT hash FROM turn_journal_scrub_quarantine WHERE substr(hash,1,64)=? AND state='reserved' ORDER BY rowid DESC LIMIT 1").get(hash) as {hash:string}|null;
            if(prior&&verify(target,prior.hash,corruptCopies).bytes===null)continue;
            const candidate=verify(source,hash,corruptCopies);if(candidate.bytes===null)continue;
            unaccounted++;unaccountedBytes+=candidate.bytes;if(candidate.corrupt)continue;
            const name=db.query("SELECT 1 FROM turn_journal_scrub_quarantine WHERE hash=?").get(hash)?entry.alternate:hash;
            db.query("INSERT INTO turn_journal_scrub_quarantine VALUES (?,?,'reserved')").run(name,candidate.bytes);
            rows.push({hash:name,bytes:candidate.bytes});
          }
          return {rows,nextRetry,consumed:selected.length,corruptCopies,unaccounted,unaccountedBytes};
        });
        if(!reserved)return skip();
        batch=frozen.length>reserved.consumed?frozen.slice(reserved.consumed):undefined;retryAfter=reserved.nextRetry;
        // Both phases hold SQLite's writer lock. The charge is already FULL
        // committed. Rename is idempotent on replay: a moved destination is
        // verified and reused, while all counters are local to that attempt.
        const moved=write(()=>{
          if(busy())return null;
          const corruptCopies=new Map(reserved.corruptCopies);let count=0,bytes=0;
          for(const row of reserved.rows){
            const state=db.query("SELECT state FROM turn_journal_scrub_quarantine WHERE hash=?").get(row.hash) as {state:string}|null;
            if(state?.state!=="reserved")continue;
            const already=verify(target,row.hash,corruptCopies);if(already.corrupt)continue;
            if(already.bytes===null&&protectedHash(row.hash.slice(0,64))){db.query("DELETE FROM turn_journal_scrub_quarantine WHERE hash=? AND state='reserved'").run(row.hash);continue;}
            if(already.bytes===null){
              const candidate=verify(source,row.hash.slice(0,64),corruptCopies);if(candidate.bytes===null||candidate.corrupt)continue;
              if(candidate.bytes!==row.bytes)throw Error("Journal scrub candidate changed after reservation");
              renameSync(at(source,row.hash.slice(0,64)),at(target,row.hash));fsyncSync(target);fsyncSync(source);
            }else if(already.bytes!==row.bytes)throw Error("Journal scrub quarantine changed size");
            db.query("UPDATE turn_journal_scrub_quarantine SET state='quarantined' WHERE hash=?").run(row.hash);count++;bytes+=row.bytes;
          }
          return {count,bytes,corruptCopies};
        });
        if(!moved)return skip();
        result.listed=reserved.consumed;result.unaccounted=reserved.unaccounted;result.unaccountedBytes=reserved.unaccountedBytes;
        result.quarantined=moved.count;result.quarantinedBytes=moved.bytes;
        result.corrupt=moved.corruptCopies.size;result.corruptBytes=[...moved.corruptCopies.values()].reduce((sum,bytes)=>sum+bytes,0);
        const pending=db.query("SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM turn_journal_scrub_quarantine WHERE state='reserved'").get() as {count:number;bytes:number};
        result.pending=pending.count;result.pendingBytes=pending.bytes;
        if(pending.count||listing||batch){result.state="partial";if(pending.count)result.reason="quarantine_pending";}
        return result;
      }finally{closeSync(source);closeSync(target);}
    },
    close(){listing?.closeSync();listing=undefined;batch=undefined;},
  };
}
