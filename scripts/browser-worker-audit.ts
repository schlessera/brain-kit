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
  "packages/ui-kit/vitest.config.ts":"81d969b3022e0dfa6d82c59ff2f16ea8de923d650958b6d7f932e85f409a23ce",
  "scripts/browser-worker-boundary.ts":"fe7b63742370e3a6f2d8f99a77d23ce538d905744ad34d34e99ce342ff62d31b",
  "packages/ui-kit/tests/visual/worker-boundary-setup.ts":"80ba88b24fc1f0269d0f8a6b58520d715375b8af21ca636112f3294ffd7ad60f"
};
export function workerAuditIdentity(root:string,closure:InputClosure,selected:readonly Spec[]):string|undefined{
  try{
    if(!selected.length||selected.some(spec=>["ui-react-layout","ui-react-endurance"].includes(spec.project))||closure.unresolved.some(input=>input!==pdfWorkerInput)||!guards.every(file=>closure.files.includes(file))||closure.files.includes(workerAuditFile))return;
    const files=closure.files.map(file=>{
      const absolute=resolve(root,file),path=relative(root,absolute).replaceAll("\\","/");
      if(path!==file||isAbsolute(path)||path.startsWith("../")||realpathSync(absolute)!==absolute)throw new Error("Unowned worker audit input");
      const stat=lstatSync(absolute);
      if(stat.isDirectory()&&closure.directories?.includes(file))return [file,"directory"];
      if(!stat.isFile()||stat.isSymbolicLink())throw new Error("Nonregular worker audit input");
      return [file,stat.mode&0o777,createHash("sha256").update(readFileSync(absolute)).digest("hex")];
    }).sort((a,b)=>String(a[0]).localeCompare(String(b[0])));
    const inventory=selected.map(({file,project})=>({file,project})).sort((a,b)=>a.project.localeCompare(b.project)||a.file.localeCompare(b.file));
    return createHash("sha256").update(JSON.stringify({version:1,files,directories:[...(closure.directories??[])].sort(),external:closure.external??[],inventory})).digest("hex");
  }catch{return;}
}
export function hasAuditedWorkerBoundary(root:string,closure:InputClosure,selected:readonly Spec[]):boolean{
  try{
    if(Object.entries(enforcement).some(([file,hash])=>!closure.files.includes(file)||createHash("sha256").update(readFileSync(resolve(root,file))).digest("hex")!==hash))return false;
    const identity=workerAuditIdentity(root,closure,selected);if(!identity)return false;
    const manifestPath=resolve(root,workerAuditFile);if(realpathSync(manifestPath)!==manifestPath||!lstatSync(manifestPath).isFile())return false;
    const audit=JSON.parse(readFileSync(manifestPath,"utf8"));
    // The manifest is ordinary shared proof/tooling fingerprint material. It
    // cannot be included in its own domain hash. Success still requires fresh
    // registered jobs with enforced hooks; this metadata alone proves nothing.
    // Historical observation counts never pretend to cover the current domain.
    return audit.version===2&&audit.category==="browser"&&audit.identity===identity&&audit.guardedFreshProofRequired===true&&
      audit.sourceAudit?.version===1&&audit.sourceAudit?.selected===selected.length&&audit.sourceAudit?.files===closure.files.length&&
      Number.isSafeInteger(audit.historicalDiagnostic?.observed)&&audit.historicalDiagnostic.observed>0&&audit.historicalDiagnostic.workerAttempts===0;
  }catch{return false;}
}
