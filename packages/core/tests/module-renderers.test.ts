import { afterEach, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "fs";
import { join } from "path";
import { cleanup, makeTempBrain, runCli } from "./cli-harness";
import { loadModules } from "../src/lib/module-loader";
import { collectModuleRenderers } from "../src/lib/module-renderers";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) cleanup(root); });
function fixture(declaration: unknown = { fences: ["diagram"], extensions: [".diagram.yaml"], client: "@odyssey/figures/ui", static: "@odyssey/figures/render" }) {
  const root = makeTempBrain({ empty: true }); roots.push(root);
  const dir = join(root, "modules/figures"); mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "@odyssey/figures", version: "1.0.0", type: "module", exports: { "./ui": "./ui.ts", "./render": "./render.ts" } }));
  writeFileSync(join(dir, "module.ts"), `export default {name:"figures", setup:()=>({renderers:{figure:${JSON.stringify(declaration)}}})}`);
  writeFileSync(join(dir, "ui.ts"), "export const component = () => null;");
  writeFileSync(join(dir, "render.ts"), "export const toStatic = async () => '<svg/>';");
  writeFileSync(join(root, "brain.config.json"), JSON.stringify({ modules: { "./modules/figures": {} } }));
  return {root, dir};
}
const config = { modules: { "./modules/figures": {} } };
test("manifest loads and CLI exposes version without importing client", async () => {
  const {root,dir} = fixture(); writeFileSync(join(dir,"ui.ts"), 'throw new Error("client must not execute at load or lint");');
  expect(collectModuleRenderers(await loadModules(config, root))).toEqual([{module:"figures",name:"figure",version:"1.0.0",fences:["diagram"],extensions:[".diagram.yaml"],client:"@odyssey/figures/ui",static:"@odyssey/figures/render"}]);
  const result = await runCli(root,["module","list","--json"]);
  expect(result.code).toBe(0);
  expect(JSON.parse(result.stdout).enabled[0]).toMatchObject({version:"1.0.0",renderers:{figure:{client:"@odyssey/figures/ui"}}});
  const lint = await runCli(root,["module","lint","figures","--json"]);
  expect(JSON.parse(lint.stdout).findings).toEqual([]); expect(lint.code).toBe(0);
});
test("CLI lint names missing static toStatic export", async () => {
  const {root,dir} = fixture(); writeFileSync(join(dir,"render.ts"), "export const other = 1;");
  const result = await runCli(root,["module","lint","figures","--json"]);
  expect(JSON.parse(result.stdout).findings).toContainEqual(expect.objectContaining({rule:"renderer-export",message:expect.stringContaining("missing named export toStatic")}));
  expect(result.code).toBe(1);
});
test("CLI lint names unresolved package export", async () => {
  const {root} = fixture({client:"@odyssey/figures/missing"});
  const result = await runCli(root,["module","lint","figures","--json"]);
  expect(JSON.parse(result.stdout).findings[0].message).toContain("@odyssey/figures/missing"); expect(result.code).toBe(1);
});
for (const [label,value] of [["unknown field",{client:"@odyssey/figures/ui",typo:true}],["invalid fence",{client:"@odyssey/figures/ui",fences:["Diagram"]}],["invalid extension",{client:"@odyssey/figures/ui",extensions:["svg"]}],["foreign export",{client:"@odyssey/other/ui"}],["path traversal",{client:"@odyssey/figures/../ui"}],["prefix spoof",{client:"@odyssey/figures-other/ui"}]] as const) {
  test(`rejects ${label}`,async()=>{const {root}=fixture(value);await expect(loadModules(config,root)).rejects.toThrow();});
}
for (const declaration of [{fences:["mermaid"]},{fences:["mmd"]},{extensions:[".mmd"]},{extensions:[".mermaid"]}]) {
  test(`reserves built-in claim ${JSON.stringify(declaration)}`,async()=>{const {root}=fixture({client:"@odyssey/figures/ui",...declaration});await expect(loadModules(config,root)).rejects.toThrow("reserved");});
}
for (const claim of [{fences:["diagram"]},{extensions:[".diagram.yaml"]}]) {
 test(`collision names both owners; dormant owner does not collide ${JSON.stringify(claim)}`,async()=>{
  const {root}=fixture({client:"@odyssey/figures/ui",...claim});
  const dir=join(root,"modules/other");mkdirSync(dir,{recursive:true});
  writeFileSync(join(dir,"package.json"),JSON.stringify({name:"@odyssey/other"}));
  writeFileSync(join(dir,"module.ts"),`export default {name:"other",setup:()=>({renderers:{other:${JSON.stringify({client:"@odyssey/other/ui",...claim})}}})}`);
  await expect(loadModules({modules:{...config.modules,"./modules/other":{}}},root)).rejects.toThrow('between "figures/figure" and "other/other"');
  expect(collectModuleRenderers(await loadModules({modules:{...config.modules,"./modules/other":{enabled:false}}},root)).map(r=>r.module)).toEqual(["figures"]);
 });
}
