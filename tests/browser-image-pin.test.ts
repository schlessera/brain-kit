import {expect,test,afterEach} from "bun:test";
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync} from "node:fs";
import {tmpdir} from "node:os";
import {resolve,join} from "node:path";
import {browserPinUsesProducer,parseBrowserPin,resolveBrowserPin} from "../scripts/captures/provenance";
const root=resolve(import.meta.dir,".."),image="mcr.microsoft.com/playwright@sha256:eff16c30e6f3f4af0a03fa4b706120d5e9b0891c344a27d64559aff5900a4a27";
const runner=readFileSync(join(root,"scripts/visual.mjs"),"utf8"),producer=readFileSync(join(root,"scripts/diagram-export-producer.mjs"),"utf8");
const roots:string[]=[];afterEach(()=>{for(const path of roots.splice(0))rmSync(path,{recursive:true,force:true});});
test("actual shared runner resolves the immutable execution image and installed Playwright",async()=>{
 expect(await resolveBrowserPin(root)).toEqual({image,playwright:"1.63.0"});
 expect(parseBrowserPin(runner,producer)).toEqual({image,playwright:"1.63.0"});
});
test("historical literal source remains explicit and comment/string pin lookalikes never execute",()=>{
 const tag="mcr.microsoft.com/playwright:v1.63.0-noble";
 expect(parseBrowserPin(`const IMAGE="${tag}"; // const IMAGE = "other";\nthrow new Error("must never execute");`)).toEqual({image:tag,playwright:"1.63.0"});
 expect(browserPinUsesProducer(`const IMAGE="${tag}";`)).toBe(false);
 for(const text of [`// const IMAGE = "${tag}";`,`const text='const IMAGE = "${tag}";';`])expect(()=>parseBrowserPin(text)).toThrow("exactly one static IMAGE");
});
for(const [name,source] of [
 ["different module",runner.replace('"./diagram-export-producer.mjs"','"./other.mjs"')],
 ["renamed imported export",runner.replace('prepareDiagramNativeArtifacts, diagramProducerImageIdentity','prepareDiagramNativeArtifacts, other as diagramProducerImageIdentity')],
 ["shadowed imported binding",runner+'\nfunction other(diagramProducerImageIdentity) {}'],
 ["nonconstant binding",runner.replace('const IMAGE =','let IMAGE =')],
 ["computed initializer",runner.replace('const IMAGE = diagramProducerImageIdentity;','const IMAGE = `${diagramProducerImageIdentity}`;')],
 ["nested IMAGE",runner+'\nfunction other(){const IMAGE="other";}'],
] as const)test(`static image ownership refuses ${name}`,()=>{expect(()=>parseBrowserPin(source,producer)).toThrow();});
for(const [name,source] of [
 ["missing producer",undefined],
 ["wrong origin",producer.replace('mcr.microsoft.com/playwright@','example.invalid/playwright@')],
 ["malformed digest",producer.replace('sha256:eff16','sha256:invalid')],
 ["nonliteral digest",producer.replace(`"${image}"`,'process.env.IMAGE')],
 ["nonexported tag",producer.replace('export const diagramProducerImage=','const diagramProducerImage=')],
 ["tag declaration in string",`const text='export const diagramProducerImage="mcr.microsoft.com/playwright:v1.63.0-noble";';`],
] as const)test(`static producer refuses ${name}`,()=>{expect(()=>parseBrowserPin(runner,source)).toThrow();});
test("declared or installed version disagreement remains refused",async()=>{
 for(const changed of ["declared","installed"]){
  const path=mkdtempSync(join(tmpdir(),"odysseus-image-pin-"));roots.push(path);
  for(const dir of ["scripts","packages/ui-kit","node_modules/playwright"])mkdirSync(join(path,dir),{recursive:true});
  writeFileSync(join(path,"scripts/visual.mjs"),runner);writeFileSync(join(path,"scripts/diagram-export-producer.mjs"),producer);
  writeFileSync(join(path,"packages/ui-kit/package.json"),JSON.stringify({devDependencies:{playwright:changed==="declared"?"0.0.0":"1.63.0"}}));
  writeFileSync(join(path,"node_modules/playwright/package.json"),JSON.stringify({version:changed==="installed"?"0.0.0":"1.63.0"}));
  await expect(resolveBrowserPin(path)).rejects.toThrow("versions differ");
 }
});
