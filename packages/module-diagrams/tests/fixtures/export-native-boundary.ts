/** Private three-export fixture boundary; ordinary CLI processes never load it. */
import assert from "node:assert/strict";
import {existsSync,lstatSync,readFileSync,realpathSync,writeFileSync} from "node:fs";
import {join,resolve} from "node:path";
const entry=resolve(import.meta.dir,"../../../core/src/cli/brain.ts"),fixture=resolve(import.meta.dir,"export-artifact-probe.ts");
const formats=["svg","png","pdf"] as const;
const argv=(format:string)=>["diagram","export","release.diagram.yaml","--theme","print","--format",format,"--json"];
const config='import {defineConfig} from "@schlessera/brain";export default defineConfig({modules:{"@schlessera/brain-module-diagrams":{}}});';
const receipt=(root:string,format:string)=>join(root,`.native-export-${format}-boundary.json`);
export function assertNativeExportBoundary(root:string,format:string):void{
 const value=JSON.parse(readFileSync(receipt(root,format),"utf8"));
 assert.deepEqual(value,{version:1,argv:argv(format),coreAttempts:[]},"NATIVE_EXPORT_BOUNDARY_RECEIPT");
}
if(process.argv[1]===entry){
 const format=process.argv[8]!;
 assert(formats.includes(format as typeof formats[number]),"NATIVE_EXPORT_FIXED_FORMAT");
 assert.deepEqual(process.argv.slice(2),argv(format),"NATIVE_EXPORT_FIXED_ARGUMENTS");
 const root=process.env.BRAIN_ROOT!,temp=process.env.TMPDIR!;
 assert(root&&temp&&root.startsWith(join(temp,"brain-test-")),"NATIVE_EXPORT_OWNED_ROOT");
 assert.equal(realpathSync(root),root,"NATIVE_EXPORT_CANONICAL_ROOT");assert(lstatSync(root).isDirectory());
 assert.equal(readFileSync(join(root,"brain.config.ts"),"utf8"),config,"NATIVE_EXPORT_LITERAL_CONFIG");
 assert(!existsSync(join(root,"settings")),"NATIVE_EXPORT_NO_SETTINGS_OVERRIDE");
 for(const name of ["BRAIN_WORKER_DATA_ROOT","BRAIN_WORKER_CONFIG_ROOT","BUN_OPTIONS","NODE_OPTIONS","BUN_BIN"])
  assert.equal(process.env[name],undefined,`NATIVE_EXPORT_NO_${name}`);
 const attempts:string[]=[];
 const {CORE_COMMANDS}=await import("../../../core/src/cli/commands/index.js");
 // buildRegistry reads cmd.run after this preload. Exact source auditing also
 // checks aliases and early dispatch branches; shared library helpers keep
 // their ordinary behavior and initialization executes normally.
 for(const [name,command]of Object.entries(CORE_COMMANDS))Object.defineProperty(command,"run",{
  configurable:false,writable:false,value:async()=>{attempts.push(name);throw Error(`NATIVE_EXPORT_CORE_COMMAND_ACTIVATED: ${name}`);}
 });
 process.on("exit",()=>{
  if(attempts.length){console.error(`NATIVE_EXPORT_CORE_COMMAND_ACTIVATED: ${attempts.join(",")}`);process.exitCode=1;}
  else writeFileSync(receipt(root,format),JSON.stringify({version:1,argv:argv(format),coreAttempts:attempts}),{flag:"wx"});
 });
}else if(process.argv[1]===fixture){
 const native=Bun.spawn,guard=import.meta.path;
 Bun.spawn=((...args:unknown[])=>{
  const cmd=args[0];
  assert(Array.isArray(cmd)&&cmd[0]==="bun"&&cmd[1]===entry,"NATIVE_EXPORT_FIXED_CHILD_ENTRY");
  args[0]=[cmd[0],"--preload",guard,...cmd.slice(1)];
  return Reflect.apply(native,Bun,args);
 })as typeof Bun.spawn;
}
