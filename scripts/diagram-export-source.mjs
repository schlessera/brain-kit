/** Test-owned CLI source inputs; preparation precedes the pinned Docker runner. */
import {createHash} from "node:crypto";
import {chmodSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,symlinkSync,writeFileSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
import {diagramInstallationIdentity} from "./diagram-export-installation.mjs";
const workspaceNames=Object.freeze({common:"@schlessera/brain-common",core:"@schlessera/brain",geo:"@schlessera/brain-geo","module-diagrams":"@schlessera/brain-module-diagrams","render-template":"@schlessera/brain-render-template","ui-render-puppeteer":"@schlessera/brain-render-puppeteer"});
export const diagramSourceDomains=Object.freeze(Object.keys(workspaceNames));
export const diagramSourceSetup=Object.freeze(["package.json","bun.lock","tsconfig.json","bunfig.toml","scripts/test-network-child-preload.ts","scripts/test-network-guard.ts","scripts/workspace-lease.mjs","scripts/diagram-export-source.mjs","scripts/diagram-export-source.d.mts","scripts/prepare-diagram-export-source.mjs","scripts/prepare-diagram-export-source.d.mts","scripts/visual.mjs","scripts/diagram-export-installation.mjs","scripts/diagram-export-installation.d.mts"]);
export const isDiagramSource=path=>diagramSourceSetup.includes(path)||diagramSourceDomains.some(name=>path.startsWith(`packages/${name}/`));
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
const archivePath=repo=>join(repo,"tmp/diagram-export-source.json");
/** Path/mode/content identity is independent of checkout IDs and output roots. */
export function diagramSourceIdentity(inputs){return digest(Buffer.from(JSON.stringify([...inputs].sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0).map(entry=>[entry.path,entry.mode,entry.sha256]))));}
/** Materialize each invocation privately; the archive never selects an arbitrary root. */
export function materializeDiagramExportSource(repo,state,checkout,expected){
 const raw=readFileSync(archivePath(repo));if(raw.length>32*1024*1024)throw Error("Unbounded native diagram source archive");
 const record=JSON.parse(raw.toString("utf8"));
 if(record.version!==2||typeof record.immutable!=="boolean"||JSON.stringify(record.domains)!==JSON.stringify(diagramSourceDomains)||!Array.isArray(record.inputs)||!record.inputs.length||record.inputs.length>10000)throw Error("Invalid native diagram source archive");
 if(checkout&&(record.immutable!==true||record.checkout!==checkout))throw Error("Native diagram archive does not match the actual immutable checkout");
 if(record.sourceIdentity!==diagramSourceIdentity(record.inputs))throw Error("NATIVE_EXPORT_SOURCE_INVENTORY_CHANGED");
 if(expected&&(record.sourceIdentity!==expected.source||record.installation?.sha256!==expected.installation))throw Error("NATIVE_EXPORT_FRESH_RECEIPT_INPUT_MISMATCH");
 if(JSON.stringify(record.installation)!==JSON.stringify(diagramInstallationIdentity(repo)))throw Error("NATIVE_EXPORT_INSTALLED_INPUTS_CHANGED");
 const target=join(state,"source");if(existsSync(target))throw Error("Native diagram source view must be fresh");mkdirSync(target);
 const seen=new Set();
 for(const entry of record.inputs){
  if(typeof entry.path!=="string"||seen.has(entry.path)||!isDiagramSource(entry.path)||entry.path.startsWith("/")||entry.path.split("/").some(part=>["..",".","node_modules"].includes(part))||!["100644","100755"].includes(entry.mode)||typeof entry.bytes!=="string")throw Error("Invalid native diagram source entry");seen.add(entry.path);
  const bytes=Buffer.from(entry.bytes,"base64"),source=resolve(repo,entry.path),stat=lstatSync(source);
  if(bytes.toString("base64")!==entry.bytes||digest(bytes)!==entry.sha256||!stat.isFile()||realpathSync(source)!==source||digest(readFileSync(source))!==entry.sha256||Boolean(stat.mode&0o111)!==(entry.mode==="100755"))throw Error("Native diagram source bytes, modes or aliases changed after preparation");
  const destination=join(target,entry.path);mkdirSync(dirname(destination),{recursive:true});writeFileSync(destination,bytes);chmodSync(destination,entry.mode==="100755"?0o755:0o644);
 }
 if(diagramSourceSetup.some(path=>!seen.has(path))||diagramSourceDomains.some(name=>!seen.has(`packages/${name}/package.json`)))throw Error("Incomplete native diagram source archive");
 const workspaces=new Map(diagramSourceDomains.map(name=>{
  const manifest=JSON.parse(readFileSync(join(target,"packages",name,"package.json"),"utf8"));
  if(manifest.name!==workspaceNames[name])throw Error("Unsupported native diagram workspace identity");
  return[manifest.name,name];
 }));
 const modules=join(target,"node_modules");mkdirSync(modules);
 for(const [name,directory]of workspaces){
  const installed=join(repo,"node_modules",name);
  if(!existsSync(installed)||realpathSync(installed)!==join(repo,"packages",directory))throw Error("Missing or redirected installed native workspace dependency");
  const destination=join(modules,name);mkdirSync(dirname(destination),{recursive:true});symlinkSync(join(target,"packages",directory),destination,"dir");
 }
 for(const entry of readdirSync(join(repo,"node_modules"))){
  if(entry.startsWith("."))continue;
  const names=entry.startsWith("@")?readdirSync(join(repo,"node_modules",entry)).map(child=>`${entry}/${child}`):[entry];
  for(const name of names){if(name.startsWith("@schlessera/"))continue;const destination=join(modules,name);mkdirSync(dirname(destination),{recursive:true});symlinkSync(join(repo,"node_modules",name),destination,"dir");}
 }
 return target;
}
