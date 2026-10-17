/** Host-only native producer: its children never inherit the browser's mounts. */
import {spawnSync} from "node:child_process";
import {createHash,randomUUID} from "node:crypto";
import {accessSync,constants,cpSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,statSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {delimiter,join,resolve} from "node:path";
import {materializeDiagramExportSource} from "./diagram-export-source.mjs";
import {diagramInstallationIdentity} from "./diagram-export-installation.mjs";
export const diagramProducerImage="mcr.microsoft.com/playwright:v1.63.0-noble";
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
export function diagramProducerRuntime(){
 const bun=(process.env.PATH??"").split(delimiter).map(dir=>resolve(dir,"bun")).find(path=>{try{accessSync(path,constants.X_OK);return statSync(path).isFile();}catch{return false;}});
 if(!bun)throw Error("Native diagram producer requires the installed Bun");
 const result=spawnSync("docker",["image","inspect","--format","{{.Id}}",diagramProducerImage],{encoding:"utf8"});
 const image=result.stdout?.trim();if(result.status!==0||!/^sha256:[0-9a-f]{64}$/.test(image??""))throw Error("Native diagram producer requires the existing pinned image");
 const executable=realpathSync(bun),identity={image,bun:hash(readFileSync(executable))};
 return{...identity,executable,sha256:hash(Buffer.from(JSON.stringify(identity)))};
}
/** The complete mounted data is private source + filtered installed packages.
 * Readonly image files and Bun are identified separately. /tmp and /dev/shm
 * are fresh container-owned filesystems, not mounts of host state. */
export function prepareDiagramNativeArtifacts(repo,projects,expected){
 const engines=[...new Set(projects.filter(name=>name.startsWith("diagrams-")).map(name=>name.slice("diagrams-".length)))];
 if(!engines.length)return;
 if(engines.some(name=>!["chromium","webkit"].includes(name)))throw Error("Unsupported native diagram engine");
 const record=JSON.parse(readFileSync(join(repo,"tmp/diagram-export-source.json"),"utf8")),runtime=diagramProducerRuntime();
 if(expected?.runtime&&expected.runtime!==runtime.sha256)throw Error("NATIVE_EXPORT_RUNTIME_CHANGED");
 const session=randomUUID(),base=join(repo,"tmp/diagram-export-native-prepared",session);mkdirSync(base,{recursive:true});
 const state=mkdtempSync(join(tmpdir(),"odysseus-native-producer-"));
 try{
  const canary=join(state,"ambient-canary");writeFileSync(canary,"Odysseus");
  const source=materializeDiagramExportSource(repo,state,undefined,expected),installed=join(state,"installation"),modules=join(installed,"node_modules");mkdirSync(modules,{recursive:true});
  // Copy external package directories only. Hidden package-manager state and
  // unrelated workspace aliases never enter the container's filesystem.
  for(const top of readdirSync(join(repo,"node_modules")).sort()){
   if(top.startsWith(".")||top==="@schlessera")continue;
   const names=top.startsWith("@")?readdirSync(join(repo,"node_modules",top)).sort().map(child=>`${top}/${child}`):[top];
   for(const name of names){const destination=join(modules,name);mkdirSync(resolve(destination,".."),{recursive:true});cpSync(realpathSync(join(repo,"node_modules",name)),destination,{recursive:true,dereference:false,verbatimSymlinks:true});}
  }
  if(JSON.stringify(diagramInstallationIdentity(installed))!==JSON.stringify(record.installation))throw Error("NATIVE_EXPORT_PRIVATE_INSTALL_CHANGED");
  for(const engine of engines){
   const destination=join(base,engine);
   const output=join(state,`output-${engine}`);mkdirSync(output);
   const program=`import assert from "node:assert/strict";import {chromium} from "playwright";import {mkdirSync,existsSync} from "node:fs";assert(!existsSync(${JSON.stringify(join(repo,"README.md"))}),"NATIVE_PRODUCER_ORIGINAL_REPO_UNMOUNTED");assert(!existsSync(${JSON.stringify(canary)}),"NATIVE_PRODUCER_HOST_STATE_UNMOUNTED");mkdirSync("/tmp/home",{recursive:true});mkdirSync("/tmp/work");const child=Bun.spawn(["/usr/local/bin/bun","--preload",${JSON.stringify(join(source,"scripts/test-network-child-preload.ts"))},${JSON.stringify(join(source,"packages/module-diagrams/tests/fixtures/export-artifact-probe.ts"))},"/proof"],{cwd:${JSON.stringify(source)},env:{PATH:"/usr/local/bin:/usr/bin:/bin",LANG:"C.UTF-8",TZ:"UTC",HOME:"/tmp/home",TMPDIR:"/tmp/work",PUPPETEER_EXECUTABLE_PATH:chromium.executablePath()},stdout:"inherit",stderr:"inherit"});process.exitCode=await child.exited;`;
   const result=spawnSync("docker",["run","--rm","--pull=never","--read-only","--network=none","--shm-size=256m","--user",`${process.getuid()}:${process.getgid()}`,"--tmpfs","/tmp:rw,exec,nosuid,nodev,mode=1777","-v",`${source}:${source}:ro`,"-v",`${modules}:${join(repo,"node_modules")}:ro`,"-v",`${runtime.executable}:/usr/local/bin/bun:ro`,"-v",`${output}:/proof`,"-w",source,"-e","HOME=/tmp/home",runtime.image,"/usr/local/bin/bun","-e",program],{encoding:"utf8",maxBuffer:4*1024*1024});
   if(result.error||result.status!==0||result.signal)throw Error(`Native diagram producer failed: ${result.error??result.signal??result.status}\n${result.stderr}\n${result.stdout}`);
   const artifacts=JSON.parse(result.stdout),files=Object.fromEntries(["svg","png","pdf"].map(format=>{const name=`release.${format}`;return[name,hash(readFileSync(join(output,name)))];}));
   // Publish only after the actual three-format process and all descendants
   // have drained successfully. The browser never manufactures this receipt.
   writeFileSync(join(output,"producer.json"),JSON.stringify({version:1,session,engine,checkout:record.checkout,source:record.sourceIdentity,installation:record.installation.sha256,runtime:{image:runtime.image,bun:runtime.bun,sha256:runtime.sha256},artifacts,files}));
   const staged=mkdtempSync(join(base,"prepared-"));cpSync(output,staged,{recursive:true});renameSync(staged,destination);
  }
 }finally{rmSync(state,{recursive:true,force:true});}
 return session;
}
