import { expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, linkSync, rmSync, statSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { StoragePage, StorageStatus, StorageTreePage } from "@schlessera/brain-ui-sdk/protocol";
import { collectStorage } from "../src/storage/collect";
import { projectStorageTree } from "../src/storage/tree";
import { httpContractApp } from "./helpers/http-contract-app";

test("tree uses subtree union bytes, accounts directory metadata and assigns alias area once", async () => {
  const root = mkdtempSync(join(tmpdir(), "odysseus-storage-tree-")), brain = join(root,"brain"), app = join(root,"app");
  mkdirSync(join(brain,"charts/deep"), {recursive:true}); mkdirSync(join(brain,"maps")); mkdirSync(app);
  const original = join(brain,"charts/deep/Troy.pdf"); writeFileSync(original, Buffer.alloc(12_345, 65));
  linkSync(original,join(brain,"maps/Ithaca.pdf")); linkSync(original,join(app,"chart.pdf"));
  const single = join(app,"state.db"); writeFileSync(single,"Odysseus");
  try {
    const scan = await collectStorage({brainPath:brain,salt:"odysseus",stores:[{path:app,label:"App",owner:"app",category:"journal",recursive:true},{path:single,label:"DB",owner:"app",category:"database",recursive:false}],unavailable:[{label:"Backup",owner:"operator",category:"backup",reason:"unavailable"}]},"tree",new AbortController().signal);
    const all = projectStorageTree(scan,{}), brainRoot = scan.summary.roots.find(row=>row.category==="content")!;
    expect(all.totals).toEqual(scan.summary.totals.all);
    expect(all.nodes.reduce((sum,node)=>sum+(node.area.logical??0),0),"STORAGE_TREE_CROSS_ROOT_AREA_UNION").toBe(12_353);
    const unknown = all.nodes.find(node=>node.owner==="operator")!;
    expect(unknown.area).toEqual({logical:null,allocated:null,coverage:"unknown"});
    expect(projectStorageTree(scan,{owner:"operator",search:"nothing"}).totals.allocated,"STORAGE_TREE_EMPTY_UNKNOWN_FILTER").toBeNull();
    const tree = projectStorageTree(scan,{parentId:brainRoot.id}), charts = tree.nodes.find(node=>node.name==="charts")!, maps = tree.nodes.find(node=>node.name==="maps")!;
    expect(tree.totals,"STORAGE_TREE_FOLDER_INCLUDES_DESCENDANTS").toEqual({logical:brainRoot.logical,allocated:brainRoot.allocated,coverage:brainRoot.coverage});
    expect(charts.totals.logical,"STORAGE_TREE_FOLDER_INCLUDES_DESCENDANTS").toBe(12_345);
    expect(charts.totals.allocated).toBe((statSync(join(brain,"charts")).blocks+statSync(join(brain,"charts/deep")).blocks+statSync(original).blocks)*512);
    expect(maps.totals.logical).toBe(12_345);
    expect(maps.area.logical,"STORAGE_TREE_ALIAS_AREA_ONLY_ONCE").toBe(0);
    expect(tree.nodes.reduce((sum,node)=>sum+(node.area.allocated??0),0)).toBe(brainRoot.allocated!);
    expect(tree.nodes.find(node=>node.kind==="metadata")?.area.allocated,"STORAGE_TREE_DIRECTORY_METADATA").toBe(statSync(brain).blocks*512);
    const nested = projectStorageTree(scan,{parentId:charts.id}), deep = nested.nodes.find(node=>node.name==="deep")!;
    expect(nested.totals).toEqual(charts.totals);
    const leaf = projectStorageTree(scan,{parentId:deep.id});
    expect(leaf.breadcrumbs.map(crumb=>crumb.name)).toEqual(["All stores","Brain files","charts","deep"]);
    expect(leaf.nodes.find(node=>node.name==="Troy.pdf")?.area.logical).toBe(12_345);
    expect(projectStorageTree(scan,{parentId:brainRoot.id,search:"MAP"}).totals.logical).toBe(12_345);
    expect(()=>projectStorageTree(scan,{parentId:brainRoot.id,owner:"app"})).toThrow("ownership");
    const dbRoot = scan.summary.roots.find(row=>row.label==="DB")!;
    expect(projectStorageTree(scan,{parentId:dbRoot.id}).nodes[0]?.kind,"STORAGE_TREE_FILE_ROOT_NOT_DIRECTORY").toBe("file");
    const broken = {...scan,entries:scan.entries.filter(row=>row.id!==charts.id)};
    expect(()=>projectStorageTree(broken,{parentId:brainRoot.id}),"STORAGE_TREE_MISSING_ANCESTOR_REFUSED").toThrow("incomplete");
  } finally { rmSync(root,{recursive:true,force:true}); }
});

test("mounted hierarchy and flat queries search and sort the complete scan before signed paging without rescanning", async () => {
  const fixture = await httpContractApp();
  try {
    const charts=join(fixture.brainPath,"charts");mkdirSync(charts);
    for(let index=0;index<205;index++) writeFileSync(join(charts,`Troy-${String(index).padStart(3,"0")}.pdf`),"x".repeat(index+1));
    await fixture.fetch("/api/storage/scans",{method:"POST",headers:{"content-type":"application/json"},body:"{}"});
    let status:StorageStatus;
    for(let attempt=0;;attempt++) { status=await (await fixture.fetch("/api/storage")).json() as StorageStatus;if(status.state==="idle")break;if(attempt>=200)throw Error("Scan did not finish");await new Promise(done=>setTimeout(done,10)); }
    expect(status.lastFailure).toBeNull();const scan=status.snapshot!,base=`/api/storage/scans/${scan.id}`;
    const roots=await (await fixture.fetch(base+"/tree")).json() as StorageTreePage;
    const root=roots.nodes.find(node=>node.name==="Brain files")!;
    const child=await (await fixture.fetch(base+`/tree?parentId=${root.id}`)).json() as StorageTreePage;
    const folder=child.nodes.find(node=>node.name==="charts")!;
    // The projection must use this retained observation, including after sources disappear.
    rmSync(charts,{recursive:true});
    const query=`parentId=${folder.id}&search=troy&sort=size&metric=logical&direction=desc`;
    const response=await fixture.fetch(base+"/tree?"+query),page=await response.json() as StorageTreePage;
    expect(response.status,"STORAGE_TREE_MOUNTED_QUERY").toBe(200);expect(response.headers.get("cache-control")).toContain("no-store");
    expect(page.matched).toBe(205);expect(page.nodes).toHaveLength(200);
    expect(page.nodes[0]?.name,"STORAGE_TREE_SORTS_BEFORE_PAGING").toBe("Troy-204.pdf");
    expect(page.totals.logical).toBe(205*206/2);expect(page.nextCursor).not.toBeNull();
    const tail=await (await fixture.fetch(base+"/tree?"+query+"&cursor="+encodeURIComponent(page.nextCursor!))).json() as StorageTreePage;
    expect(tail.nodes.map(node=>node.name)).toEqual(["Troy-004.pdf","Troy-003.pdf","Troy-002.pdf","Troy-001.pdf","Troy-000.pdf"]);
    expect(tail.nextCursor).toBeNull();
    expect((await fixture.fetch(base+"/tree?"+query.replace("desc","asc")+"&cursor="+encodeURIComponent(page.nextCursor!))).status,"STORAGE_TREE_CURSOR_BINDS_ORDER").toBe(409);
    expect((await fixture.fetch(base+"/entries?cursor="+encodeURIComponent(page.nextCursor!))).status,"STORAGE_TREE_CURSOR_SEPARATE_FROM_FLAT").toBe(409);
    const flat=await (await fixture.fetch(base+"/entries?search=TROY-204&sort=size&metric=logical")).json() as StoragePage;
    expect(flat.entries.map(row=>row.name)).toEqual(["Troy-204.pdf"]);expect(flat.fileLogicalTotal).toBe(205);
    for(const suffix of ["search="+"x".repeat(129),"sort=unknown","metric=unknown","direction=unknown","parentId=unknown","root=/"]) {
      expect((await fixture.fetch(base+"/tree?"+suffix)).status).toBe(400);
    }
    expect((await fixture.fetch(base+"/tree?cursor=forged")).status).toBe(400);
  } finally { await fixture.close(); }
});
