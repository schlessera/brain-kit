import {journalDirectory} from "./journal-directory.js";
/** Bounded, host-private orphan quarantine. Only the journal write worker calls this. */
import { createHash, randomUUID } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, lstatSync, openSync, readSync, renameSync } from "node:fs";
import {JournalCapacityError} from "./journal-objects.js";
import type { Database } from "bun:sqlite";

const JOURNAL_SCRUB_FILES = 64;
type ReadFailure={path:string;errorClass:string;message:string};
const SCRUB_NAME = /^[a-f0-9]{64}(?:-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})?$/;
export interface JournalScrubResult {
  state: "complete" | "partial" | "skipped";
  reason: "journal_busy" | "quarantine_pending" | null;
  listed: number; unaccounted: number; unaccountedBytes: number;
  corrupt: number; corruptBytes: number; quarantined: number; quarantinedBytes: number;
  pending: number; pendingBytes: number;
  capacityBlocked?: number;
  readFailures?: ReadFailure[];
}
export function createJournalScrub(db: Database, root: string, write: <T>(operation: () => T) => T) {
  const directory=journalDirectory(root);let more=false;
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
        const verify=(directory:number,name:string,corruptCopies:Map<string,number>,readFailures:Map<string,ReadFailure>):{bytes:number|null;corrupt:boolean}=>{
          // Persisted rows are untrusted restored data. Validate before even
          // constructing a descriptor-relative pathname.
          if(!SCRUB_NAME.test(name)) {
            corruptCopies.set(`invalid:${name}`,0);return {bytes:null,corrupt:true};
          }
          const failed=(error:unknown)=>{
            const path=(directory===source?"":"quarantine/")+name;
            readFailures.set(path,{path,errorClass:error instanceof Error?error.name:"Error",message:(error instanceof Error?error.message:String(error)).slice(0,2000)});
            // Unknown I/O state blocks this file; it does not prove corruption.
            return {bytes:null,corrupt:true};
          };
          let fd:number;
          try{
            const info=lstatSync(at(directory,name));
            if(!info.isFile()||info.nlink!==1){corruptCopies.set(`${info.dev}:${info.ino}`,info.size);return {bytes:null,corrupt:true};}
            fd=openSync(at(directory,name),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);}
          catch(error){
            const code=(error as NodeJS.ErrnoException).code;
            if(code==="ENOENT")return {bytes:null,corrupt:false};
            return failed(error);
          }
          try{
            const info=fstatSync(fd);
            if(!info.isFile()||info.nlink!==1){corruptCopies.set(`${info.dev}:${info.ino}`,info.size);return {bytes:null,corrupt:true};}
            const digest=createHash("sha256"),buffer=Buffer.alloc(64*1024);
            for(;;){const count=readSync(fd,buffer,0,buffer.length,null);if(!count)break;digest.update(buffer.subarray(0,count));}
            const corrupt=digest.digest("hex")!==name.slice(0,64);
            if(corrupt)corruptCopies.set(`${info.dev}:${info.ino}`,info.size);
            return {bytes:info.size,corrupt};
          }catch(error){return failed(error);}finally{closeSync(fd);}
        };
        // Directory iteration and random identities cannot be rolled back.
        // Freeze both before any replayable accounting callback, and retain
        // uncommitted input across a failed run.
        if(!batch){
          const listed=directory.next(JOURNAL_SCRUB_FILES/2);more=listed.more;
          const names=listed.names.map(name=>({name,alternate:`${name}-${randomUUID()}`}));
          batch=Object.freeze(names);
        }
        const frozen=batch;
        const observation:{current?:{unaccounted:number;unaccountedBytes:number;corruptCopies:Map<string,number>;readFailures:Map<string,ReadFailure>}}={};
        const reserve=(entries=frozen,includeRetries=true)=>write(()=>{
          observation.current=undefined;
          if(busy())return null;
          const retry=(after:string)=>db.query("SELECT hash,bytes FROM turn_journal_scrub_quarantine WHERE state='reserved' AND hash>? ORDER BY hash LIMIT ?")
            .all(after,JOURNAL_SCRUB_FILES/2) as {hash:string;bytes:number}[];
          let rows=includeRetries?retry(retryAfter):[];if(includeRetries&&!rows.length&&retryAfter)rows=retry("");
          const nextRetry=rows.at(-1)?.hash??"",selected=entries.slice(0,JOURNAL_SCRUB_FILES-rows.length);
          const corruptCopies=new Map<string,number>(),readFailures=new Map<string,ReadFailure>();let unaccounted=0,unaccountedBytes=0;
          for(const entry of selected){
            const hash=entry.name;if(!/^[a-f0-9]{64}$/.test(hash)||protectedHash(hash))continue;
            const prior=db.query("SELECT hash FROM turn_journal_scrub_quarantine WHERE substr(hash,1,64)=? AND state='reserved' ORDER BY rowid DESC LIMIT 1").get(hash) as {hash:string}|null;
            if(prior&&SCRUB_NAME.test(prior.hash)){const destination=verify(target,prior.hash,corruptCopies,readFailures);if(destination.bytes===null&&!destination.corrupt)continue;}
            const candidate=verify(source,hash,corruptCopies,readFailures);if(candidate.bytes===null)continue;
            unaccounted++;unaccountedBytes+=candidate.bytes;if(candidate.corrupt)continue;
            observation.current={unaccounted,unaccountedBytes,corruptCopies,readFailures};
            const name=db.query("SELECT 1 FROM turn_journal_scrub_quarantine WHERE hash=?").get(hash)?entry.alternate:hash;
            db.query("INSERT INTO turn_journal_scrub_quarantine VALUES (?,?,'reserved')").run(name,candidate.bytes);
            rows.push({hash:name,bytes:candidate.bytes});
          }
          observation.current={unaccounted,unaccountedBytes,corruptCopies,readFailures};
          return {rows,nextRetry,consumed:selected.length,corruptCopies,readFailures,unaccounted,unaccountedBytes};
        });
        let reserved:ReturnType<typeof reserve>,capacityBlocked=0;
        try{reserved=reserve();}
        catch(error){
          if(!(error instanceof JournalCapacityError))throw error;
          // A refused batch has committed nothing. Retry its bounded candidates
          // independently so one large orphan cannot block smaller siblings.
          reserved=reserve([],true);if(!reserved)return skip();
          for(const entry of frozen.slice(0,JOURNAL_SCRUB_FILES-reserved.rows.length)){
            try{
              const part=reserve([entry],false);if(!part)return skip();
              reserved.rows.push(...part.rows);reserved.unaccounted+=part.unaccounted;reserved.unaccountedBytes+=part.unaccountedBytes;
              for(const [key,bytes]of part.corruptCopies)reserved.corruptCopies.set(key,bytes);
              for(const [key,value]of part.readFailures)reserved.readFailures.set(key,value);
            }catch(failure){
              if(!(failure instanceof JournalCapacityError))throw failure;capacityBlocked++;
              const observed=observation.current;
              if(observed){reserved.unaccounted+=observed.unaccounted;reserved.unaccountedBytes+=observed.unaccountedBytes;for(const [key,bytes]of observed.corruptCopies)reserved.corruptCopies.set(key,bytes);for(const [key,value]of observed.readFailures)reserved.readFailures.set(key,value);}
            }
            reserved.consumed++;
          }
        }
        if(!reserved)return skip();
        if(capacityBlocked)result.capacityBlocked=capacityBlocked;
        batch=frozen.length>reserved.consumed?frozen.slice(reserved.consumed):undefined;retryAfter=reserved.nextRetry;
        // Both phases hold SQLite's writer lock. The charge is already FULL
        // committed. Rename is idempotent on replay: a moved destination is
        // verified and reused, while all counters are local to that attempt.
        const moved=write(()=>{
          if(busy())return null;
          const corruptCopies=new Map(reserved.corruptCopies),readFailures=new Map(reserved.readFailures);let count=0,bytes=0;
          for(const row of reserved.rows){
            const state=db.query("SELECT state FROM turn_journal_scrub_quarantine WHERE hash=?").get(row.hash) as {state:string}|null;
            if(state?.state!=="reserved")continue;
            const already=verify(target,row.hash,corruptCopies,readFailures);if(already.corrupt)continue;
            if(already.bytes===null&&protectedHash(row.hash.slice(0,64))){db.query("DELETE FROM turn_journal_scrub_quarantine WHERE hash=? AND state='reserved'").run(row.hash);continue;}
            if(already.bytes===null){
              const candidate=verify(source,row.hash.slice(0,64),corruptCopies,readFailures);if(candidate.bytes===null||candidate.corrupt)continue;
              if(candidate.bytes!==row.bytes){corruptCopies.set(`reservation:${row.hash}`,candidate.bytes);continue;}
              renameSync(at(source,row.hash.slice(0,64)),at(target,row.hash));
            }else if(already.bytes!==row.bytes){corruptCopies.set(`reservation:${row.hash}`,already.bytes);continue;}
            // A previous attempt may have renamed then failed its sync or
            // SQL commit. Retry both directory barriers before claiming success.
            fsyncSync(target);fsyncSync(source);
            db.query("UPDATE turn_journal_scrub_quarantine SET state='quarantined' WHERE hash=?").run(row.hash);count++;bytes+=row.bytes;
          }
          return {count,bytes,corruptCopies,readFailures};
        });
        if(!moved)return skip();
        result.listed=reserved.consumed;result.unaccounted=reserved.unaccounted;result.unaccountedBytes=reserved.unaccountedBytes;
        result.quarantined=moved.count;result.quarantinedBytes=moved.bytes;
        result.corrupt=moved.corruptCopies.size;result.corruptBytes=[...moved.corruptCopies.values()].reduce((sum,bytes)=>sum+bytes,0);
        if(moved.readFailures.size)result.readFailures=[...moved.readFailures.values()];
        const pending=db.query("SELECT count(*) AS count,coalesce(sum(bytes),0) AS bytes FROM turn_journal_scrub_quarantine WHERE state='reserved'").get() as {count:number;bytes:number};
        result.pending=pending.count;result.pendingBytes=pending.bytes;
        if(pending.count||more||batch||capacityBlocked||moved.readFailures.size){result.state="partial";if(pending.count||capacityBlocked||moved.readFailures.size)result.reason="quarantine_pending";}
        return result;
      }finally{closeSync(source);closeSync(target);}
    },
    close(){directory.close();more=false;batch=undefined;},
  };
}
