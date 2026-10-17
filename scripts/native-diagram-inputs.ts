/** One fixed mount-bound native SVG/PNG/PDF operation; drift keeps fresh proof. */
import {createHash} from "node:crypto";
import {existsSync,lstatSync,readFileSync,readdirSync,realpathSync} from "node:fs";
import {resolve} from "node:path";
import {diagramSourceDomains,diagramSourceSetup,diagramSourceIdentity} from "./diagram-export-source.mjs";
import {diagramInstallationIdentity} from "./diagram-export-installation.mjs";
import {diagramProducerRuntime} from "./diagram-export-producer.mjs";
import type {BrowserImporters} from "./bound-browser-runtime-inputs";
export interface NativeDiagramIdentity {source:string;installation:string;runtime:string;}
export interface NativeDiagramDiagnostic {
 version:1;status:string;stage:string;expected:{source:string;installation:string};
 actual?:Partial<NativeDiagramIdentity>;sourceInputs?:number;
 installation?:{packages:number;files:number;bytes:number};
 pins?:{path:string;expected:string;actual?:string;owned:boolean}[];errorCode?:string;
}

// Candidate qualification is exact: all source/installation drift requires fresh
// execution and requalification. The separate Docker mount boundary closes
// active initialization/shared-library reads; byte hashes alone do not.
const qualified:Omit<NativeDiagramIdentity,"runtime">={source:"44f1c61f08273808da03fc7735f70612d66e232d4c69442a14cb85b74ac7cfde",installation:"2357aba0ba81c9d7e91f5906708c13a9c5f71c931f70022a078100c60b496f05"};
const caller="packages/ui-kit/vitest.config.ts",owner="packages/ui-react/tests/browser/diagram-export-command.ts";
const sourcePins:Record<string,string>={
  "packages/ui-kit/vitest.config.ts": "e724696a55955e9f32d396b2031214600086533c3f9b8baabcc1c6bb7311f1db",
  "packages/ui-react/tests/browser/diagram-export-command.ts": "f7c3d14ccf96438bf4e28ecc1929b1208fb99520d21a9947086bb43bca933328",
  "scripts/ci-proof.ts": "121509cca05420dcf6ffed2b4fc245c1a16409d5efbf5f299f506d81d053f7d1"
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
export function nativeDiagramInputs(root:string,files:readonly string[],importers:BrowserImporters,observe?:(value:NativeDiagramDiagnostic)=>void){
 const diagnostic:NativeDiagramDiagnostic={version:1,status:"unavailable",stage:"role",expected:{...qualified}};
 const report=()=>observe?.(diagnostic);
 if(![caller,owner].every(path=>files.includes(path)))return;
 if(!qualified.source||!qualified.installation||[...(importers.get(owner)??[])].some(path=>path!==caller)){diagnostic.status="unsealed-role";report();return;}
 try{
  diagnostic.stage="pins";
  diagnostic.pins=Object.entries(sourcePins).map(([path,expected])=>{const absolute=resolve(root,path),owned=existsSync(absolute)&&realpathSync(absolute)===absolute;return{path,expected,owned,...(owned?{actual:createHash("sha256").update(readFileSync(absolute)).digest("hex")}:{} )};});
  if(diagnostic.pins.some(pin=>!pin.owned||pin.actual!==pin.expected)){diagnostic.status="source-pin-mismatch";report();return;}
  diagnostic.stage="source";const source=nativeDiagramSourceInventory(root);diagnostic.actual={source:source.sha256};diagnostic.sourceInputs=source.inputs.length;
  diagnostic.stage="installation";const installation=diagramInstallationIdentity(root);diagnostic.actual.installation=installation.sha256;diagnostic.installation={packages:installation.packages,files:installation.files,bytes:installation.bytes};
  diagnostic.stage="runtime";const runtime=diagramProducerRuntime();diagnostic.actual.runtime=runtime.sha256;
  if(source.sha256!==qualified.source||installation.sha256!==qualified.installation){diagnostic.status=source.sha256!==qualified.source?"source-mismatch":"installation-mismatch";report();return;}
  const sites=new Map<string,Set<string>>([
   [owner,new Set([
    "readFileSync(resolve(prepared,\"producer.json\"),\"utf8\")",
    "readFileSync(resolve(prepared,name))",
    "readFileSync(resolve(directory,\"release.svg\"),\"utf8\")",
    "readFileSync(resolve(directory,\"release.png\"))",
    "page.setContent(`<!doctype html><html><head><meta charset=\"utf-8\"><style>html,body{margin:0}svg{display:block}</style></head><body>${svg}</body></html>`)"
])],
   ["scripts/diagram-export-producer.mjs",new Set([
    "accessSync(path,constants.X_OK)",
    "statSync(path)",
    "readFileSync(executable)",
    "readFileSync(join(repo,\"tmp/diagram-export-source.json\"),\"utf8\")",
    "readdirSync(join(repo,\"node_modules\"))",
    "readdirSync(join(repo,\"node_modules\",top))",
    "spawnSync(\"docker\",[\"run\",\"--rm\",\"--pull=never\",\"--read-only\",\"--network=none\",\"--shm-size=256m\",\"--user\",`${process.getuid()}:${process.getgid()}`,\"--tmpfs\",\"/tmp:rw,exec,nosuid,nodev,mode=1777\",\"-v\",`${source}:${source}:ro`,\"-v\",`${modules}:${join(repo,\"node_modules\")}:ro`,\"-v\",`${executable}:/usr/local/bin/bun:ro`,\"-v\",`${output}:/proof`,\"-w\",source,\"-e\",\"HOME=/tmp/home\",runtime.image,\"/usr/local/bin/bun\",\"-e\",program],{encoding:\"utf8\",maxBuffer:4*1024*1024})",
    "readFileSync(join(output,name))"
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
  diagnostic.status="qualified";diagnostic.stage="complete";report();
  return{identity:{source:source.sha256,installation:installation.sha256,runtime:runtime.sha256},files:source.inputs.map(entry=>entry.path),sites};
 }catch(error){
  const safeMessages=["Unsupported native dependency alias","Unbounded native dependency inventory","Unsupported native dependency entry","Unbounded native dependency packages","NATIVE_DEPENDENCY_ORIGIN_CHANGED","Unsupported native dependency identity"];
  const message=error instanceof Error?error.message:"";
  diagnostic.errorCode=safeMessages.includes(message)?message.replaceAll(" ","_").toUpperCase():"UNAVAILABLE";report();return;
 }
}
