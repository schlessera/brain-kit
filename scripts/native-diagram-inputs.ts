/** One fixed native SVG/PNG/PDF operation; drift keeps complete fresh proof. */
import {createHash} from "node:crypto";
import {existsSync,lstatSync,readFileSync,readdirSync,realpathSync} from "node:fs";
import {join,resolve} from "node:path";
import {diagramSourceDomains,diagramSourceSetup,diagramSourceIdentity} from "./diagram-export-source.mjs";
import {diagramInstallationIdentity} from "./diagram-export-installation.mjs";
import type {BrowserImporters} from "./bound-browser-runtime-inputs";
export interface NativeDiagramIdentity {source:string;installation:string;}
// Candidate qualification is exact: all source/installation drift requires fresh
// execution and requalification; generated roots never select existing data.
const qualified:NativeDiagramIdentity={source:"44f113e83e053361071d2bd10aff6b340c88c126f685c200ce27b57969e1e947",installation:"2357aba0ba81c9d7e91f5906708c13a9c5f71c931f70022a078100c60b496f05"};
const caller="packages/ui-kit/vitest.config.ts",owner="packages/ui-react/tests/browser/diagram-export-command.ts";
const sourcePins:Record<string,string>={
  "packages/ui-kit/vitest.config.ts": "e724696a55955e9f32d396b2031214600086533c3f9b8baabcc1c6bb7311f1db",
  "packages/ui-react/tests/browser/diagram-export-command.ts": "f65c2316973e5e6ee276deda2f02a2b81d22e28ded653f9b1703108dba51db37",
  "scripts/ci-proof.ts": "9107b355e0402ebdb2f3a8bc737b1cb803a56dc9cc03c0601f5e365e9030219b"
};
/** The same complete source family the trusted host preparer enumerates. */
export function nativeDiagramSourceInventory(root:string){
 const inputs:{path:string;mode:string;sha256:string}[]=[];
 const read=(path:string)=>{const absolute=resolve(root,path),stat=lstatSync(absolute);
  if(realpathSync(absolute)!==absolute||stat.isSymbolicLink())throw Error("Unsupported native source alias");
  if(stat.isDirectory()){for(const entry of readdirSync(absolute).sort())read(`${path}/${entry}`);}
  else if(stat.isFile())inputs.push({path,mode:stat.mode&0o111?"100755":"100644",sha256:createHash("sha256").update(readFileSync(absolute)).digest("hex")});
  else throw Error("Unsupported native source entry");};
 for(const file of diagramSourceSetup)read(file);
 for(const domain of diagramSourceDomains)read(`packages/${domain}`);
 return{inputs,sha256:diagramSourceIdentity(inputs)};
}
/** Input identity supplements the existing complete fresh-shard receipt. */
export function nativeDiagramInputs(root:string,files:readonly string[],importers:BrowserImporters){
 if(!qualified.source||!qualified.installation||![caller,owner].every(path=>files.includes(path))||[...(importers.get(owner)??[])].some(path=>path!==caller))return;
 try{
  for(const[path,hash]of Object.entries(sourcePins)){const absolute=resolve(root,path);if(!existsSync(absolute)||realpathSync(absolute)!==absolute||createHash("sha256").update(readFileSync(absolute)).digest("hex")!==hash)return;}
  const source=nativeDiagramSourceInventory(root),installation=diagramInstallationIdentity(root);
  if(source.sha256!==qualified.source||installation.sha256!==qualified.installation)return;
  const sites=new Map<string,Set<string>>([
   [owner,new Set([
    'readFileSync(resolve(directory,"release.svg"),"utf8")','readFileSync(resolve(directory,"release.png"))',
    'page.setContent(`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0}svg{display:block}</style></head><body>${svg}</body></html>`)',
    'spawn("/usr/local/bin/bun",["--preload",resolve(producer,"scripts/test-network-child-preload.ts"),"--preload",resolve(producer,"packages/module-diagrams/tests/fixtures/export-native-boundary.ts"),resolve(producer,"packages/module-diagrams/tests/fixtures/export-artifact-probe.ts"),directory],{cwd:producer,env:{PATH:"/usr/local/bin:/usr/bin:/bin",LANG:"C.UTF-8",TZ:"UTC",HOME:home,TMPDIR:temp,PUPPETEER_EXECUTABLE_PATH:chromium.executablePath()},stdio:["ignore","pipe","pipe"]})'
   ])],
   ["scripts/diagram-export-source.mjs",new Set([
    'readFileSync(archivePath(repo))','existsSync(target)','lstatSync(source)','readFileSync(source)',
    'readFileSync(join(target,"packages",name,"package.json"),"utf8")','existsSync(installed)',
    'readdirSync(join(repo,"node_modules"))','readdirSync(join(repo,"node_modules",entry))'
   ])],
   ["scripts/diagram-export-installation.mjs",new Set([
    'lstatSync(absolute)','lstatSync(real)','readlinkSync(absolute)','readdirSync(absolute)','readFileSync(absolute)',
    'readdirSync(join(repo,"node_modules"))','readdirSync(join(repo,"node_modules",top))','readFileSync(join(base,"package.json"),"utf8")'
   ])]
  ]);
  return{identity:{source:source.sha256,installation:installation.sha256},files:source.inputs.map(entry=>entry.path),sites};
 }catch{return;}
}
