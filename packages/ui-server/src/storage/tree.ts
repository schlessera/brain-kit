/** In-memory hierarchy projection over the bounded scan; no additional filesystem traversal. */
import type { StorageBytes, StorageFileEntry, StorageTreeFilter, StorageTreeNode } from "@schlessera/brain-ui-sdk/protocol";
import { storageTotals, type StorageCollection } from "./collect.js";
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
export function sortStorageRows<T extends { name: string; id: string }>(rows: T[], filter: {sort?: "name" | "size"; metric?: "logical" | "allocated"; direction?: "asc" | "desc"}, bytes: (row: T) => number | null): T[] {
  const direction = filter.direction === "asc" ? 1 : filter.direction === "desc" ? -1 : filter.sort === "name" ? 1 : -1;
  return rows.sort((a,b) => {
    if (filter.sort !== "name") {
      const left = bytes(a), right = bytes(b);
      if (left === null && right !== null) return 1; if (right === null && left !== null) return -1;
      if (left !== null && right !== null && left !== right) return direction * (left - right);
    }
    return direction * (filter.sort === "name" ? compare(a.name.toLowerCase(),b.name.toLowerCase()) : 0) || compare(a.name,b.name) || compare(a.id,b.id);
  });
}
export function projectStorageTree(collection: StorageCollection, filter: StorageTreeFilter) {
  const started = Date.now(), roots = new Map(collection.summary.roots.map(root => [root.id, root])), byId = new Map(collection.entries.map(entry => [entry.id,entry]));
  const parentRoot = filter.parentId ? roots.get(filter.parentId) : undefined, parentEntry = filter.parentId ? byId.get(filter.parentId) : undefined;
  if (filter.parentId && !parentRoot && (!parentEntry || parentEntry.kind !== "directory")) throw Error("Storage folder observation unavailable.");
  const selectedRoot = parentRoot ?? (parentEntry ? roots.get(parentEntry.rootId) : undefined);
  if (selectedRoot && filter.owner && filter.owner !== "all" && selectedRoot.owner !== filter.owner) throw Error("Storage folder is outside this ownership view.");
  const deadline = () => { if (Date.now() - started > 3000) throw Error("Storage projection time bound reached."); };
  const nodes = new Map<string, { node: StorageTreeNode; entries: StorageFileEntry[] }>(), childPaths = new Map<string,string>();
  const allowed = (rootId: string) => !!roots.get(rootId) && (!filter.owner || filter.owner === "all" || roots.get(rootId)!.owner === filter.owner);
  if (!filter.parentId) for (const root of roots.values()) {
    if (!allowed(root.id)) continue;
    nodes.set(root.id,{node:{id:root.id,rootId:root.id,entry:null,path:"",name:root.label,kind:"root",owner:root.owner,totals:root,area:root,reason:root.reason},entries:[]});
  } else {
    for (const entry of collection.entries) {
      if (entry.rootId !== selectedRoot!.id || !allowed(entry.rootId)) continue;
      const own = parentEntry ? entry.id === parentEntry.id : entry.path === "";
      const direct = parentEntry ? entry.parentId === parentEntry.id : !entry.path.includes("/") && entry.path !== "";
      if (!own && !direct) continue;
      const id = entry.id, root = roots.get(entry.rootId)!, metadata = own && entry.kind === "directory";
      nodes.set(id,{node:{id,rootId:entry.rootId,entry:metadata ? null : entry,path:entry.path,name:metadata ? "Directory metadata" : entry.name,kind:metadata ? "metadata" : entry.kind,owner:root.owner,totals:root,area:root,reason:root.reason},entries:[]});
      childPaths.set(entry.path,id);
    }
  }
  let count=0;
  for (const entry of collection.entries) {
    if (++count % 256 === 0) deadline();
    if (!allowed(entry.rootId) || selectedRoot && entry.rootId !== selectedRoot.id) continue;
    let child: string | undefined;
    if (!filter.parentId) child=entry.rootId;
    else {
      const prefix=parentEntry?.path ? parentEntry.path+"/" : "";
      if (parentEntry && entry.id===parentEntry.id || parentRoot && entry.path==="") child=entry.id;
      else if (entry.path.startsWith(prefix)) {
        const name=entry.path.slice(prefix.length).split("/",1)[0]!;
        if (name) child=childPaths.get(prefix+name);
      }
    }
    if (child && nodes.has(child)) nodes.get(child)!.entries.push(entry);
    else if (!filter.parentId || entry.path.startsWith(parentEntry?.path ? parentEntry.path + "/" : "")) {
      // A truncated or inconsistent scan must not silently lose descendant bytes.
      throw Error("Storage hierarchy is incomplete.");
    }
  }
  const search=filter.search?.toLowerCase() ?? "", selected=[...nodes.values()].filter(({node})=>!search || node.name.toLowerCase().includes(search)).sort((a,b)=>compare(a.node.rootId,b.node.rootId)||compare(a.node.path,b.node.path)||compare(a.node.id,b.node.id));
  const seen=new Set<string>(), union: StorageFileEntry[]=[];
  for(const group of selected) {
    deadline(); const root=roots.get(group.node.rootId)!,complete=root.coverage==="complete", area:StorageFileEntry[]=[];
    group.node.totals=storageTotals(group.entries,complete);
    for (const entry of group.entries) {
      if (++count % 256 === 0) deadline();
      if (!seen.has(entry.objectId)) { seen.add(entry.objectId); area.push(entry); union.push(entry); }
    }
    group.node.area=storageTotals(area,complete);
  }
  const complete=[...roots.values()].filter(root=>allowed(root.id)&&(!selectedRoot||root.id===selectedRoot.id)).every(root=>root.coverage==="complete");
  const totals:StorageBytes=storageTotals(union,complete), breadcrumbs:{id:string|null;name:string}[]=[{id:null,name:"All stores"}];
  if(selectedRoot) {
    breadcrumbs.push({id:selectedRoot.id,name:selectedRoot.label});
    if(parentEntry) {
      const chain:StorageFileEntry[]=[];let current:StorageFileEntry|undefined=parentEntry;const seenParents=new Set<string>();
      while(current && current.path){if(seenParents.has(current.id)||chain.length>256)throw Error("Storage hierarchy unavailable.");seenParents.add(current.id);chain.push(current);current=current.parentId?byId.get(current.parentId):undefined;}
      for(const entry of chain.reverse())breadcrumbs.push({id:entry.id,name:entry.name});
    }
  }
  const metric=filter.metric ?? "allocated";
  const sorted = sortStorageRows(selected.map(group=>group.node),filter,node=>node.area[metric]);
  deadline();
  return {parentId:filter.parentId||null,name:parentEntry?.name??selectedRoot?.label??"All stores",breadcrumbs,totals,nodes:sorted};
}
