/** Enumerate the native fixture's tracked source before entering Docker. */
import {spawnSync} from "node:child_process";
import {createHash} from "node:crypto";
import {lstatSync,mkdirSync,mkdtempSync,readFileSync,realpathSync,renameSync,rmSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
import {diagramSourceDomains,diagramSourceSetup,isDiagramSource,diagramSourceIdentity} from "./diagram-export-source.mjs";
import {diagramInstallationIdentity} from "./diagram-export-installation.mjs";
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
const archivePath=repo=>join(repo,"tmp/diagram-export-source.json");
/** Development uses current tracked bytes; hosted passing proof requires HEAD bytes. */
export function prepareDiagramExportSource(repo,immutable=false,expected){
 const git=(...args)=>{const result=spawnSync("git",args,{cwd:repo,encoding:"utf8"});if(result.status!==0)throw Error(`Cannot prepare native diagram source: ${result.stderr}`);return result.stdout;};
 const entries=git("ls-files","--stage","-z").split("\0").filter(Boolean).map(row=>{const tab=row.indexOf("\t"),[mode,oid,stage]=row.slice(0,tab).split(" ");return{mode,oid,stage,path:row.slice(tab+1)};}).filter(entry=>isDiagramSource(entry.path));
 if(!entries.length||diagramSourceSetup.some(path=>!entries.some(entry=>entry.path===path)))throw Error("Missing native diagram source configuration");
 if(immutable){const diff=spawnSync("git",["diff","--quiet","HEAD","--",...diagramSourceSetup,...diagramSourceDomains.map(name=>`packages/${name}`)],{cwd:repo});if(diff.status!==0)throw Error("Native diagram proof source differs from immutable HEAD");}
 const inputs=entries.map(entry=>{
  if(entry.stage!=="0"||!["100644","100755"].includes(entry.mode)||entry.path.startsWith("/")||entry.path.split("/").some(part=>["..",".","node_modules"].includes(part)))throw Error("Unsupported native diagram source path/mode");
  const source=resolve(repo,entry.path),stat=lstatSync(source);if(!stat.isFile()||realpathSync(source)!==source)throw Error("Native diagram source cannot use symlinks or missing files");
  const bytes=readFileSync(source);return{path:entry.path,mode:entry.mode,sha256:digest(bytes),bytes:bytes.toString("base64")};
 });
 const installation=diagramInstallationIdentity(repo);
 const sourceIdentity=diagramSourceIdentity(inputs);
 if(expected&&(installation.sha256!==expected.installation||sourceIdentity!==expected.source))throw Error("NATIVE_EXPORT_FRESH_RECEIPT_INPUT_MISMATCH");
 const head=git("rev-parse","HEAD").trim(),record={version:2,installation,sourceIdentity,immutable,checkout:immutable?head:null,base:head,domains:diagramSourceDomains,inputs};
 mkdirSync(join(repo,"tmp"),{recursive:true});const state=mkdtempSync(join(repo,"tmp/diagram-source-"));
 try{const file=join(state,"archive.json");writeFileSync(file,JSON.stringify(record));renameSync(file,archivePath(repo));}finally{rmSync(state,{recursive:true,force:true});}
 return record;
}
