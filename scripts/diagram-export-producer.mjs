/** Host-only native producer: its children never inherit the browser's mounts. */
import {spawnSync} from "node:child_process";
import {createHash,randomUUID} from "node:crypto";
import {accessSync,closeSync,constants,cpSync,mkdirSync,mkdtempSync,openSync,readFileSync,readdirSync,realpathSync,renameSync,rmSync,statSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {delimiter,join,resolve} from "node:path";
import {materializeDiagramExportSource} from "./diagram-export-source.mjs";
import {diagramInstallationIdentity} from "./diagram-export-installation.mjs";
export const diagramProducerImage="mcr.microsoft.com/playwright:v1.63.0-noble";
// Qualified Linux x64 manifest reference: Docker launches this exact content.
export const diagramProducerImageIdentity="mcr.microsoft.com/playwright@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27";
const hash=bytes=>createHash("sha256").update(bytes).digest("hex");
export function diagramProducerRuntime(){
 const bun=(process.env.PATH??"").split(delimiter).map(dir=>resolve(dir,"bun")).find(path=>{try{accessSync(path,constants.X_OK);return statSync(path).isFile();}catch{return false;}});
 if(!bun)throw Error("Native diagram producer requires the installed Bun");
 const image=diagramProducerImageIdentity;
 const executable=realpathSync(bun),bytes=readFileSync(executable),identity={image,bun:hash(bytes)};
 return{...identity,executable,bytes,sha256:hash(Buffer.from(JSON.stringify(identity)))};
}
/** Private named volumes carry only audited inputs; no host path is mounted. */
export function diagramNativeDockerArgs(repo,source,runtime,volumes,container,program){
 return ["create","--name",container,"--pull=never","--read-only","--network=none","--shm-size=256m","--user",`${process.getuid()}:${process.getgid()}`,"--tmpfs","/tmp:rw,exec,nosuid,nodev,mode=1777",
  "--mount",`type=volume,source=${volumes.source},target=${source},readonly`,
  "--mount",`type=volume,source=${volumes.modules},target=${join(repo,"node_modules")},readonly`,
  "--mount",`type=volume,source=${volumes.output},target=/proof`,
  "--mount",`type=volume,source=${volumes.runtime},target=/native-runtime,readonly`,
  "-w",source,"-e","HOME=/tmp/home",runtime.image,"/native-runtime/bun","-e",program];
}
function dockerChecked(args,options={}){
 const result=spawnSync("docker",args,{encoding:"utf8",maxBuffer:4*1024*1024,...options});
 if(result.error||result.status!==0||result.signal)throw Error(`Native diagram Docker operation failed (${args[0]}): ${result.error??result.signal??result.status}\n${result.stderr}\n${result.stdout}`);
 return result;
}
function fillPrivateVolume(directory,volume,image,archive){
 const out=openSync(archive,"wx");
 try{const packed=spawnSync("tar",["-C",directory,"-cf","-","."],{stdio:["ignore",out,"pipe"],encoding:"utf8"});if(packed.error||packed.status!==0)throw Error(`Native diagram input archive failed: ${packed.error??packed.stderr}`);}finally{closeSync(out);}
 const input=openSync(archive,"r");
 try{dockerChecked(["run","--rm","--interactive","--pull=never","--network=none","--read-only","--mount",`type=volume,source=${volume},target=/inputs`,image,"tar","-xf","-","-C","/inputs"],{stdio:[input,"pipe","pipe"]});}finally{closeSync(input);}
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
 const state=mkdtempSync(join(tmpdir(),"odysseus-native-producer-")),ownedVolumes=[],ownedContainers=[];
 let failure,failed=false;const cleanup=[];
 const volume=label=>{const name=`brain-kit-native-${session}-${label}`;dockerChecked(["volume","create",name]);ownedVolumes.push(name);return name;};
 try{
  const runtimeInput=join(state,"runtime");mkdirSync(runtimeInput);
  const executable=join(runtimeInput,"bun");
  // Mount exactly the captured bytes identified by runtime.bun, rather than
  // rereading a host pathname after validation. The private file has no writer.
  writeFileSync(executable,runtime.bytes,{mode:0o755,flag:"wx"});
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
  const sourceVolume=volume("source"),modulesVolume=volume("modules"),runtimeVolume=volume("runtime");
  fillPrivateVolume(runtimeInput,runtimeVolume,runtime.image,join(state,"runtime.tar"));
  fillPrivateVolume(source,sourceVolume,runtime.image,join(state,"source.tar"));
  fillPrivateVolume(modules,modulesVolume,runtime.image,join(state,"modules.tar"));
  for(const engine of engines){
   const destination=join(base,engine);
   const output=join(state,`output-${engine}`);mkdirSync(output);
   const program=`import assert from "node:assert/strict";import {chromium} from "playwright";import {mkdirSync,existsSync} from "node:fs";assert(!existsSync(${JSON.stringify(join(repo,"README.md"))}),"NATIVE_PRODUCER_ORIGINAL_REPO_UNMOUNTED");assert(!existsSync(${JSON.stringify(canary)}),"NATIVE_PRODUCER_HOST_STATE_UNMOUNTED");mkdirSync("/tmp/home",{recursive:true});mkdirSync("/tmp/work");const child=Bun.spawn(["/native-runtime/bun","--preload",${JSON.stringify(join(source,"scripts/test-network-child-preload.ts"))},${JSON.stringify(join(source,"packages/module-diagrams/tests/fixtures/export-artifact-probe.ts"))},"/proof"],{cwd:${JSON.stringify(source)},env:{PATH:"/native-runtime:/usr/local/bin:/usr/bin:/bin",LANG:"C.UTF-8",TZ:"UTC",HOME:"/tmp/home",TMPDIR:"/tmp/work",PUPPETEER_EXECUTABLE_PATH:chromium.executablePath()},stdout:"inherit",stderr:"inherit"});process.exitCode=await child.exited;`;
   const outputVolume=volume(`output-${engine}`);
   fillPrivateVolume(output,outputVolume,runtime.image,join(state,`output-${engine}.tar`));
   const container=`brain-kit-native-${session}-${engine}`;
   dockerChecked(diagramNativeDockerArgs(repo,source,runtime,{source:sourceVolume,modules:modulesVolume,output:outputVolume,runtime:runtimeVolume},container,program));
   ownedContainers.push(container);
   const result=dockerChecked(["start","--attach",container]);
   const code=Number(dockerChecked(["inspect","--format","{{.State.ExitCode}}",container]).stdout.trim());
   if(code!==0)throw Error(`Native diagram producer failed (${code})\n${result.stderr}\n${result.stdout}`);
   dockerChecked(["cp",`${container}:/proof/.`,output]);
   const artifacts=JSON.parse(result.stdout),files=Object.fromEntries(["svg","png","pdf"].map(format=>{const name=`release.${format}`;return[name,hash(readFileSync(join(output,name)))];}));
   // Publish only after the actual three-format process and all descendants
   // have drained successfully. The browser never manufactures this receipt.
   writeFileSync(join(output,"producer.json"),JSON.stringify({version:1,session,engine,checkout:record.checkout,source:record.sourceIdentity,installation:record.installation.sha256,runtime:{image:runtime.image,bun:runtime.bun,sha256:runtime.sha256},artifacts,files}));
   const staged=mkdtempSync(join(base,"prepared-"));cpSync(output,staged,{recursive:true});renameSync(staged,destination);
  }
 }catch(error){failure=error;failed=true;}finally{
  for(const container of ownedContainers){const result=spawnSync("docker",["rm","--force",container],{encoding:"utf8"});if(result.status!==0&&!/No such container/.test(result.stderr??""))cleanup.push(Error(`Native diagram container cleanup failed: ${container}`));}
  for(const name of ownedVolumes){const result=spawnSync("docker",["volume","rm",name],{encoding:"utf8"});if(result.status!==0)cleanup.push(Error(`Native diagram volume cleanup failed: ${name}`));}
  try{rmSync(state,{recursive:true,force:true});}catch(error){cleanup.push(error);}
 }
 if(cleanup.length)throw new AggregateError([...(failed?[failure]:[]),...cleanup],"Native diagram owned-resource cleanup failed");
 if(failed)throw failure;
 return session;
}
