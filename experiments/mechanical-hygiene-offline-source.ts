/** Offline native controls own independent runtime bytes even after Bun's cache install. */
import {cpSync,lstatSync,mkdtempSync,readdirSync,rmSync} from "node:fs";
import {join,relative} from "node:path";
let prepared:string|undefined,copy:string|undefined;
function sharesRegularFiles(path:string):boolean{
  const stat=lstatSync(path);if(stat.isSymbolicLink())return false;
  if(stat.isFile())return stat.nlink!==1;
  return stat.isDirectory()&&readdirSync(path).some(name=>sharesRegularFiles(join(path,name)));
}
export function offlineSource(source:string){
  if(prepared)return prepared;
  if(!sharesRegularFiles(join(source,"node_modules")))return prepared=source;
  copy=mkdtempSync("/tmp/hygiene-owned-source-");
  cpSync(source,copy,{recursive:true,preserveTimestamps:true,verbatimSymlinks:true,filter:path=>{
    const name=relative(source,path).replaceAll("\\","/");
    return !name.startsWith(".")&&!/^(?:node_modules|tmp|dist)(?:\/|$)/.test(name)&&!/^packages\/[^/]+\/dist(?:\/|$)/.test(name);
  }});
  cpSync(join(source,"node_modules"),join(copy,"node_modules"),{recursive:true,preserveTimestamps:true,verbatimSymlinks:true});
  if(sharesRegularFiles(join(copy,"node_modules")))throw Error("Offline runtime copy still shares mutable regular files");
  prepared=copy;
  // Retain a failed control's owned source for diagnostics; successful tests
  // have already drained every child before the process's final cleanup.
  process.once("exit",code=>{if(code===0&&copy)rmSync(copy,{recursive:true,force:true});});
  return prepared;
}
