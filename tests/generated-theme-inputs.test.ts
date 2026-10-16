import {afterEach,expect,test} from "bun:test";
import {cpSync,mkdirSync,mkdtempSync,readFileSync,readdirSync,rmSync,symlinkSync,writeFileSync} from "node:fs";
import {tmpdir} from "node:os";
import {dirname,join,resolve} from "node:path";
import {browserImporters} from "../scripts/bound-browser-runtime-inputs";
import {generatedThemeInputs} from "../scripts/generated-theme-inputs";
const repo=resolve(import.meta.dir,".."),roots:string[]=[],owner="packages/ui-kit/tests/visual/dictation-motion.ts",caller="packages/ui-kit/vitest.config.ts",entry="packages/ui-kit/tests/visual/dictation-theme.css";
const producers=["scripts/build.ts","scripts/bin-modes.ts","scripts/publishable-packages.ts","scripts/workspace-lease.mjs","scripts/ci-proof.ts","scripts/check-pr.ts","scripts/ci-runner.ts",".github/workflows/ci.yml","package.json","bun.lock","packages/ui-react/src/theme.css","packages/ui-react/package.json"];
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),"generated-theme-"));roots.push(root);const write=(file:string,text:string)=>{mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),text);};for(const file of [...producers,owner,caller,entry])write(file,readFileSync(join(repo,file),"utf8"));symlinkSync(join(repo,"node_modules"),join(root,"node_modules"),"dir");return{root,write};}
test("temporary theme output binds the audited command, copied theme and installed compiler",()=>{
  const {root}=fixture(),files=[owner,caller],bound=generatedThemeInputs(root,files,browserImporters(root,files));
  expect(bound?.css).toEqual([entry,"packages/ui-react/src/theme.css"]);
  expect(bound?.compiler.package).toBe("@tailwindcss/cli");expect(bound?.compiler.asset).toBe("dist/index.mjs");
  expect(bound?.bytes).toContain("scripts/build.ts");expect(bound?.aliases.get("execFile")?.has("promisify(execFile)")).toBe(true);
});
test("command, input, execution-order drift and extra callers refuse the generated theme binding",()=>{
  for(const file of [owner,caller,entry,"scripts/build.ts"]){const {root,write}=fixture();write(file,readFileSync(join(root,file),"utf8")+"\n/* drift */\n");expect(generatedThemeInputs(root,[owner,caller],browserImporters(root,[owner,caller]))).toBeUndefined();}
  const {root,write}=fixture();write("extra.ts",`export {dictationThemeStyles} from "./${owner}";`);const files=[owner,caller,"extra.ts"];
  expect(generatedThemeInputs(root,files,browserImporters(root,files))).toBeUndefined();
});
test("actual temporary-theme command compiles owned source and propagates a broken compiler input",async()=>{
  const {root,write}=fixture();rmSync(join(root,"node_modules"));mkdirSync(join(root,"node_modules/@schlessera"),{recursive:true});
  for(const name of readdirSync(join(repo,"node_modules")))if(name!=="@schlessera")symlinkSync(join(repo,"node_modules",name),join(root,"node_modules",name));
  for(const name of ["ui-react","ui-kit"]){
    write(`packages/${name}/package.json`,readFileSync(join(repo,`packages/${name}/package.json`),"utf8"));
    symlinkSync(join(root,`packages/${name}`),join(root,`node_modules/@schlessera/brain-${name}`),"dir");
  }
  // Reproduce the real builder's byte-for-byte theme/token copy stages. The
  // source scan belongs to this fixture, never the caller's current dist.
  cpSync(join(repo,"packages/ui-react/src"),join(root,"packages/ui-react/src"),{recursive:true});
  write("packages/ui-react/dist/theme.css",readFileSync(join(repo,"packages/ui-react/src/theme.css"),"utf8"));
  write("packages/ui-kit/dist/tokens.css",readFileSync(join(repo,"packages/ui-kit/src/tokens.css"),"utf8"));
  async function compile(){
    const child=Bun.spawn([process.execPath,"--eval",`const {dictationThemeStyles}=await import(${JSON.stringify(join(root,owner))});console.log(await dictationThemeStyles());`],{cwd:join(root,"packages/ui-kit"),stdout:"pipe",stderr:"pipe"});
    const [out,error,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);return{out,error,exit};
  }
  const before=await compile();expect(before.exit,before.error).toBe(0);expect(before.out).toContain("--bk-color-canvas");
  write(entry,readFileSync(join(root,entry),"utf8")+"\n@import './missing-owned-source.css';\n");
  const broken=await compile();expect(broken.exit).not.toBe(0);expect(broken.error).toContain("missing-owned-source.css");
});
