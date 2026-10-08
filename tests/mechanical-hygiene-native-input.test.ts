import { test, expect } from "bun:test";
import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { prepare } from "../scripts/evals/mechanical-hygiene/fixture";
import { workload } from "../scripts/evals/mechanical-hygiene/workload";
import { installNativeSurface } from "../scripts/evals/mechanical-hygiene/native-surface";
import { assertNativeInput } from "../scripts/evals/mechanical-hygiene/native-input";
import { observeTree } from "../scripts/evals/mechanical-hygiene/observer";
import { effectCandidates } from "../scripts/evals/mechanical-hygiene/effect-candidates";
import { projectNativeLogDescriptions } from "../scripts/evals/mechanical-hygiene/native-log-expectations";
import { comparisonSchedule } from "../scripts/evals/mechanical-hygiene/compare-native";
import { chunks } from "../scripts/evals/mechanical-hygiene/review-packets";
import { verifiedPairs } from "../scripts/evals/mechanical-hygiene/native-runtime";
const source=new URL("../",import.meta.url).pathname;
const fixture=workload.find(item=>item.id==="ogygia-raft-status")!;
async function utc<T>(run:()=>T|Promise<T>){const old=process.env.TZ;process.env.TZ="UTC";try{return await run();}finally{if(old===undefined)delete process.env.TZ;else process.env.TZ=old;}}
for(const mutation of ["directory","mtime","bytes"] as const)test(`actual materialized native input rejects changed ${mutation}`,async()=>utc(()=>{
  const env=prepare(fixture,20-Object.keys(fixture.files).length);
  try{
    installNativeSurface(env.root,source,fixture);const before=observeTree(env.root);
    expect(()=>assertNativeInput(env.root,fixture.id,20,"dry-run",before)).not.toThrow();
    if(mutation==="directory")mkdirSync(join(env.root,"unapproved-empty"));
    if(mutation==="mtime")utimesSync(join(env.root,Object.keys(fixture.files)[0]),new Date("2026-07-09T00:00:00Z"),new Date("2026-07-09T00:00:00Z"));
    if(mutation==="bytes")writeFileSync(join(env.root,Object.keys(fixture.files)[0]),"Odysseus changed the approved bytes.\n");
    expect(()=>assertNativeInput(env.root,fixture.id,20,"dry-run",before)).toThrow("Actual phase input changed");
    expect(()=>assertNativeInput(env.root,fixture.id,20,"dry-run")).toThrow(mutation==="directory"?"unapproved empty directory":mutation==="mtime"?"Original source mtime":"Actual native source differs");
  }finally{env.close();}
}));

test("actual full reconciler log projection changes only approved description slots",async()=>utc(async()=>{
  const row=(await effectCandidates(fixture.id,20)).rows[0],changed=Object.keys(fixture.expected).filter(path=>fixture.expected[path]!==fixture.files[path]);
  expect(changed.length).toBeGreaterThan(0);const fixes=changed.map(path=>({path,fix:"Align the authored Status.\nPreserve the detail source."}));
  const projected=projectNativeLogDescriptions(row.expectedFiles,changed,fixes);
  expect(projected.descriptionSemanticApproval).toBe(false);
  const before=Buffer.from(row.expectedFiles["context/hygiene/last-run.md"].bytesBase64,"base64").toString(),after=Buffer.from(projected.expected["context/hygiene/last-run.md"].bytesBase64,"base64").toString();
  expect(after).toBe(before.replace(`- \`${changed[0]}\`: Mechanical prototype repair`,`- \`${changed[0]}\`: Align the authored Status. Preserve the detail source.`));
  for(const [path,entry]of Object.entries(row.expectedFiles))if(path!=="context/hygiene/last-run.md")expect(projected.expected[path]).toEqual(entry);
  expect(()=>projectNativeLogDescriptions(row.expectedFiles,changed,[{path:"context/unauthorized.md",fix:"Wrong target"}])).toThrow("different source effect");
  expect(()=>projectNativeLogDescriptions(row.expectedFiles,changed,[...fixes,...fixes])).toThrow("cardinality");
  expect(()=>projectNativeLogDescriptions(row.expectedFiles,changed,[{...fixes[0],observedLog:"Never authority"}])).toThrow("Malformed");
}));

test("full fixed comparison schedule preserves all cases sizes repetitions and phase denominators",()=>{
  const schedule=comparisonSchedule();expect(schedule).toHaveLength(216);
  expect(new Set(schedule.map(item=>`${item.caseId}/${item.size}/${item.repetition}/${item.arm}`)).size).toBe(216);
  for(const arm of ["current-skill","mechanical-prototype"]){const selected=schedule.filter(item=>item.arm===arm);expect(selected).toHaveLength(108);expect(new Set(selected.map(item=>item.caseId)).size).toBe(18);}
});

test("review chunking is lossless over Unicode CRLF and every indexed part",()=>{
  const text="μ Odysseus\r\n".repeat(16000),parts=chunks("fictional-world",text,"source");
  expect(parts.length).toBeGreaterThan(1);expect(parts.map(part=>part.text).join("")).toBe(text);
  expect(parts.every((part,index)=>part.part===index+1&&part.parts===parts.length&&part.sha===parts[0].sha)).toBe(true);
  expect(verifiedPairs).toEqual({"0.3.292":"2.1.292","0.3.293":"2.1.293"});
});


test("actual prototype collector retains the changed full tree when apply effects fail",async()=>utc(async()=>{
  const {effectCandidates}=await import("../scripts/evals/mechanical-hygiene/effect-candidates");
  const {collectPrototypeCycle}=await import("../scripts/evals/mechanical-hygiene/native-cycle");
  const {mkdtempSync,rmSync,readFileSync}=await import("node:fs");
  const destination=mkdtempSync("/tmp/hygiene-prototype-partial-");
  try {
    const candidate=(await effectCandidates("ogygia-mtime-day",20)).rows[0];
    const fixture=workload.find(f=>f.id==="ogygia-mtime-day")!,path=Object.keys(fixture.files)[0];
    candidate.expectedFiles[path].bytesBase64=Buffer.from(fixture.files[path]).toString("base64");
    await expect(collectPrototypeCycle(fixture.id,20,candidate,destination)).rejects.toThrow("Matched prototype phase effects rejected");
    const partial=JSON.parse(readFileSync(join(destination,"phases.json"),"utf8"));
    expect(partial.complete).toBe(false);expect(String(partial.failure)).toContain("phase effects rejected");
    expect(partial.rows).toHaveLength(2);expect(partial.rows[1].after[path].bytesBase64).toBe(Buffer.from(fixture.expected[path]).toString("base64"));
    expect(partial.rows[1].effects.accepted).toBe(false);
  } finally {rmSync(destination,{recursive:true,force:true});}
}));
