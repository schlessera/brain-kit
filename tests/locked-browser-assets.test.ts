import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createHash } from "node:crypto";
import { auditedReaderDigest, lockedBrowserAsset } from "../scripts/locked-browser-assets";
import { frozenGeneratedSource } from "./frozen-generated-source";
const roots:string[]=[],repo=resolve(import.meta.dir,".."),owner="packages/ui-react/tests/browser/offline/cold-capture/commands.ts",literal="../../node_modules/axe-core/axe.min.js";
afterEach(()=>{for(const root of roots.splice(0))rmSync(root,{recursive:true,force:true});});
function fixture(){const root=mkdtempSync(join(tmpdir(),"locked-browser-asset-"));roots.push(root);
  const write=(file:string,text:string)=>{mkdirSync(dirname(join(root,file)),{recursive:true});writeFileSync(join(root,file),text);};
  write(owner,frozenGeneratedSource(owner));write("package.json","{}");write("bun.lock","{}");write("node_modules/axe-core/package.json",JSON.stringify({name:"axe-core",version:"4.13.0"}));write("node_modules/axe-core/axe.min.js","owned bytes");return{root,write};}
test("only exact audited dependency asset readers admit bytes; missing, escaped and symbolic inputs stay unknown",()=>{
  const {root,write}=fixture();expect(lockedBrowserAsset(root,owner,literal)?.package).toBe("axe-core");
  expect(lockedBrowserAsset(root,"unowned.ts",literal)).toBeUndefined();expect(lockedBrowserAsset(root,owner,"../../node_modules/other/file.js")).toBeUndefined();
  write(owner,frozenGeneratedSource(owner)+"\n// drift");expect(lockedBrowserAsset(root,owner,literal)).toBeUndefined();write(owner,frozenGeneratedSource(owner));
  write("node_modules/axe-core/package.json",JSON.stringify({name:"other",version:"4.13.0"}));expect(lockedBrowserAsset(root,owner,literal)).toBeUndefined();
  write("node_modules/axe-core/package.json",JSON.stringify({name:"axe-core",version:"4.13.0"}));
  rmSync(join(root,"node_modules/axe-core/axe.min.js"));expect(lockedBrowserAsset(root,owner,literal)).toBeUndefined();
  write("outside.js","other bytes");symlinkSync(join(root,"outside.js"),join(root,"node_modules/axe-core/axe.min.js"));expect(lockedBrowserAsset(root,owner,literal)).toBeUndefined();
});
// #2408 (maintainer ruling 2026-11-04): an audited reader that drifts from its
// pin leaves its asset unknown, so proof runs fresh, until a post-merge re-audit
// refreshes the pin. The repo's own reader is therefore held to whichever branch
// its bytes are on, and a drifted reader can never yield a receipt.
test("the repo reader yields the installed receipt only while it matches its audited pin; drift stays unknown",async()=>{
  const pinned=createHash("sha256").update(readFileSync(join(repo,owner))).digest("hex")===auditedReaderDigest(owner);
  const resource=lockedBrowserAsset(repo,owner,literal);
  if(!pinned){expect(resource,"DRIFTED_READER_BINDING_UNKNOWN").toBeUndefined();return;}
  expect(resource,"PINNED_READER_RECEIPT").toBeDefined();
  const manifest=JSON.parse(readFileSync(join(repo,"node_modules/axe-core/package.json"),"utf8"));expect(resource?.version).toBe(manifest.version);
  const digest=Buffer.from(await crypto.subtle.digest("SHA-256",await Bun.file(join(repo,"node_modules/axe-core/axe.min.js")).arrayBuffer())).toString("hex");expect(resource?.sha256).toBe(digest);
});
test("the frozen audited reader matches its pin and yields the installed receipt",async()=>{
  const {root}=fixture();rmSync(join(root,"node_modules"),{recursive:true});symlinkSync(join(repo,"node_modules"),join(root,"node_modules"),"dir");
  const pin=auditedReaderDigest(owner);expect(pin,"READER_IS_AUDITED").toBeDefined();expect(createHash("sha256").update(frozenGeneratedSource(owner)).digest("hex"),"FROZEN_READER_MATCHES_PIN").toBe(pin!);
  const resource=lockedBrowserAsset(root,owner,literal);expect(resource,"PINNED_READER_RECEIPT").toBeDefined();
  const manifest=JSON.parse(readFileSync(join(repo,"node_modules/axe-core/package.json"),"utf8"));expect(resource?.version).toBe(manifest.version);
  const digest=Buffer.from(await crypto.subtle.digest("SHA-256",await Bun.file(join(repo,"node_modules/axe-core/axe.min.js")).arrayBuffer())).toString("hex");expect(resource?.sha256).toBe(digest);
});
