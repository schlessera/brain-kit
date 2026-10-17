import { lstatSync } from "node:fs";
import { basename,dirname,join } from "node:path";
import { markdownFences,resolveWritable } from "@schlessera/brain/module";
import type { HygieneContext,AuditIssue } from "@schlessera/brain";
import { checkDiagram } from "./check.js";
import { parseDiagram } from "./svg-model.js";
import {readRegularText} from "./regular-text.js";
import { derivedIdentity,sourceHash } from "./derived.js";
/** Inspect fresh Markdown, not stale indexed content or an authoritative build database. */
export async function checkDiagramHygiene(ctx:HygieneContext):Promise<AuditIssue[]>{
 const documents=ctx.queries.findIndexDocuments({pathSuffix:".md",excludeStatus:"archived"});if(!documents.ok)throw Error(`Cannot inspect diagrams: ${documents.error.code}`);
 const findings:AuditIssue[]=[];
 for(const doc of documents.value){const absolute=resolveWritable(ctx.root,doc.path);if(!absolute){findings.push({path:doc.path,severity:"warning",category:"diagram-source",message:"Diagram source is outside the brain or cannot be resolved"});continue;}
  let markdown:string;try{markdown=readRegularText(absolute,1024*1024);}catch(error){findings.push({path:doc.path,severity:"warning",category:"diagram-source",message:`Cannot inspect diagram source: ${error instanceof Error?error.message:String(error)}`});continue;}
  const ids=new Set<string>();for(const fence of markdownFences(markdown).filter(f=>f.language==="diagram")){const checked=checkDiagram(fence.value);if(!checked.valid){findings.push({path:doc.path,severity:"warning",category:"diagram-invalid",message:`Diagram at line ${fence.line} fails check: ${checked.errors.map(e=>`${e.path}: ${e.message}`).join("; ")}`,suggestion:`Run brain diagram check ${doc.path}`});continue;}
   const spec=parseDiagram(fence.value);if(!spec.id)continue;if(ids.has(spec.id)){findings.push({path:doc.path,severity:"warning",category:"diagram-invalid",message:`Repeated diagram id '${spec.id}'`});continue;}ids.add(spec.id);
   const pair=["light","dark"].map(theme=>join(dirname(doc.path),`${spec.id}.${theme}.svg`)),present=pair.map(path=>{const parent=resolveWritable(ctx.root,dirname(path));if(!parent)return {absolute:null,entry:undefined,unsafe:true};const absolute=join(parent,basename(path));return {absolute,entry:lstatSync(absolute,{throwIfNoEntry:false}),unsafe:false};});
   if(present.every(item=>!item.entry&&!item.unsafe))continue;
   let stale=present.some(item=>item.unsafe||!item.entry||!item.entry.isFile());
   for(const item of present){if(!item.absolute||!item.entry?.isFile())continue;try{const identity=derivedIdentity(readRegularText(item.absolute,8*1024*1024));if(!identity||identity.id!==spec.id||identity.document!==sourceHash(doc.path)||identity.source!==sourceHash(fence.value))stale=true;}catch{stale=true;}}
   if(stale)findings.push({path:doc.path,severity:"warning",category:"diagram-stale",message:`Derived light/dark pair for '${spec.id}' is missing, unrelated or older than its fence`,suggestion:`Run brain diagram build ${doc.path}`});
  }
 }
 return findings;
};
