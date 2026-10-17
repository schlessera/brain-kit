import { expect,test } from "bun:test";
import { readFileSync,writeFileSync } from "node:fs";
import { join } from "node:path";
import { makeTempBrain,cleanup,runCli } from "../../core/tests/cli-harness.js";
const source=readFileSync(new URL("../skills/diagram/references/examples/sequence.diagram.yaml",import.meta.url),"utf8");
function configure(root:string){writeFileSync(join(root,"brain.config.ts"),'import {defineConfig} from "@schlessera/brain";export default defineConfig({modules:{"@schlessera/brain-module-diagrams":{}}});\n');}
test("real diagram export writes a flattened chosen-theme SVG and pinned envelope",async()=>{const root=makeTempBrain({empty:true});try{configure(root);writeFileSync(join(root,"release.diagram.yaml"),source);const result=await runCli(root,["diagram","export","release.diagram.yaml","--theme","dark","--format","svg","--json"]);expect(result.code,result.stderr+result.stdout).toBe(0);const output=JSON.parse(result.stdout);expect(output.ok).toBe(true);expect(output.output).toBe("release.dark.svg");const svg=readFileSync(join(root,output.output),"utf8");expect(output).toEqual({schema_version:1,ok:true,input:"release.diagram.yaml",output:"release.dark.svg",format:"svg",theme:"dark",bytes:Buffer.byteLength(svg),warnings:[],errors:[]});expect(svg).not.toContain("var(");expect(svg).toContain('data-theme="dark"');}finally{cleanup(root);}});

import { existsSync,symlinkSync } from "node:fs";
import { createHash } from "node:crypto";
import { flattenPaint,toFlatSvg } from "../src/flatten.js";
const identified=()=>({...JSON.parse(source),id:"release"});
const fence=(value=identified())=>'```diagram\n'+JSON.stringify(value)+'\n```\n';
const markdown=(body:string)=>'---\ntitle: Release order\ntype: note\nupdated: 2026-07-12\n---\n\n'+body;
const categories=(stdout:string)=>JSON.parse(stdout).issues.filter((issue:{category:string})=>issue.category.startsWith("diagram-"));
async function command(root:string,args:string[]){const result=await runCli(root,args);return {...result,value:JSON.parse(result.stdout)};}
test("build pins complete pairs and exact fence identity, preserving Markdown",async()=>{
 const root=makeTempBrain({empty:true});try{configure(root);const content=markdown('The order travels from Olympus.\n\n'+fence());writeFileSync(join(root,"dispatch.md"),content);
 const built=await command(root,["diagram","build","dispatch.md","--json"]);expect(built.code,built.stderr).toBe(0);const hash=createHash("sha256").update(JSON.stringify(identified())).digest("hex");expect(built.value).toEqual({schema_version:1,ok:true,input:"dispatch.md",figures:[{id:"release",light:"release.light.svg",dark:"release.dark.svg",picture:'<picture><source media="(prefers-color-scheme: dark)" srcset="release.dark.svg"><img src="release.light.svg" alt="The release order reaches Odysseus on 2026-07-12."></picture>',source_sha256:hash}],written:["release.light.svg","release.dark.svg"],warnings:[],errors:[]});expect(readFileSync(join(root,"dispatch.md"),"utf8")).toBe(content);
 const indexed=await runCli(root,["index","--force"]);expect(indexed.code,indexed.stderr).toBe(0);expect(categories((await runCli(root,["audit","--json"])).stdout)).toEqual([]);
 writeFileSync(join(root,"dispatch.md"),markdown('An unrelated prose edit.\n\n'+fence()));expect(categories((await runCli(root,["audit","--json"])).stdout)).toEqual([]);
 const changed=identified();changed.title="The revised release order";writeFileSync(join(root,"dispatch.md"),markdown(fence(changed)));const stale=categories((await runCli(root,["audit","--json"])).stdout);expect(stale.map((x:{category:string})=>x.category)).toEqual(["diagram-stale"]);
 const rebuilt=await runCli(root,["diagram","build","dispatch.md","--json"]);expect(rebuilt.code,rebuilt.stderr).toBe(0);expect(categories((await runCli(root,["audit","--json"])).stdout)).toEqual([]);
 }finally{cleanup(root);}
});
test("real two-source collision refuses another Markdown file's derived pair before writes",async()=>{
 const root=makeTempBrain({empty:true});try{configure(root);writeFileSync(join(root,"first.md"),fence());writeFileSync(join(root,"second.md"),fence());const first=await command(root,["diagram","build","first.md","--json"]);expect(first.code,first.stderr).toBe(0);const before=readFileSync(join(root,"release.light.svg"),"utf8");const other=await command(root,["diagram","build","second.md","--json"]);expect(other.code).toBe(1);expect(other.value.figures).toEqual([]);expect(other.value.written).toEqual([]);expect(other.value.errors[0].message).toContain("unrelated SVG");expect(readFileSync(join(root,"release.light.svg"),"utf8")).toBe(before);
 }finally{cleanup(root);}
});
test("unsafe outputs, duplicate IDs, unrelated files and symlink parents cannot overwrite sources",async()=>{
 const root=makeTempBrain({empty:true}),outside=makeTempBrain({empty:true});try{configure(root);writeFileSync(join(root,"release.diagram.yaml"),source);symlinkSync(outside,join(root,"escape"),"dir");const escaped=await command(root,["diagram","export","release.diagram.yaml","--out","escape/result.svg","--json"]);expect(escaped.code).toBe(1);expect(existsSync(join(outside,"result.svg"))).toBe(false);expect(escaped.value.output).toBeNull();
 writeFileSync(join(root,"dispatch.md"),fence()+fence());const duplicate=await command(root,["diagram","build","dispatch.md","--json"]);expect(duplicate.code).toBe(1);expect(duplicate.value.errors[0].code).toBe("duplicate_id");expect(duplicate.value.written).toEqual([]);
 writeFileSync(join(root,"dispatch.md"),fence());writeFileSync(join(root,"release.dark.svg"),"A manually authored drawing");const manual=await command(root,["diagram","build","dispatch.md","--json"]);expect(manual.code).toBe(1);expect(manual.value.written).toEqual([]);expect(existsSync(join(root,"release.light.svg"))).toBe(false);expect(readFileSync(join(root,"release.dark.svg"),"utf8")).toBe("A manually authored drawing");
 }finally{cleanup(root);cleanup(outside);}
});
test("absent and dormant diagrams modules report actual fences without loading absent code",async()=>{
 const root=makeTempBrain({empty:true});try{writeFileSync(join(root,"brain.config.ts"),'import {defineConfig} from "@schlessera/brain";export default defineConfig({});\n');writeFileSync(join(root,"dispatch.md"),markdown(fence()));writeFileSync(join(root,"example.md"),markdown('```markdown\n```diagram\nnot a real diagram\n```\n```\n'));const indexed=await runCli(root,["index","--force"]);expect(indexed.code,indexed.stderr).toBe(0);const absent=categories((await runCli(root,["audit","--json"])).stdout);expect(absent.map((x:{category:string;path:string})=>[x.category,x.path])).toEqual([["diagram-module","dispatch.md"]]);
 configure(root);expect(categories((await runCli(root,["audit","--json"])).stdout)).toEqual([]);const disabled=await runCli(root,["module","disable","diagrams"]);expect(disabled.code,disabled.stderr).toBe(0);expect(categories((await runCli(root,["audit","--json"])).stdout).map((x:{category:string})=>x.category)).toContain("diagram-module");
 }finally{cleanup(root);}
});
test("enabled hygiene reports invalid fresh specs and sees old documents beyond the list query cap",async()=>{
 const root=makeTempBrain({empty:true});try{configure(root);for(let i=0;i<105;i++)writeFileSync(join(root,`note-${i}.md`),markdown("A voyage note."));writeFileSync(join(root,"dispatch.md"),markdown(fence()));expect((await runCli(root,["index","--force"])).code).toBe(0);writeFileSync(join(root,"dispatch.md"),markdown('```diagram\nschema_version: 1\ntype: unknown\n```\n'));expect(categories((await runCli(root,["audit","--json"])).stdout).some((x:{category:string;path:string})=>x.category==="diagram-invalid"&&x.path==="dispatch.md")).toBe(true);
 }finally{cleanup(root);}
});
test("flattening preserves literal source text and resolves opaque generated mix steps",()=>{
 const spec=identified();spec.desc="A literal var(--bk-example) is part of the description.";const svg=toFlatSvg(JSON.stringify(spec),"dark");expect(svg).not.toContain("var(");expect(svg).toContain("var&#40;--bk-example)");expect(flattenPaint("color-mix(in srgb, var(--bk-diagram-text) 25%, var(--bk-diagram-bg))","print")).toMatch(/^rgb\(/);expect(()=>flattenPaint("var(--bk-unknown)","light")).toThrow("Unknown generated paint");
});

import { keylessEnv } from "../../core/tests/cli-harness.js";
async function failureProbe(mode:string,root:string){
 const child=Bun.spawn([process.execPath,"--preload",new URL("../../../scripts/test-network-child-preload.ts",import.meta.url).pathname,new URL("./fixtures/artifact-failure-probe.ts",import.meta.url).pathname,mode,root],{env:{...keylessEnv(root),BRAIN_UI_CHROME_NO_SANDBOX:"1"},stdout:"pipe",stderr:"pipe"});
 const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);expect(code,stderr).toBe(0);return JSON.parse(stdout);
}
test("partial build reports only the artifact actually written",async()=>{
 const root=makeTempBrain({empty:true});try{writeFileSync(join(root,"dispatch.md"),fence());const result=await failureProbe("partial",root);expect(result.ok).toBe(false);expect(result.written).toEqual(["release.light.svg"]);expect(result.figures).toEqual([]);expect(result.errors[0].message).toBe("Controlled second artifact write failure");expect(existsSync(join(root,"release.light.svg"))).toBe(true);expect(existsSync(join(root,"release.dark.svg"))).toBe(false);}finally{cleanup(root);}
});
test("optional offline renderer shuts down after render failure and propagates shutdown failure",async()=>{
 const root=makeTempBrain({empty:true});try{for(const mode of ["render","shutdown"]){const result=await failureProbe(mode,root);expect(result.calls[0]).toEqual({noSandbox:true,allowHosts:[],maxConcurrent:1,idleTimeoutMs:5000});expect(result.calls.at(-1)).toBe("shutdown");expect(result.message).toContain(mode==="render"?"Controlled render failure":"Controlled shutdown failure");}}finally{cleanup(root);}
});
test("build preserves valid fence warnings with source locations",async()=>{const root=makeTempBrain({empty:true});try{configure(root);const spec=identified();spec.edges=[{from:"zeus",to:"hermes",label:"A very long arrow label"}];writeFileSync(join(root,"dispatch.md"),fence(spec));const built=await command(root,["diagram","build","dispatch.md","--json"]);expect(built.code,built.stderr).toBe(0);expect(built.value.warnings.length).toBeGreaterThan(0);expect(built.value.warnings[0].path).toMatch(/^dispatch\.md:1:\$/);expect(built.value.figures).toHaveLength(1);}finally{cleanup(root);}});
import {BRAIN_BIN} from "../../core/tests/cli-harness.js";
test("stdin export writes a safe ignored artifact and usage errors keep the pinned envelope",async()=>{
 const root=makeTempBrain({empty:true});try{configure(root);writeFileSync(join(root,".gitignore"),".brain/scratch/\n");const child=Bun.spawn([process.execPath,BRAIN_BIN,"diagram","export","-","--json"],{env:keylessEnv(root),stdin:new TextEncoder().encode(source),stdout:"pipe",stderr:"pipe"});const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);expect(code,stderr).toBe(0);const result=JSON.parse(stdout);expect(result.input).toBe("-");expect(result.output).toMatch(/^\.brain\/scratch\/diagram-print-.*\.svg$/);expect(readFileSync(join(root,result.output),"utf8")).not.toContain("var(");const invalid=await command(root,["diagram","export","-","--theme","unknown","--json"]);expect(invalid.code).toBe(1);expect(invalid.value).toEqual({schema_version:1,ok:false,input:"-",output:null,format:"svg",theme:"print",bytes:0,warnings:[],errors:[{code:"export",path:"$",message:"Unknown diagram theme or artifact format"}]});}finally{cleanup(root);}
});
import {diagramFontCss,embedDiagramFonts} from "../src/fonts.js";
test("shipped normal export faces and notices match the existing locked assets",()=>{
 const lock=JSON.parse(readFileSync(new URL("../../../scripts/captures/font-lock.json",import.meta.url),"utf8"));for(const number of [2,4,6,7]){const bytes=readFileSync(new URL(`../assets/fonts/${number}.ttf`,import.meta.url));expect(createHash("sha256").update(bytes).digest("hex")).toBe(lock.assets[number].sha256);}for(const license of lock.licenses.filter((license:{file:string})=>!license.file.includes("dmserif"))){const bytes=readFileSync(new URL(`../assets/${license.file}`,import.meta.url));expect(createHash("sha256").update(bytes).digest("hex")).toBe(license.sha256);}const css=diagramFontCss();expect(css.match(/@font-face/g)).toHaveLength(4);expect(css).not.toMatch(/https?:|file:/);expect(embedDiagramFonts("<svg></svg>")).toContain("data:font/ttf;base64,");
});
test("unsafe derived entries report stale without following either external symlink",async()=>{
 const root=makeTempBrain({empty:true}),outside=makeTempBrain({empty:true});try{configure(root);writeFileSync(join(root,"dispatch.md"),markdown(fence()));expect((await runCli(root,["index","--force"])).code).toBe(0);writeFileSync(join(outside,"drawing.svg"),"Outside content must not be read");for(const theme of ["light","dark"])symlinkSync(join(outside,"drawing.svg"),join(root,`release.${theme}.svg`));const issues=categories((await runCli(root,["audit","--json"])).stdout);expect(issues.map((issue:{category:string})=>issue.category),"UNSAFE_PAIR_MUST_NOT_LOOK_ABSENT").toEqual(["diagram-stale"]);expect(readFileSync(join(outside,"drawing.svg"),"utf8")).toBe("Outside content must not be read");}finally{cleanup(root);cleanup(outside);}
});
import {unlinkSync,mkdirSync,rmdirSync} from "node:fs";
async function boundedAudit(root:string){const child=Bun.spawn([process.execPath,BRAIN_BIN,"audit","--json"],{env:keylessEnv(root),stdout:"pipe",stderr:"pipe"});let killed=false;const timer=setTimeout(()=>{killed=true;child.kill();},5000);try{const [stdout,stderr,code]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);expect(killed,"NONREGULAR_DIAGRAM_INSPECTION_MUST_NOT_BLOCK").toBe(false);expect(code,stderr).toBe(0);return categories(stdout);}finally{clearTimeout(timer);}}
test("FIFO and directory leaves cannot block diagram source or derived inspection",async()=>{
 const root=makeTempBrain({empty:true});try{configure(root);writeFileSync(join(root,"dispatch.md"),markdown(fence()));expect((await runCli(root,["index","--force"])).code).toBe(0);const fifo=(path:string)=>{const result=Bun.spawnSync([Bun.which("mkfifo")!,path],{stdout:"pipe",stderr:"pipe"});expect(result.exitCode,new TextDecoder().decode(result.stderr)).toBe(0);};
 fifo(join(root,"release.light.svg"));fifo(join(root,"release.dark.svg"));expect((await boundedAudit(root)).map((issue:{category:string})=>issue.category)).toEqual(["diagram-stale"]);
 unlinkSync(join(root,"release.light.svg"));unlinkSync(join(root,"release.dark.svg"));for(const theme of ["light","dark"])mkdirSync(join(root,`release.${theme}.svg`));expect((await boundedAudit(root)).map((issue:{category:string})=>issue.category)).toEqual(["diagram-stale"]);for(const theme of ["light","dark"])rmdirSync(join(root,`release.${theme}.svg`));unlinkSync(join(root,"dispatch.md"));fifo(join(root,"dispatch.md"));expect((await boundedAudit(root)).map((issue:{category:string})=>issue.category)).toEqual(["diagram-source"]);
 writeFileSync(join(root,"brain.config.ts"),'import {defineConfig} from "@schlessera/brain";export default defineConfig({});\n');expect((await boundedAudit(root)).map((issue:{category:string})=>issue.category)).toEqual(["diagram-source"]);
 }finally{cleanup(root);}
});
