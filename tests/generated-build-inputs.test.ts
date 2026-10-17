import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { generatedCssInputs, generatedCssReadInputs } from "../scripts/generated-build-inputs";
import { discoverInputClosure } from "../scripts/browser-input-closure";
const repo=resolve(import.meta.dir,".."),roots:string[]=[];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
const producer=["scripts/build.ts","scripts/build-receipt.ts","scripts/bin-modes.ts","scripts/publishable-packages.ts","scripts/workspace-lease.mjs","scripts/ci-proof.ts","scripts/check-pr.ts","scripts/ci-runner.ts",".github/workflows/ci.yml","package.json"];
function fixture(){
  const root=mkdtempSync(join(tmpdir(),"generated-css-"));roots.push(root);
  const write=(file:string,bytes:string)=>{mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),bytes);};
  for(const file of producer)write(file,readFileSync(join(repo,file),"utf8"));
  write("packages/ui-react/src/styles.css",".marker{color:red}");write("packages/ui-react/package.json",'{}');
  return {root,write};
}
test("generated stylesheet imports own source and checked producer, without current dist artifacts",()=>{
  const {root,write}=fixture();write("packages/ui-kit/story.ts",'import css from "../ui-react/dist/styles.css?raw";');
  const closure=discoverInputClosure(root,["packages/ui-kit/story.ts"]);
  expect(closure.unresolved).toEqual([]);expect(closure.files).toContain("packages/ui-react/src/styles.css");expect(closure.files).toContain("scripts/build.ts");
  expect(closure.files).not.toContain("packages/ui-react/dist/styles.css");
  write("packages/ui-react/dist/styles.css","untrusted working-tree bytes");
  expect(discoverInputClosure(root,["packages/ui-kit/story.ts"]).files).toEqual(closure.files);
  expect(generatedCssInputs(root,"packages/ui-react/dist/unowned.css")).toBeUndefined();
});
test("producer, execution-order, receipt and package-script drift refuse generated stylesheet binding",()=>{
  const {root,write}=fixture();
  for(const file of producer){const original=readFileSync(join(root,file),"utf8");write(file,original+"\n// drift\n");expect(generatedCssInputs(root,"packages/ui-react/dist/styles.css")).toBeUndefined();write(file,original);}
  expect(generatedCssInputs(root,"../outside/dist/styles.css")).toBeUndefined();
});
test("copied theme and kit token exports bind their source without admitting nonexistent react tokens",()=>{
  const {root,write}=fixture();write("packages/ui-react/src/theme.css",".theme{}");write("packages/ui-kit/src/theme.css",".theme{}");write("packages/ui-kit/src/tokens.css",":root{--token:1}");
  expect(generatedCssInputs(root,"packages/ui-react/dist/theme.css")?.entry).toBe("packages/ui-react/src/theme.css");
  expect(generatedCssInputs(root,"packages/ui-kit/dist/theme.css")?.entry).toBe("packages/ui-kit/src/theme.css");
  expect(generatedCssInputs(root,"packages/ui-kit/dist/tokens.css")?.entry).toBe("packages/ui-kit/src/tokens.css");
  expect(generatedCssInputs(root,"packages/ui-react/dist/tokens.css")).toBeUndefined();
});
test("locked offline Tailwind CLI really derives changed bytes from owned stylesheet source",async()=>{
  const {root,write}=fixture();symlinkSync(join(repo,"node_modules"),join(root,"node_modules"),"dir");
  write("packages/ui-react/src/styles.css",'@import "tailwindcss" source(none); .marker { color: red; }');
  async function compile(){const child=Bun.spawn([process.execPath,"--preload",join(repo,"scripts/test-network-child-preload.ts"),join(repo,"node_modules/@tailwindcss/cli/dist/index.mjs"),"-i",join(root,"packages/ui-react/src/styles.css"),"-o",join(root,"result.css"),"--minify"],{cwd:root,stdout:"pipe",stderr:"pipe"});
    const [,error,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);expect(exit,error).toBe(0);return readFileSync(join(root,"result.css"),"utf8");}
  const before=await compile();expect(before).toContain(".marker");write("packages/ui-react/src/styles.css",'@import "tailwindcss" source(none); .marker { color: blue; }');
  const after=await compile();expect(after).toContain(".marker");expect(after).not.toBe(before);
});

test("only audited filesystem reader commands bind the generated stylesheet cwd",()=>{
  const {root,write}=fixture();const owner="packages/ui-kit/tests/visual/form-browser.ts";
  const original=readFileSync(join(repo,owner),"utf8");write(owner,original);
  expect(generatedCssReadInputs(root,owner,"../ui-react/dist/styles.css")?.entry).toBe("packages/ui-react/src/styles.css");
  expect(generatedCssReadInputs(root,owner,"../../outside/styles.css")).toBeUndefined();
  expect(generatedCssReadInputs(root,"other.ts","../ui-react/dist/styles.css")).toBeUndefined();
  const closure=discoverInputClosure(root,[owner]);
  expect(closure.unresolved.some(value=>value.includes('readFile(resolve("../ui-react/dist/styles.css"), "utf8")'))).toBe(false);
  write(owner,original+'\n// reader drift\n');
  expect(generatedCssReadInputs(root,owner,"../ui-react/dist/styles.css")).toBeUndefined();
  expect(discoverInputClosure(root,[owner]).unresolved.some(value=>value.includes('readFile(resolve("../ui-react/dist/styles.css"), "utf8")'))).toBe(true);
});
