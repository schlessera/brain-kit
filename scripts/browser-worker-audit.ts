/** Capability audit for one measured selected domain; never a proof receipt. */
import {createHash} from "node:crypto";
import {lstatSync,readFileSync,realpathSync} from "node:fs";
import {isAbsolute,resolve,relative} from "node:path";
import type {InputClosure} from "./browser-input-closure";
import type {Spec} from "./proof-inputs";
export const workerAuditFile="scripts/browser-worker-audit.json";
export const pdfWorkerInput='Undeclared constructed input packages/ui-react/src/lib/pdf.ts: new Worker(url, { type: "module" })';
const guards=["packages/ui-kit/tests/visual/worker-boundary-setup.ts","scripts/browser-worker-boundary.ts"];
const enforcement:Record<string,string>={
  "packages/ui-kit/vitest.config.ts":"e724696a55955e9f32d396b2031214600086533c3f9b8baabcc1c6bb7311f1db",
  "scripts/browser-worker-boundary.ts":"fe7b63742370e3a6f2d8f99a77d23ce538d905744ad34d34e99ce342ff62d31b",
  "packages/ui-kit/tests/visual/worker-boundary-setup.ts":"80ba88b24fc1f0269d0f8a6b58520d715375b8af21ca636112f3294ffd7ad60f"
};
function workerAuditMaterial(root:string,closure:InputClosure,selected:readonly Spec[],diagnosticOnly=false){
  try{
    if(!selected.length||selected.some(spec=>["ui-react-layout","ui-react-endurance"].includes(spec.project))||(!diagnosticOnly&&closure.unresolved.some(input=>input!==pdfWorkerInput))||!guards.every(file=>closure.files.includes(file))||closure.files.includes(workerAuditFile))return;
    const files=closure.files.map(file=>{
      const absolute=resolve(root,file),path=relative(root,absolute).replaceAll("\\","/");
      if(path!==file||isAbsolute(path)||path.startsWith("../")||realpathSync(absolute)!==absolute)throw new Error("Unowned worker audit input");
      const stat=lstatSync(absolute);
      if(stat.isDirectory()&&closure.directories?.includes(file))return [file,"directory"];
      if(!stat.isFile()||stat.isSymbolicLink())throw new Error("Nonregular worker audit input");
      return [file,stat.mode&0o777,createHash("sha256").update(readFileSync(absolute)).digest("hex")];
    }).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
    const inventory=selected.map(({file,project})=>({file,project})).sort((a,b)=>a.project.localeCompare(b.project)||a.file.localeCompare(b.file));
    return {version:1,files,directories:[...(closure.directories??[])].sort(),external:closure.external??[],...(closure.nativeDiagram?{nativeDiagram:closure.nativeDiagram}:{}),inventory};
  }catch{return;}
}
export function workerAuditIdentity(root:string,closure:InputClosure,selected:readonly Spec[]):string|undefined{
  const material=workerAuditMaterial(root,closure,selected);
  return material?createHash("sha256").update(JSON.stringify(material)).digest("hex"):undefined;
}
/** Diagnostics contain only the same bounded repository-relative identities used
 * by admission. They never authorize execution or disclose source contents. */
export function inspectWorkerAudit(root:string,closure:InputClosure,selected:readonly Spec[]){
  const material=workerAuditMaterial(root,closure,selected);
  const actualIdentity=material?createHash("sha256").update(JSON.stringify(material)).digest("hex"):undefined;
  const diagnosticMaterial=material??workerAuditMaterial(root,closure,selected,true);
  let audit:any;
  try{
    const path=resolve(root,workerAuditFile);
    if(realpathSync(path)===path&&lstatSync(path).isFile())audit=JSON.parse(readFileSync(path,"utf8"));
  }catch{ /* Missing or malformed evidence cannot qualify the domain. */ }
  const expectedIdentity=typeof audit?.identity==="string"&&/^[a-f0-9]{64}$/.test(audit.identity)?audit.identity:undefined;
  const enforcementValid=diagnosticMaterial&&Object.entries(enforcement).every(([path,hash])=>diagnosticMaterial.files.some(file=>file[0]===path&&file[2]===hash));
  const qualified=Boolean(actualIdentity&&enforcementValid&&audit?.version===2&&audit.category==="browser"&&expectedIdentity===actualIdentity&&audit.guardedFreshProofRequired===true&&
    audit.sourceAudit?.version===1&&audit.sourceAudit?.selected===selected.length&&audit.sourceAudit?.files===closure.files.length&&
    Number.isSafeInteger(audit.historicalDiagnostic?.observed)&&audit.historicalDiagnostic.observed>0&&audit.historicalDiagnostic.workerAttempts===0);
  // Unknowns never gain admission material. A separate bounded inspection may
  // still report public path/mode/blob identities without granting ownership.
  const labels=closure.unresolved.slice(0,64).map(input=>{
    const prefixes:[[string,string],...Array<[string,string]>]=[["Undeclared constructed input ","undeclared-constructed-input"],["Undeclared input ","undeclared-input"],["Unresolved import ","unresolved-import"],["Unsupported input alias ","unsupported-input-alias"]];
    const prefix=prefixes.find(([text])=>input.startsWith(text));
    const owner=prefix?input.slice(prefix[0].length).split(":")[0]:undefined;
    return{code:prefix?.[1]??"unsupported-input",...(owner&&owner.length<256&&/^[A-Za-z0-9_./@-]+$/.test(owner)&&closure.files.includes(owner)?{owner}:{})};
  });
  const expectedNative=Object.fromEntries(["source","installation","runtime"].flatMap(key=>typeof audit?.sourceAudit?.native?.[key]==="string"&&/^[a-f0-9]{64}$/.test(audit.sourceAudit.native[key])?[[key,audit.sourceAudit.native[key]]]:[]));
  const diagnostic={version:1,expectedIdentity,actualIdentity,enforcementValid:Boolean(enforcementValid),admissionSupported:Boolean(material),selected:selected.length,files:closure.files.length,unresolvedCount:closure.unresolved.length,unresolved:labels,expectedNative,native:closure.nativeDiagramDiagnostic,material:diagnosticMaterial};
  if(JSON.stringify(diagnostic).length>768*1024)return{qualified:false,diagnostic:{version:1,expectedIdentity,actualIdentity,reason:"bounded manifest exceeded"}};
  return{qualified,diagnostic};
}
export class WorkerAuditError extends Error{
  constructor(readonly diagnostic:ReturnType<typeof inspectWorkerAudit>["diagnostic"]){super("Unresolved immutable browser inputs require fresh proof: unvalidated selected Worker capability audit");}
}
export function logWorkerAuditDiagnostic(error:unknown){
  if(!(error instanceof WorkerAuditError))return;
  const {material,...header}=error.diagnostic as {material?:unknown;[key:string]:unknown};
  console.log("BRAIN_WORKER_AUDIT_DIAGNOSTIC "+JSON.stringify(header));
  const text=JSON.stringify(material??null);
  for(let offset=0;offset<text.length;offset+=8192)console.log("BRAIN_WORKER_AUDIT_MANIFEST "+JSON.stringify({offset,total:text.length,chunk:text.slice(offset,offset+8192)}));
}
export function hasAuditedWorkerBoundary(root:string,closure:InputClosure,selected:readonly Spec[]):boolean{
  return inspectWorkerAudit(root,closure,selected).qualified;
}
