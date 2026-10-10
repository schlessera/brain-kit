/** Exact transitive public source and installed runtime identity; never credential data. */
import { readFileSync, readdirSync, realpathSync, lstatSync, readlinkSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { bundledClaudeBinary } from "../../../packages/core/src/providers/agents/claude-binary";
import { hash, protocol, protocolSha } from "./protocol";
import { researchSdkEntry } from "./native-runtime";
export const source = realpathSync(new URL("../../../", import.meta.url).pathname);
import {hashFrozenFile} from "./frozen-file";
export {hashFrozenFile} from "./frozen-file";
/** Whole owned dependency/workspace identity; no symlink escapes or local paths. */
export function closureTree(root:string,independent=false){
  const entries:Record<string,unknown>={};
  function visit(path:string,relativePath:string){
    const stat=lstatSync(path,{bigint:true}),mode=Number(stat.mode&0o7777n);
    if(stat.isSymbolicLink()){
      const target=realpathSync(path),resolved=relative(source,target).replaceAll("\\","/");
      if(resolved===".."||resolved.startsWith("../"))throw Error("Dependency/source symlink leaves the owned runtime");
      const targetStat=lstatSync(target);
      entries[relativePath]={kind:"symlink",mode,literalTargetSha:hash(readlinkSync(path)),resolved,
        targetKind:targetStat.isDirectory()?"directory":targetStat.isFile()?"file":"unsupported",
        ...(targetStat.isFile()?{targetSha:hashFrozenFile(target)}: {})};
      if(!targetStat.isDirectory()&&!targetStat.isFile())throw Error("Unsupported runtime symlink target");
      return;
    }
    if(stat.isDirectory()){
      entries[relativePath]={kind:"directory",mode};
      for(const name of readdirSync(path).sort())visit(join(path,name),relativePath?`${relativePath}/${name}`:name);
    }else if(stat.isFile()){
      if(independent&&stat.nlink!==1n)throw Error("Installed dependency shares a mutable regular inode; copy independent bytes before freezing");
      entries[relativePath]={kind:"file",mode,bytes:Number(stat.size),sha:hashFrozenFile(path,stat)};
    }
    else throw Error("Unsupported installed dependency/source member");
  }
  visit(root,"");return entries;
}
export function sourceFreeze() {
  const files: Record<string,string> = {},sourceMetadata:Record<string,{mode:number;bytes:number}>={};
  function add(path:string){const full=join(source,path),stat=lstatSync(full);if(!stat.isFile()||stat.isSymbolicLink())throw Error("Frozen source is not a regular file");files[path]=hashFrozenFile(full);sourceMetadata[path]={mode:stat.mode&0o7777,bytes:stat.size};}
  function tree(path:string){for(const item of readdirSync(join(source,path),{withFileTypes:true}).sort((a,b)=>a.name<b.name?-1:a.name>b.name?1:0)){
    const next=`${path}/${item.name}`;if(item.isSymbolicLink())throw Error(`Transitive source symlink refused: ${next}`);
    if(item.isDirectory())tree(next);else if(item.isFile()&&/\.(?:ts|json|md)$/.test(item.name))add(next);
  }}
  tree("packages/core/src");tree("packages/core/skills/content-hygiene");tree("scripts/evals/mechanical-hygiene");
  for(const path of ["scripts/evals/native-paid-policy.ts","tests/native-paid-policy.test.ts","tests/native-grant.test.ts","scripts/evals/native-grant.ts","scripts/evals/native-pricing.ts"])add(path);
  for(const path of ["bun.lock","package.json","packages/core/package.json","packages/ui-backend-claude/package.json","packages/ui-backend-claude/src/subscription.ts","scripts/measure-sonnet55-cost.ts","docs/decisions/example-corpus.md","packages/ui-kit/fixtures/README.md","docs/decisions/hygiene-review.md","docs/mechanical-hygiene-investigation.md"])add(path);
  for(const path of readdirSync(join(source,"tests")).filter(p=>p.startsWith("mechanical-hygiene")&&p.endsWith(".ts")))add(`tests/${path}`);
  const sdk=researchSdkEntry(source);
  const packageRaw=readFileSync(join(dirname(sdk),"package.json"));const version=JSON.parse(packageRaw.toString()).version;
  const native=bundledClaudeBinary(sdk);if(!native)throw Error("Installed native runtime absent");
  if(version!==protocol.nativeRuntime.sdk||Bun.version!==protocol.nativeRuntime.bun)throw Error("Installed runtime differs from exact research protocol");
  const dependencies=closureTree(join(source,"node_modules"),true);
  const workspaceTrees=Object.fromEntries(readdirSync(join(source,"packages")).sort().map(name=>{
    const entries=closureTree(join(source,"packages",name,"src"));
    const manifest=join(source,"packages",name,"package.json");
    return[name,{entries:Object.keys(entries).length,treeSha:hash(JSON.stringify(entries)),manifestSha:hashFrozenFile(manifest),manifestMode:lstatSync(manifest).mode&0o7777}];
  }));
  const dependencyClosure={entries:Object.keys(dependencies).length,files:Object.values(dependencies).filter((entry:any)=>entry.kind==="file").length,links:Object.values(dependencies).filter((entry:any)=>entry.kind==="symlink").length,treeSha:hash(JSON.stringify(dependencies))};
  const runtime={sdk:version,sdkEntrySha:hashFrozenFile(sdk),sdkPackageSha:hash(packageRaw),
    nativePackage:relative(dirname(sdk),native).replaceAll("\\","/"),nativeSha:hashFrozenFile(native),expectedCli:protocol.nativeRuntime.cli,
    bun:Bun.version,bunSha:hashFrozenFile(process.execPath)};
  const manifest={protocol,protocolSha,files,sourceMetadata,workspaceTrees,dependencyClosure,runtime};return{...manifest,freezeSha:hash(JSON.stringify(manifest))};
}
