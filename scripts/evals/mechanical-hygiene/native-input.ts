/** Prevent a live native driver from admitting arbitrary or private directory content. */
import { realpathSync } from "node:fs";
import { nativeSurfaceFiles } from "./native-surface";
import { observeTree, type TreeEvidence } from "./observer";
import { workload } from "./workload";
import { document, TODAY } from "./fixture";
import type { Phase } from "./collector";
export function assertNativeInput(root:string,caseId:string,size:number,phase:Phase,prepared?:TreeEvidence){
  root=realpathSync(root);
  if(!root.startsWith("/tmp/brain-mechanical-hygiene-")||![20,1000].includes(size))throw Error("Only owned materialized fictional workload brains may be admitted");
  const fixture=workload.find(f=>f.id===caseId);
  if(!fixture||fixture.timezone!==Intl.DateTimeFormat().resolvedOptions().timeZone)throw Error("Frozen case or actual worker timezone differs");
  const files={...(phase==="repeat"?fixture.expected:fixture.files)};
  for(let i=0;i<size-Object.keys(fixture.files).length;i++)files[`context/unchanged-${i}.md`]=document(`Sail inspection ${i}`,TODAY,TODAY,`Odysseus checks rope ${i}.`);
  const tree=observeTree(root);
  if(prepared&&JSON.stringify(tree)!==JSON.stringify(prepared))throw Error("Actual phase input changed after the complete source snapshot");
  if(Object.values(tree).some(entry=>!["file","directory"].includes(entry.kind)))throw Error("Native input contains a symlink or special file");
  for(const [path,text]of Object.entries(files))if((tree[path]?.bytesBase64!==Buffer.from(text).toString("base64")||tree[path]?.mode!==0o644))throw Error("Actual native source differs from the approved phase input");
  const expectedMembers=new Set([...Object.keys(files),...Object.keys(nativeSurfaceFiles(new URL("../../../",import.meta.url).pathname,fixture)),"brain.db","brain.db-wal","brain.db-shm",".brain/scratch/hygiene-extra.json",".brain/scratch/hygiene-fixed.json"]);
  if(phase==="repeat")for(const name of ["_index.md","open.md","snoozed.md","dismissed.md","resolved.md","last-run.md"])expectedMembers.add(`context/hygiene/${name}`);
  for(const [path,entry]of Object.entries(tree))if(entry.kind==="directory"&&!Array.from(expectedMembers).some(member=>member.startsWith(`${path}/`)))throw Error("Native input has an unapproved empty directory");
  if(phase!=="repeat")for(const path of Object.keys(files))if(tree[path].mtimeMs!==Date.parse(fixture.files[path]?fixture.mtime??"2026-07-11T23:30:00Z":"2026-07-11T23:30:00Z"))throw Error("Original source mtime differs from the frozen input");
  const other=Object.keys(tree).filter(path=>tree[path].kind==="file"&&!files[path]&&!["brain.config.json","AGENTS.md","bin/brain","brain.db","brain.db-wal","brain.db-shm",".claude/skills/content-hygiene/SKILL.md",".brain/scratch/hygiene-extra.json",".brain/scratch/hygiene-fixed.json"].includes(path));
  if(other.some(path=>phase!=="repeat"||!new Set(["_index.md","open.md","snoozed.md","dismissed.md","resolved.md","last-run.md"].map(name=>`context/hygiene/${name}`)).has(path)))throw Error("Native input has an unapproved source member");
  const source=new URL("../../../",import.meta.url).pathname;
  for(const [path,text]of Object.entries(nativeSurfaceFiles(source,fixture)))if(tree[path]?.bytesBase64!==Buffer.from(text).toString("base64")||tree[path]?.mode!==(path==="bin/brain"?0o755:0o644))throw Error("Native CLI/config/skill/context surface differs from the frozen materializer");
}
