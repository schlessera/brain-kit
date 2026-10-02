import { readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { outputDirectory, sha256 } from "./provenance.ts";

const root=resolve(import.meta.dir,"../..");
const representative=["screens-chat-answer--chat-answer","evidence-searchresultcard--result-set","rank-five-reorder","capture-search-keyless","approval-roundtrip"];
type Artifact={id:string;files:Array<{file:string;sha256:string}>;readiness:Record<string,unknown>};

/** Only the app-generated principal nonce may differ in approval evidence. */
export function comparableApproval(value: unknown): unknown {
  const data=structuredClone(value) as {allow?:{decision?:{principalId?:string}};deny?:{decision?:{principalId?:string}}};
  const allow=data.allow?.decision?.principalId, deny=data.deny?.decision?.principalId;
  if(!allow || !deny || allow!==deny)throw new Error("approval-roundtrip: evidence lacks one correlated nonempty principal");
  data.allow!.decision!.principalId="<fixture-principal>";data.deny!.decision!.principalId="<fixture-principal>";
  return data;
}

export async function compareCaptures(first:string,second:string):Promise<{recipes:number;exact_files:number;varying_fields:string[]}> {
  const manifests=await Promise.all([first,second].map(async(directory)=>JSON.parse(await readFile(resolve(directory,"manifest.json"),"utf8")) as {artifacts:Artifact[]}));
  const ids=manifests[0].artifacts.map((entry)=>entry.id).sort();
  if(!ids.length || JSON.stringify(ids)!==JSON.stringify(manifests[1].artifacts.map((entry)=>entry.id).sort()))throw new Error("Reproducibility runs contain different or empty recipe sets");
  let exact=0;
  for(const artifact of manifests[0].artifacts) {
    const other=manifests[1].artifacts.find((entry)=>entry.id===artifact.id)!;
    if(!artifact.files.length || JSON.stringify(artifact.files.map((entry)=>entry.file).sort())!==JSON.stringify(other.files.map((entry)=>entry.file).sort()))throw new Error(`${artifact.id}: output set differs between runs`);
    for(const file of artifact.files) {
      const bytes=await Promise.all([first,second].map((directory)=>readFile(resolve(directory,file.file))));
      if(sha256(bytes[0])!==file.sha256 || sha256(bytes[1])!==other.files.find((entry)=>entry.file===file.file)!.sha256)throw new Error(`${artifact.id}: recorded artifact checksum differs from actual bytes`);
      if(artifact.id==="approval-roundtrip" && file.file.endsWith(".json")) {
        if(JSON.stringify(comparableApproval(JSON.parse(bytes[0].toString())))!==JSON.stringify(comparableApproval(JSON.parse(bytes[1].toString()))))throw new Error(`${artifact.id}: approval evidence changed beyond its principal nonce`);
      } else {
        if(!bytes[0].equals(bytes[1]))throw new Error(`${artifact.id}: ${file.file} differs between unchanged runs`);
        exact++;
      }
    }
    if(artifact.id==="rank-five-reorder" && JSON.stringify(artifact.readiness.frame_sha256)!==JSON.stringify(other.readiness.frame_sha256))throw new Error(`${artifact.id}: sampled gesture frames differ`);
  }
  return {recipes:ids.length,exact_files:exact,varying_fields:ids.includes("approval-roundtrip")?["approval evidence allow/deny decision.principalId, correlated within each run"]:[]};
}

async function run():Promise<void> {
  const argv=process.argv.slice(2),forwarded:string[]=[];
  let out="tmp/feature-capture-verification",all=false;
  for(let at=0;at<argv.length;at++) {
    if(argv[at]==="--all"){all=true;continue;}
    if(argv[at]==="--out"){out=argv[++at];if(!out)throw new Error("Missing verification --out value");continue;}
    if(argv[at]==="--font-cache"){const cache=argv[++at];if(!cache)throw new Error("Missing --font-cache value");forwarded.push("--font-cache",cache);continue;}
    throw new Error(`Unknown verification argument: ${argv[at]}`);
  }
  const directory=await outputDirectory(root,out);
  const destinations=[resolve(directory,"first"),resolve(directory,"second")];
  for(const destination of destinations) {
    const child=Bun.spawn([process.execPath,resolve(root,"scripts/capture.ts"),...(all?["--all"]:["--id",representative.join(",")]),"--out",destination,...forwarded],{cwd:root,stdout:"inherit",stderr:"inherit",stdin:"ignore"});
    if(await child.exited!==0)throw new Error("Reproducibility capture failed; no successful report was written");
  }
  const result=await compareCaptures(...destinations as [string,string]);
  await writeFile(resolve(directory,"reproducibility.json"),JSON.stringify(result,null,2)+"\n");
  console.log(JSON.stringify(result));
}
if(import.meta.main)run().catch((error)=>{console.error((error as Error).message);process.exitCode=1;});
