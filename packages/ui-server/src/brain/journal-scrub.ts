/** Bounded, host-private orphan quarantine. Only the journal write worker calls this. */
import { createHash } from "node:crypto";
import { closeSync, constants, fstatSync, fsyncSync, mkdirSync, openSync, opendirSync, readSync, renameSync, type Dir } from "node:fs";
import type { Database } from "bun:sqlite";

const JOURNAL_SCRUB_FILES = 64;
export interface JournalScrubResult {
  state: "complete" | "skipped";
  reason: "journal_busy" | null;
  listed: number; unaccounted: number; unaccountedBytes: number;
  corrupt: number; corruptBytes: number; quarantined: number; quarantinedBytes: number;
}
export function createJournalScrub(db: Database, root: string, write: <T>(operation: () => T) => T) {
  let listing: Dir | undefined;
  const quarantine = `${root}.quarantine`;
  function protectedHash(hash: string) {
    return Boolean(db.query(`SELECT 1 FROM turn_journal_objects WHERE hash=?1
      UNION ALL SELECT 1 FROM turn_journal_object_refs WHERE hash=?1
      UNION ALL SELECT 1 FROM turn_journal_reservations WHERE hash=?1 LIMIT 1`).get(hash));
  }
  const busy = () => Boolean(db.query("SELECT 1 FROM turn_journal_turns WHERE ended_at IS NULL LIMIT 1").get());
  return {
    run(): JournalScrubResult {
      const result: JournalScrubResult = { state:"complete",reason:null,listed:0,unaccounted:0,unaccountedBytes:0,corrupt:0,corruptBytes:0,quarantined:0,quarantinedBytes:0 };
      const skip = () => { result.state="skipped";result.reason="journal_busy";return result; };
      if (busy()) return skip();
      mkdirSync(quarantine,{mode:0o700,recursive:true});
      const source=openSync(root,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      let target: number;
      try { target=openSync(quarantine,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW); }
      catch(error) {closeSync(source);throw error;}
      try {
        if ((fstatSync(source).mode&0o077)||(fstatSync(target).mode&0o077)) throw Error("Journal scrub requires private directories");
        const at=(fd:number,hash:string)=>`/proc/self/fd/${fd}/${hash}`;
        const verify=(directory:number,hash:string):number|null=>{
          let fd:number;
          try { fd=openSync(at(directory,hash),constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK); }
          catch(error) { if((error as NodeJS.ErrnoException).code==="ENOENT") return null;throw error; }
          try {
            const info=fstatSync(fd);
            if(!info.isFile()||info.nlink!==1) throw Error("Journal scrub candidate is not a private regular file");
            const digest=createHash("sha256"),buffer=Buffer.alloc(64*1024);
            for(;;) {const count=readSync(fd,buffer,0,buffer.length,null);if(!count)break;digest.update(buffer.subarray(0,count));}
            if(digest.digest("hex")!==hash) {result.corrupt++;result.corruptBytes+=info.size;return null;}
            return info.size;
          } finally {closeSync(fd);}
        };
        // Reserve in a FULL commit first. A crash or a later refused commit
        // cannot make quarantined bytes disappear from the quota.
        const reserved=write(()=>{
          if(busy()) return null;
          const rows=db.query("SELECT hash,bytes FROM turn_journal_scrub_quarantine WHERE state='reserved' LIMIT ?").all(JOURNAL_SCRUB_FILES) as {hash:string;bytes:number}[];
          listing ??= opendirSync(root);
          while(result.listed<JOURNAL_SCRUB_FILES && rows.length<JOURNAL_SCRUB_FILES) {
            const entry=listing.readSync();
            if(!entry) {listing.closeSync();listing=undefined;break;}
            result.listed++;
            const hash=entry.name;
            if(!/^[a-f0-9]{64}$/.test(hash)||protectedHash(hash)||db.query("SELECT 1 FROM turn_journal_scrub_quarantine WHERE hash=?").get(hash)) continue;
            const corruptBefore=result.corrupt,corruptBytesBefore=result.corruptBytes;
            const bytes=verify(source,hash);
            if(bytes===null) {
              if(result.corrupt!==corruptBefore){result.unaccounted++;result.unaccountedBytes+=result.corruptBytes-corruptBytesBefore;}
              continue;
            }
            result.unaccounted++;result.unaccountedBytes+=bytes;
            db.query("INSERT INTO turn_journal_scrub_quarantine VALUES (?,?,'reserved')").run(hash,bytes);
            rows.push({hash,bytes});
          }
          return rows;
        });
        if(!reserved)return skip();
        write(()=>{
          if(busy()) {skip();return;}
          for(const row of reserved) {
            const corruptBefore=result.corrupt;
            const already=verify(target,row.hash);
            if(result.corrupt!==corruptBefore)continue;
            if(already===null && protectedHash(row.hash)) {
              // Release only an unmoved reservation. An interrupted move may
              // already coexist with newly retained bytes of the same hash.
              db.query("DELETE FROM turn_journal_scrub_quarantine WHERE hash=? AND state='reserved'").run(row.hash);continue;
            }
            if(already===null) {
              const bytes=verify(source,row.hash);if(bytes===null)continue;
              if(bytes!==row.bytes)throw Error("Journal scrub candidate changed after reservation");
              renameSync(at(source,row.hash),at(target,row.hash));fsyncSync(target);fsyncSync(source);
            } else if(already!==row.bytes)throw Error("Journal scrub quarantine changed size");
            db.query("UPDATE turn_journal_scrub_quarantine SET state='quarantined' WHERE hash=?").run(row.hash);
            result.quarantined++;result.quarantinedBytes+=row.bytes;
          }
        });
        return result;
      } finally {closeSync(source);closeSync(target);}
    },
    close() {listing?.closeSync();listing=undefined;},
  };
}
