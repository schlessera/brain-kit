import { afterEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { digest } from "../scripts/ci-build-boundary";
import { verifyConsumerTree, consumerArchiveRoot, checkConsumerArchiveIdentity, inspectConsumerArchive } from "../scripts/ci-build-consumers";
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
function fixture() {
 const root=mkdtempSync(join(tmpdir(),"odysseus-consumer-tree-"));roots.push(root);
 const modules=join(root,"node_modules");mkdirSync(modules);
 const archives=new Map<string,ReadonlyMap<string,string>>();
 const put=(path:string,text:string)=>{mkdirSync(join(path,".."),{recursive:true});writeFileSync(path,text);};
 const pkg=(path:string,name:string,extras:Record<string,string>={},bin?:Record<string,string>)=>{
  const files={"package.json":JSON.stringify({name,version:"1.0.0",...(bin?{bin}:{})}),"index.js":'export const harbour="Ithaca";\n',...extras};
  for(const [file,text]of Object.entries(files))put(join(path,file),text);
  archives.set(`${name}@1.0.0`,new Map(Object.entries(files).map(([path,text])=>[path,digest(text)])));
 };
 return {root,modules,archives,put,pkg};
}
test("all hoisted and nested physical dependencies plus declared bin bytes are verified",()=>{
 const f=fixture(),ledger=join(f.modules,"@odysseus/ledger");
 f.pkg(ledger,"@odysseus/ledger",{"bin/cargo.js":"#!/usr/bin/env node\nconsole.log('Ithaca');\n",".harbour.js":"export const cargo=1;\n"},{cargo:"bin/cargo.js"});
 f.pkg(join(ledger,"node_modules/odysseus-cargo"),"odysseus-cargo");
 mkdirSync(join(f.modules,".bin"));symlinkSync("../@odysseus/ledger/bin/cargo.js",join(f.modules,".bin/cargo"));
 expect(verifyConsumerTree(f.modules,f.archives).map(pkg=>pkg.name).sort()).toEqual(["@odysseus/ledger","odysseus-cargo"]);
});
test("isolated hidden sibling stores and unknown dot sidecars are unsupported before imports",()=>{
 const f=fixture();f.pkg(join(f.modules,"odysseus-ledger"),"odysseus-ledger");
 f.put(join(f.modules,".bun/hidden@1.0.0/node_modules/hidden/index.js"),"export const cargo=2;\n");
 expect(()=>verifyConsumerTree(f.modules,f.archives),"CI_BUILD_HIDDEN_BUN_BYTES_CANNOT_ESCAPE_VERIFICATION").toThrow("CI_BUILD_PACK_HIDDEN_INSTALL_LAYOUT_UNSUPPORTED");
 rmSync(join(f.modules,".bun"),{recursive:true});f.put(join(f.modules,".unexpected"),"export const cargo=3;\n");
 expect(()=>verifyConsumerTree(f.modules,f.archives)).toThrow("CI_BUILD_PACK_HIDDEN_INSTALL_LAYOUT_UNSUPPORTED");
});
test("hidden package files and vendor nested node_modules bytes must match the archive",()=>{
 const f=fixture(),ledger=join(f.modules,"odysseus-ledger");
 const files={".entry.js":"export const cargo=1;\n","vendor/harbour/node_modules/cargo/index.js":"export const cargo=1;\n"};
 f.pkg(ledger,"odysseus-ledger",files);expect(verifyConsumerTree(f.modules,f.archives)).toHaveLength(1);
 for(const [path,text]of Object.entries(files)) {
  f.put(join(ledger,path),"export const cargo=2;\n");
  expect(()=>verifyConsumerTree(f.modules,f.archives),`CI_BUILD_BUNDLED_OR_HIDDEN_PAYLOAD_DRIFT_REFUSED:${path}`).toThrow("CI_BUILD_PACK_CACHE_PAYLOAD_MATCHES_VERIFIED_TARBALL");
  f.put(join(ledger,path),text);
 }
 expect(verifyConsumerTree(f.modules,f.archives)).toHaveLength(1);
});
test("archive-owned root bundled dependencies are verified without a version-only shortcut",()=>{
 const f=fixture(),ledger=join(f.modules,"odysseus-ledger"),bundled="node_modules/cargo/index.js";
 f.pkg(ledger,"odysseus-ledger",{[bundled]:"export const cargo=1;\n"});expect(verifyConsumerTree(f.modules,f.archives)).toHaveLength(1);
 f.put(join(ledger,bundled),"export const cargo=2;\n");
 expect(()=>verifyConsumerTree(f.modules,f.archives),"CI_BUILD_ROOT_BUNDLED_BYTES_VERIFIED").toThrow("CI_BUILD_PACK_CACHE_PAYLOAD_MATCHES_VERIFIED_TARBALL");
});
test("package aliases and undeclared bin aliases cannot substitute unverified execution bytes",()=>{
 const f=fixture();f.pkg(join(f.modules,"odysseus-ledger"),"odysseus-ledger");
 symlinkSync("odysseus-ledger",join(f.modules,"odysseus-alias"));
 expect(()=>verifyConsumerTree(f.modules,f.archives)).toThrow("CI_BUILD_PACK_PACKAGE_ALIAS_UNSUPPORTED");
 rmSync(join(f.modules,"odysseus-alias"));mkdirSync(join(f.modules,".bin"));symlinkSync("../odysseus-ledger/index.js",join(f.modules,".bin/cargo"));
 expect(()=>verifyConsumerTree(f.modules,f.archives)).toThrow("CI_BUILD_PACK_BIN_TARGET_IS_VERIFIED_DECLARED_PAYLOAD");
});

test("unreviewed physical dependency refuses verification before any consumer import",()=>{
 const f=fixture();f.pkg(join(f.modules,"odysseus-ledger"),"odysseus-ledger");f.pkg(join(f.modules,"odysseus-unknown"),"odysseus-unknown");f.archives.delete("odysseus-unknown@1.0.0");
 expect(()=>verifyConsumerTree(f.modules,f.archives),"CI_BUILD_UNKNOWN_DEPENDENCY_REFUSED_BEFORE_IMPORT").toThrow("CI_BUILD_PACK_DEPENDENCY_IS_REVIEWED");
});

test("verified type archives retain their single canonical root and exact package identity",()=>{
 const names=["react v18.3/","react v18.3/package.json","react v18.3/.hidden","react v18.3/index.d.ts"];
 expect(consumerArchiveRoot(names)).toBe("react v18.3");
 expect(consumerArchiveRoot([...names,"react v18.3/./index.d.ts"])).toBe("react v18.3");
 expect(()=>checkConsumerArchiveIdentity(JSON.stringify({name:"@types/react",version:"18.3.31"}),"@types/react","18.3.31")).not.toThrow();
 expect(()=>consumerArchiveRoot([...names,"outside/package.json"]),"CI_BUILD_MIXED_ARCHIVE_ROOT_REFUSED").toThrow("CI_BUILD_PACK_SINGLE_ARCHIVE_ROOT");
 for(const path of ["/outside/package.json","react v18.3/../outside.ts"])expect(()=>consumerArchiveRoot([...names,path])).toThrow("CI_BUILD_PACK_ARCHIVE_PATHS");
 expect(()=>checkConsumerArchiveIdentity(JSON.stringify({name:"@types/react",version:"18.3.31"}),"@types/react","18.3.0"),"CI_BUILD_WRONG_ARCHIVE_IDENTITY_REFUSED").toThrow("CI_BUILD_PACK_ARCHIVE_IDENTITY_MATCHES_CATALOG");
});

test("canonical duplicate archive entries require identical bytes and modes before imports",async()=>{
 const {packTar}=await import("modern-tar");
 const metadata=JSON.stringify({name:"odysseus-ledger",version:"1.0.0"}),base=[{header:{name:"package/package.json",type:"file" as const,size:Buffer.byteLength(metadata),mode:0o644},body:metadata},{header:{name:"package/dist/index.js",type:"file" as const,size:1,mode:0o644},body:"1"}];
 const archive=async(body:string,mode:number)=>Bun.gzipSync(await packTar([...base,{header:{name:"package/./dist/index.js",type:"file" as const,size:body.length,mode},body}]));
 expect((await inspectConsumerArchive(await archive("1",0o644),"odysseus-ledger","1.0.0")).get("dist/index.js")).toBe(digest("1"));
 await expect(inspectConsumerArchive(await archive("1",0o040644),"odysseus-ledger","1.0.0"),"CI_BUILD_TAR_MODE_TYPE_MISMATCH_REFUSED").rejects.toThrow("CI_BUILD_PACK_ARCHIVE_MODE");
 await expect(inspectConsumerArchive(await archive("2",0o644),"odysseus-ledger","1.0.0"),"CI_BUILD_DIFFERING_CANONICAL_BYTES_REFUSED").rejects.toThrow("CI_BUILD_PACK_CANONICAL_DUPLICATE_IDENTICAL");
 await expect(inspectConsumerArchive(await archive("1",0o755),"odysseus-ledger","1.0.0"),"CI_BUILD_DIFFERING_CANONICAL_MODE_REFUSED").rejects.toThrow("CI_BUILD_PACK_CANONICAL_DUPLICATE_IDENTICAL");
});
