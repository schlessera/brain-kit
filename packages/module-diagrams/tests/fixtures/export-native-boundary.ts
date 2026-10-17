/** Private three-export fixture boundary; ordinary CLI processes never load it. */
import assert from "node:assert/strict";
import {existsSync,lstatSync,readFileSync,realpathSync,writeFileSync} from "node:fs";
import {join,relative,resolve} from "node:path";
import {chromium} from "playwright";
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
 const root=process.env.BRAIN_ROOT!,temp=process.env.TMPDIR!,sourceRoot=resolve(import.meta.dir,"../../../..");
 assert(root&&temp&&root.startsWith(join(temp,"brain-test-")),"NATIVE_EXPORT_OWNED_ROOT");
 assert.equal(realpathSync(root),root,"NATIVE_EXPORT_CANONICAL_ROOT");assert(lstatSync(root).isDirectory());
 const home=process.env.HOME!;assert(home&&home.startsWith(join(temp,"brain-test-home-")),"NATIVE_EXPORT_OWNED_HOME");assert.equal(realpathSync(home),home);
 for(const [name,leaf]of Object.entries({CLAUDE_CONFIG_DIR:"claude",PI_CODING_AGENT_DIR:"pi",XDG_CONFIG_HOME:"config",XDG_CACHE_HOME:"cache",XDG_DATA_HOME:"data"}))assert.equal(process.env[name],join(home,leaf),"NATIVE_EXPORT_OWNED_CONFIG_ROOTS");
 const cache=join(home,"cache","ms-playwright"),localChrome=chromium.executablePath();
 assert(localChrome.startsWith(cache+"/"),"NATIVE_EXPORT_BROWSER_CACHE_ORIGIN");
 const chrome=join("/ms-playwright",relative(cache,localChrome));
 assert.equal(process.env.PUPPETEER_EXECUTABLE_PATH,chrome,"NATIVE_EXPORT_PINNED_CHROME");assert.equal(realpathSync(chrome),chrome);
 assert.equal(process.env.BRAIN_CHROME_NO_SANDBOX,format==="svg"?undefined:"1");
 assert.equal(readFileSync(join(root,"brain.config.ts"),"utf8"),config,"NATIVE_EXPORT_LITERAL_CONFIG");
 assert(!existsSync(join(root,"settings")),"NATIVE_EXPORT_NO_SETTINGS_OVERRIDE");
 assert.equal(realpathSync(join(root,"node_modules")),realpathSync(join(sourceRoot,"node_modules")),"NATIVE_EXPORT_OWNED_RESOLUTION_ROOT");
 for(const [name,packageName]of Object.entries({common:"@schlessera/brain-common",core:"@schlessera/brain",geo:"@schlessera/brain-geo","module-diagrams":"@schlessera/brain-module-diagrams","render-template":"@schlessera/brain-render-template","ui-render-puppeteer":"@schlessera/brain-render-puppeteer"})){
  const packageRoot=join(sourceRoot,"packages",name),manifest=JSON.parse(readFileSync(join(packageRoot,"package.json"),"utf8"));
  assert.equal(manifest.name,packageName,"NATIVE_EXPORT_FIXED_WORKSPACE_NAMES");
  const resolved=realpathSync(Bun.resolveSync(packageName+(name==="common"?"/internal/env":""),root));
  assert(resolved.startsWith(packageRoot+"/"),"NATIVE_EXPORT_OWNED_WORKSPACE_RESOLUTION");
 }
 for(const name of ["BRAIN_WORKER_DATA_ROOT","BRAIN_WORKER_CONFIG_ROOT","BUN_OPTIONS","NODE_OPTIONS","BUN_BIN","BRAIN_UI_CHROME_NO_SANDBOX","PLAYWRIGHT_BROWSERS_PATH"])
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
