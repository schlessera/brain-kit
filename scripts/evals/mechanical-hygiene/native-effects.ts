/** Exact source/log effects and a narrow separately retained auxiliary grammar. */
import { Database } from "bun:sqlite";
import { join } from "node:path";
import type { Phase } from "./collector";
import type { TreeEvidence } from "./observer";
import { assessEffects, type EffectApproval } from "./effects";
const cache = new Set(["brain.db","brain.db-wal","brain.db-shm"]);
const scratch = new Set([".brain/scratch/hygiene-extra.json",".brain/scratch/hygiene-fixed.json"]);
export function assessNativeEffects(root:string,before:TreeEvidence,after:TreeEvidence,expected:EffectApproval,phase:Phase) {
  const sourceBefore:TreeEvidence={},sourceAfter:TreeEvidence={},sourceExpected:EffectApproval={};
  const auxiliary:Record<string,unknown>={},problems:string[]=[];
  for(const [path,entry]of Object.entries(before))if(!cache.has(path)&&!scratch.has(path))sourceBefore[path]=entry;
  for(const [path,entry]of Object.entries(after)){
    if(cache.has(path)||scratch.has(path)){
      auxiliary[path]=entry;
      if(entry.kind!=="file"||entry.mode!==0o644)problems.push(`Wrong auxiliary kind or mode: ${path}`);
    }else sourceAfter[path]=entry;
  }
  for(const [path,entry]of Object.entries(expected))if(!cache.has(path)&&!scratch.has(path))sourceExpected[path]=entry;
  // The SQLite cache is disposable but arbitrary bytes at its path are not an
  // approved effect. Read-only integrity proof cannot modify source authority.
  if(after["brain.db"]?.kind==="file"){
    let db:Database|undefined;
    try{db=new Database(join(root,"brain.db"),{readonly:true});const result=db.query("PRAGMA integrity_check").all() as Array<{integrity_check:string}>;
      if(result.length!==1||result[0].integrity_check!=="ok")problems.push("Disposable cache integrity failed");
    }catch{problems.push("Disposable cache cannot be read as SQLite");}finally{db?.close();}
  }else problems.push("Actual indexed cache is missing");
  for(const path of scratch){
    const entry=after[path];
    if(!entry){if(path.endsWith("hygiene-extra.json")||phase!=="dry-run")problems.push(`Missing required scratch input: ${path}`);continue;}
    try{
      const values=JSON.parse(Buffer.from(entry.bytesBase64??"","base64").toString("utf8"));
      if(!Array.isArray(values))throw Error("Not an array");
      if(path.endsWith("hygiene-extra.json")&&values.length)throw Error("Authored inputs have no canonical semantic conflicts");
      if(path.endsWith("hygiene-fixed.json")){
        if(phase!=="apply"&&values.length)throw Error("Dry/repeat may not claim new fixes");
        for(const value of values)if(!value||typeof value!=="object"||Array.isArray(value)||Object.keys(value).sort().join(",")!=="fix,path"||typeof value.path!=="string"||typeof value.fix!=="string"||!value.fix.trim()||value.fix.length>1600)throw Error("Malformed fix description");
        if(new Set(values.map((value:any)=>value.path)).size!==values.length)throw Error("Duplicate fix receipt");
        for(const value of values)if(!expected[value.path]?.changed)throw Error("Fix receipt claims an unapproved source change");
      }
    }catch{problems.push(`Unapproved scratch contents: ${path}`);}
  }
  const assessment=assessEffects(sourceBefore,sourceAfter,sourceExpected);
  return {...assessment,accepted:assessment.accepted&&!problems.length,problems:[...assessment.problems,...problems],auxiliary,semanticApproval:false as const};
}
