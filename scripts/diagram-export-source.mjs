/** Test-owned CLI source inputs; preparation precedes the pinned Docker runner. */
import {createHash} from "node:crypto";
import {chmodSync,existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,realpathSync,symlinkSync,writeFileSync} from "node:fs";
import {dirname,join,resolve} from "node:path";
export const diagramSourceDomains=["common","core","geo","module-diagrams","render-template","ui-render-puppeteer"];
export const diagramSourceSetup=["package.json","bun.lock","tsconfig.json","bunfig.toml","scripts/test-network-child-preload.ts","scripts/test-network-guard.ts","scripts/workspace-lease.mjs","scripts/diagram-export-source.mjs","scripts/diagram-export-source.d.mts","scripts/prepare-diagram-export-source.mjs","scripts/visual.mjs"];
export const isDiagramSource=path=>diagramSourceSetup.includes(path)||diagramSourceDomains.some(name=>path.startsWith(`packages/${name}/`));
const digest=bytes=>createHash("sha256").update(bytes).digest("hex");
const archivePath=repo=>join(repo,"tmp/diagram-export-source.json");
/** Materialize each invocation privately; the archive never selects an arbitrary root. */
export function materializeDiagramExportSource(repo,state,checkout){
 const raw=readFileSync(archivePath(repo));if(raw.length>32*1024*1024)throw Error("Unbounded native diagram source archive");
 const record=JSON.parse(raw.toString("utf8"));
 if(record.version!==1||JSON.stringify(record.domains)!==JSON.stringify(diagramSourceDomains)||!Array.isArray(record.inputs)||!record.inputs.length||record.inputs.length>10000)throw Error("Invalid native diagram source archive");
 if(checkout&&(!record.immutable||record.checkout!==checkout))throw Error("Native diagram archive does not match the actual immutable checkout");
 const target=join(state,"source");if(existsSync(target))throw Error("Native diagram source view must be fresh");mkdirSync(target);
 const seen=new Set();
 for(const entry of record.inputs){
  if(typeof entry.path!=="string"||seen.has(entry.path)||!isDiagramSource(entry.path)||entry.path.startsWith("/")||entry.path.split("/").some(part=>["..",".","node_modules"].includes(part))||!["100644","100755"].includes(entry.mode)||typeof entry.bytes!=="string")throw Error("Invalid native diagram source entry");seen.add(entry.path);
  const bytes=Buffer.from(entry.bytes,"base64"),source=resolve(repo,entry.path),stat=lstatSync(source);
  if(bytes.toString("base64")!==entry.bytes||digest(bytes)!==entry.sha256||!stat.isFile()||realpathSync(source)!==source||digest(readFileSync(source))!==entry.sha256||Boolean(stat.mode&0o111)!==(entry.mode==="100755"))throw Error("Native diagram source bytes, modes or aliases changed after preparation");
  const destination=join(target,entry.path);mkdirSync(dirname(destination),{recursive:true});writeFileSync(destination,bytes);chmodSync(destination,entry.mode==="100755"?0o755:0o644);
 }
 if(diagramSourceSetup.some(path=>!seen.has(path))||diagramSourceDomains.some(name=>!seen.has(`packages/${name}/package.json`)))throw Error("Incomplete native diagram source archive");
 const workspaces=new Map(diagramSourceDomains.map(name=>[JSON.parse(readFileSync(join(target,"packages",name,"package.json"),"utf8")).name,name]));
 const modules=join(target,"node_modules");mkdirSync(modules);
 for(const entry of readdirSync(join(repo,"node_modules"))){
  if(entry.startsWith("."))continue;
  const names=entry.startsWith("@")?readdirSync(join(repo,"node_modules",entry)).map(child=>`${entry}/${child}`):[entry];
  for(const name of names){if(name.startsWith("@schlessera/")&&!workspaces.has(name))continue;const destination=join(modules,name);mkdirSync(dirname(destination),{recursive:true});symlinkSync(workspaces.has(name)?join(target,"packages",workspaces.get(name)):join(repo,"node_modules",name),destination,"dir");}
 }
 return target;
}
