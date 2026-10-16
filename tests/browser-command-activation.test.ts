import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { auditedInactiveCommands, auditCommandActivation } from "../scripts/browser-command-activation";
import { discoverInputClosure } from "../scripts/browser-input-closure";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
  const root = mkdtempSync(join(tmpdir(), "command-activation-")); roots.push(root);
  symlinkSync(join(import.meta.dir,"../node_modules"),join(root,"node_modules"),"dir");
  const write = (file: string, content: string) => { mkdirSync(join(root, file, ".."), { recursive: true }); writeFileSync(join(root, file), content); };
  write("command.ts", `import {readFileSync} from "node:fs"; import type {BrowserCommand} from "vitest/node";
export const heavy:BrowserCommand<[],unknown> = async () => readFileSync(process.env.INPUT!, "utf8");`);
  const config = `import {heavy} from "./command.ts";
export default {test:{setupFiles:["./setup.ts"],projects:[{test:{name:"layout",browser:{commands:{heavy}}}}]}};`;
  write("config.ts", config); write("setup.ts", `import {commands} from "vitest/browser"; await commands.light();`);
  write("spec.ts", `import {commands} from "vitest/browser"; await commands.light();`);
  const audit = () => auditCommandActivation(root, "config.ts", [{ project:"browser", file:"spec.ts" }], [{ owner:"command.ts", name:"heavy" }]);
  return {root,write,audit,config};
}
test("literal unselected registration is audited without suppressing callback or top-level inputs", () => {
  const {root,write,audit}=fixture();
  expect(audit()).toEqual({candidates:[{owner:"command.ts",name:"heavy",projects:["layout"]}],files:["command.ts","config.ts","setup.ts","spec.ts"],unresolved:[],executionExcluded:false});
  expect(discoverInputClosure(root,["config.ts"]).unresolved.some(value=>value.includes("Undeclared input command.ts"))).toBe(true);
  write("dependency.ts", `import {readFileSync} from "node:fs"; readFileSync(process.env.INPUT!,"utf8");`);
  write("command.ts", `import "./dependency.ts"; import type {BrowserCommand} from "vitest/node"; export const heavy:BrowserCommand<[],unknown>=async()=>0;`);
  expect(audit().executionExcluded).toBe(false);
  expect(discoverInputClosure(root,["config.ts"]).unresolved.some(value=>value.includes("Undeclared input dependency.ts"))).toBe(true);
});
test("activating dormant command through selected project, spec or inherited setup rejects nonactivation", () => {
  for(const activation of ["project","spec","setup"]) {
    const {write,audit,config}=fixture();
    if(activation==="project") write("config.ts",config.replace('name:"layout"','name:"browser"'));
    else write(activation==="spec"?"spec.ts":"setup.ts",`import {commands} from "vitest/browser"; await commands.heavy();`);
    expect(audit().unresolved.some(value=>/Active or ambiguous|Selected command invocation/.test(value))).toBe(true);
  }
});
test("dynamic, aliased and imported command activation and computed hooks remain unknown", () => {
  for(const spec of [
    `import {commands} from "vitest/browser"; await commands[process.env.OP!]();`,
    `import {commands} from "vitest/browser"; const alias=commands; await alias.heavy();`,
    `import * as browser from "vitest/browser"; await browser.commands.heavy();`,
    `import {heavy as alias} from "./command.ts"; await alias();`,
    `await import(process.env.SPEC!);`,
    `import("vitest/browser").then(({commands})=>commands.heavy());`,
    `const {commands}=require("vitest/browser"); commands.heavy();`,
    `export {commands as hidden} from "vitest/browser";`,
    `const execute=eval; execute("commands.heavy()");`,
  ]) { const {write,audit}=fixture(); write("spec.ts",spec); expect(audit().unresolved.length).toBeGreaterThan(0); }
  const {write,audit,config}=fixture(); write("config.ts",config.replace('["./setup.ts"]','[process.env.SETUP]'));
  expect(audit().unresolved.some(value=>value.includes("Computed activation hook"))).toBe(true);
});
test("ambiguous registration aliases and unknown project names cannot establish inactivity", () => {
  for(const change of [
    (source:string)=>source.replace('name:"layout"','name:process.env.PROJECT'),
    (source:string)=>source.replace('commands:{heavy}','commands:{renamed:heavy}'),
    (source:string)=>source.replace('commands:{heavy}','commands:{...other,heavy}'),
    (source:string)=>source+'\nheavy();',
  ]) { const {write,audit,config}=fixture(); write("config.ts",change(config)); expect(audit().unresolved.some(value=>value.includes("Active or ambiguous"))).toBe(true); }
});

test("only audited inactive callback bodies defer inputs; top-level imports and callback escape stay fresh", () => {
  const {root,write,config}=fixture();
  const activation={config:"config.ts",selected:[{project:"browser",file:"spec.ts"}],candidates:[{owner:"command.ts",name:"heavy"}]};
  expect(discoverInputClosure(root,["config.ts"],[],activation).unresolved).toEqual([]);
  write("dependency.ts", `import {readFileSync} from "node:fs"; readFileSync(process.env.INPUT!,"utf8");`);
  write("command.ts", `import "./dependency.ts"; import type {BrowserCommand} from "vitest/node"; export const heavy:BrowserCommand<[],unknown>=async()=>0;`);
  expect(discoverInputClosure(root,["config.ts"],[],activation).unresolved.some(value=>value.includes("Undeclared input dependency.ts"))).toBe(true);
  write("command.ts", `import type {BrowserCommand} from "vitest/node"; export const heavy:BrowserCommand<[],unknown>=async()=>0; const alias=heavy; alias();`);
  expect(discoverInputClosure(root,["config.ts"],[],activation).unresolved.some(value=>value.includes("Active or ambiguous"))).toBe(true);
  write("config.ts",config+'\nimport "./hook.ts";'); write("hook.ts",`import {heavy} from "./command.ts"; heavy();`);
  expect(discoverInputClosure(root,["config.ts"],[],activation).unresolved.some(value=>value.includes("Selected execution imports command owner"))).toBe(true);
});
test("dormant declared targets and their imports remain immutable input bytes", () => {
  const {root,write}=fixture();
  write("command.ts", `import {readFileSync} from "node:fs"; import type {BrowserCommand} from "vitest/node"; export const heavy:BrowserCommand<[],unknown>=async()=>readFileSync("generated");`);
  write("producer.ts", `import "./helper.ts"; import {readFileSync} from "node:fs"; readFileSync(process.env.INPUT!);`);
  write("helper.ts", `export const helper=1;`);
  const activation={config:"config.ts",selected:[{project:"browser",file:"spec.ts"}],candidates:[{owner:"command.ts",name:"heavy"}]};
  const closure=discoverInputClosure(root,["config.ts"],[{owner:"command.ts",inputs:[{expression:'readFileSync("generated")',targets:["producer.ts"]}]}],activation);
  expect(closure.unresolved).toEqual([]); expect(closure.files).toContain("producer.ts"); expect(closure.files).toContain("helper.ts");
});

test("actual bounded audit identity rejects config, runner, callback and imported helper drift", () => {
  const {root,write}=fixture();
  const files=["packages/ui-kit/vitest.config.ts","packages/ui-kit/vite.config.ts","scripts/visual.mjs","packages/ui-react/tests/browser/hygiene-completion-frame.ts","packages/ui-react/tests/browser/mermaid-proof-command.ts","packages/ui-react/tests/browser/offline/scene-commands.ts",...[
    "hygiene-loop","hygiene-server","policy-server","dispatch-actions"
  ].map(name=>`packages/ui-react/tests/browser/${name}-command.ts`)];
  for(const file of files) write(file,readFileSync(join(import.meta.dir,"..",file),"utf8"));
  const selected=[{project:"browser",file:"spec.ts"}];
  expect(auditedInactiveCommands(root,selected)).toBeDefined();
  for(const file of files) {
    const original=readFileSync(join(root,file),"utf8"); write(file,original+"\n// source drift\n");
    expect(auditedInactiveCommands(root,selected)).toBeUndefined(); write(file,original);
  }
});

test("real runner config import executes an inactive command module's transitive top-level input", async () => {
  const {root,write}=fixture();
  write("input.txt","top-level-ran");
  write("dependency.ts",`import {readFileSync} from "node:fs"; globalThis.__activationReceipt=readFileSync(${JSON.stringify(join(root,"input.txt"))},"utf8");`);
  write("command.ts",`import "./dependency.ts"; import type {BrowserCommand} from "vitest/node"; export const heavy:BrowserCommand<[],unknown>=async()=>{throw new Error("must not invoke");};`);
  const child=Bun.spawn([process.execPath,"-e",`await import(${JSON.stringify(join(root,"config.ts"))}); console.log(globalThis.__activationReceipt);`],{cwd:root,stdout:"pipe",stderr:"pipe"});
  const [output,error,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);
  expect(exit,error).toBe(0); expect(output.trim()).toBe("top-level-ran");
  const activation={config:"config.ts",selected:[{project:"browser",file:"spec.ts"}],candidates:[{owner:"command.ts",name:"heavy"}]};
  expect(discoverInputClosure(root,["config.ts"],[],activation).unresolved.some(value=>value.includes("Undeclared input dependency.ts"))).toBe(true);
});
