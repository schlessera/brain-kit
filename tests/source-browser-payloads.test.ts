import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import ts from "typescript";
import { sourceBrowserPayload } from "../scripts/source-browser-payloads";
import { discoverInputClosure } from "../scripts/browser-input-closure";
const repo=resolve(import.meta.dir,".."),roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function expressions(source:string){const ast=ts.createSourceFile("owner.ts",source,ts.ScriptTarget.Latest,true);const result:string[]=[];const walk=(node:ts.Node)=>{if(ts.isCallExpression(node)&&/\.(?:fulfill|setContent)$/.test(node.expression.getText(ast)))result.push(node.getText(ast));ts.forEachChild(node,walk);};walk(ast);return result;}
test("only the exact literal SVG rectangle and pixel probe bind source-owned payload bytes",()=>{
  const root=mkdtempSync(join(tmpdir(),"browser-literal-payload-"));roots.push(root);
  for(const owner of ["packages/ui-kit/tests/visual/form-browser.ts","packages/ui-kit/tests/visual/ghost-browser.ts"]){
    const source=readFileSync(join(repo,owner),"utf8");mkdirSync(dirname(join(root,owner)),{recursive:true});writeFileSync(join(root,owner),source);
    const calls=expressions(source),allowed=calls.filter(call=>sourceBrowserPayload(root,owner,call));expect(allowed.length).toBe(1);
    const closure=discoverInputClosure(root,[owner]);expect(closure.unresolved.some(value=>value.includes(allowed[0]!))).toBe(false);
    expect(calls.filter(call=>!sourceBrowserPayload(root,owner,call)).length).toBeGreaterThan(0);
    writeFileSync(join(root,owner),source+"\n// lexical binding drift\n");expect(sourceBrowserPayload(root,owner,allowed[0]!)).toBe(false);
    expect(sourceBrowserPayload(root,owner,'page.setContent("<script src=external></script>")')).toBe(false);
  }
});
