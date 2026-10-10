/** Cache bytes only while complete regular-file identity and change metadata match. */
import {lstatSync,readFileSync,type BigIntStats} from "node:fs";
import {hash} from "./protocol";
const fileHashes=new Map<string,{identity:string;sha:string}>();
/** Reuse bytes only while inode and nanosecond change metadata remain identical.
 * Every traversal still inspects every member, directory, link and ownership bound.
 * Restoring mtime cannot restore ctime after a write, chmod, link or replacement.
 */
export function hashFrozenFile(path:string,observed?:BigIntStats){
  const identity=(stat=lstatSync(path,{bigint:true}))=>{
    if(!stat.isFile()||stat.isSymbolicLink())throw Error("Frozen hash requires a regular file");
    return [stat.dev,stat.ino,stat.mode,stat.nlink,stat.uid,stat.gid,stat.size,stat.mtimeNs,stat.ctimeNs].join(":");
  };
  const before=identity(observed),cached=fileHashes.get(path);if(cached?.identity===before)return cached.sha;
  const sha=hash(readFileSync(path));if(identity()!==before)throw Error("Frozen file changed while hashing");
  fileHashes.set(path,{identity:before,sha});return sha;
}
