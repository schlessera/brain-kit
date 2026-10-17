import { expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { makeTempBrain, runCli, cleanup } from "../../core/tests/cli-harness.js";

const fixture=()=>{const root=makeTempBrain({empty:true});writeFileSync(join(root,"brain.config.ts"),'import {defineConfig} from "@schlessera/brain";export default defineConfig({modules:{"@schlessera/brain-module-diagrams":{}}});\n');return root;};
test("enabled diagrams materializes its authoring skill and passes real module lint",async()=>{
 const root=fixture();try{
  const enabled=await runCli(root,["module","enable","diagrams","--json"]);expect(enabled.code,enabled.stderr).toBe(0);
  const skill=join(root,".agents/skills/diagram/SKILL.md");expect(existsSync(skill),"DIAGRAM_AUTHORING_SKILL_MATERIALIZED").toBe(true);
  const lint=await runCli(root,["module","lint","diagrams","--json"]);expect(lint.code,lint.stderr).toBe(0);expect(JSON.parse(lint.stdout).findings).toEqual([]);
  const instructions=["CLAUDE.md","AGENTS.md"].filter(file=>existsSync(join(root,file))).map(file=>readFileSync(join(root,file),"utf8")).join("\n");expect(instructions,"DIAGRAM_WORKFLOW_IN_GENERATED_CONTEXT").toContain("diagram");expect(instructions).toContain("Mermaid");
 }finally{cleanup(root);}
});
test("the skill's own worked diagram fences pass the real keyless check CLI",async()=>{
 const path=new URL("../skills/diagram/SKILL.md",import.meta.url);expect(existsSync(path),"WORKED_SKILL_SOURCE_EXISTS").toBe(true);const source=readFileSync(path,"utf8"),examples=[...source.matchAll(/```diagram\n([\s\S]*?)\n```/g)].map(match=>match[1]!);expect(examples.length,"WORKED_FENCE_EXAMPLES_PRESENT").toBeGreaterThanOrEqual(2);
 const root=fixture();try{for(const [index,example]of examples.entries()){writeFileSync(join(root,"worked.diagram.yaml"),example);const result=await runCli(root,["diagram","check","worked.diagram.yaml","--json"]);expect(result.code,`WORKED_FENCE_${index}: ${result.stdout} ${result.stderr}`).toBe(0);expect(JSON.parse(result.stdout)).toMatchObject({schema_version:1,valid:true,errors:[]});}}finally{cleanup(root);}
});

test("all on-demand type references resolve and their shipped examples pass the check CLI",async()=>{
 const start=resolve(import.meta.dir,"../skills/diagram/SKILL.md"),seen=new Set<string>(),examples=new Set<string>();
 const visit=(file:string)=>{if(seen.has(file))return;seen.add(file);const text=readFileSync(file,"utf8");for(const match of text.matchAll(/\[[^\]]+\]\(([^)]+)\)/g)){const link=match[1]!.split("#")[0]!;if(!link||/^[a-z]+:/i.test(link))continue;const target=resolve(dirname(file),link);expect(existsSync(target),`SHIPPED_SKILL_REFERENCE ${link}`).toBe(true);if(target.endsWith(".md"))visit(target);else if(target.endsWith(".diagram.yaml"))examples.add(target);}};visit(start);
 expect(examples.size,"ALL_SHIPPED_FAMILY_EXAMPLES_REACHABLE").toBeGreaterThanOrEqual(18);
 const root=fixture();try{for(const path of examples){writeFileSync(join(root,"worked.diagram.yaml"),readFileSync(path));const result=await runCli(root,["diagram","check","worked.diagram.yaml","--json"]);expect(result.code,`SHIPPED_EXAMPLE ${path}: ${result.stdout} ${result.stderr}`).toBe(0);expect(JSON.parse(result.stdout)).toMatchObject({schema_version:1,valid:true,errors:[]});}}finally{cleanup(root);}
},30000);
