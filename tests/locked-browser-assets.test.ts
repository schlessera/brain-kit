import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { lockedBrowserAsset } from "../scripts/locked-browser-assets";
const roots:string[]=[],repo=resolve(import.meta.dir,".."),owner="packages/ui-react/tests/browser/offline/cold-capture/commands.ts",literal="../../node_modules/axe-core/axe.min.js";
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),"locked-browser-asset-"));roots.push(root);
  const write=(file:string,text:string)=>{mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),text);};
  write(owner,readFileSync(join(repo,owner),"utf8"));write("package.json","{}");write("bun.lock","{}");write("node_modules/axe-core/package.json",JSON.stringify({name:"axe-core",version:"4.13.0"}));write("node_modules/axe-core/axe.min.js","owned bytes");return{root,write};}
test("only exact audited dependency asset readers admit bytes; missing, escaped and symbolic inputs stay unknown",()=>{
  const {root,write}=fixture();expect(lockedBrowserAsset(root,owner,literal)?.package).toBe("axe-core");
  expect(lockedBrowserAsset(root,"unowned.ts",literal)).toBeUndefined();expect(lockedBrowserAsset(root,owner,"../../node_modules/other/file.js")).toBeUndefined();
  write(owner,readFileSync(join(repo,owner),"utf8")+"\n// drift");expect(lockedBrowserAsset(root,owner,literal)).toBeUndefined();write(owner,readFileSync(join(repo,owner),"utf8"));
  write("node_modules/axe-core/package.json",JSON.stringify({name:"other",version:"4.13.0"}));expect(lockedBrowserAsset(root,owner,literal)).toBeUndefined();
  write("node_modules/axe-core/package.json",JSON.stringify({name:"axe-core",version:"4.13.0"}));
  rmSync(join(root,"node_modules/axe-core/axe.min.js"));expect(lockedBrowserAsset(root,owner,literal)).toBeUndefined();
  write("outside.js","other bytes");symlinkSync(join(root,"outside.js"),join(root,"node_modules/axe-core/axe.min.js"));expect(lockedBrowserAsset(root,owner,literal)).toBeUndefined();
});
test("actual installed locked asset receipt contains consumed bytes and package identity",async()=>{
  const resource=lockedBrowserAsset(repo,owner,literal);expect(resource).toBeDefined();
  const manifest=JSON.parse(readFileSync(join(repo,"node_modules/axe-core/package.json"),"utf8"));expect(resource?.version).toBe(manifest.version);
  const digest=Buffer.from(await crypto.subtle.digest("SHA-256",await Bun.file(join(repo,"node_modules/axe-core/axe.min.js")).arrayBuffer())).toString("hex");expect(resource?.sha256).toBe(digest);
});
