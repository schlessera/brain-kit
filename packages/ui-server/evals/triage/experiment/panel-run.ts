/** Explicit root live entry; uses unchanged donor raw APIs, never an agent harness. */
import { readFileSync, writeFileSync, mkdirSync, existsSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { sha } from "./adapter";
import { CORPUS } from "./corpus";
import { frozenBinding, ROOT } from "./binding";
import { collectLabelPanel, type PanelPhysical } from "./label-panel";
import { admitExactPackets, type ReviewReceipt } from "./review-admission";
import { type ExpectedReview, type RuntimeIdentity } from "./review-evidence";
import { PanelBudget, validatePanelPolicy, type RootPanelPolicy, type PanelReservation } from "./panel-budget";
import { type ReviewBinding } from "./paid-policy";
import { consumeGrant, validGrantEvidence } from "./grant";

export function requireReviewedSource(expected:Array<ExpectedReview & {key:string}>,receipts:ReviewReceipt[],current:{binding:ReviewBinding;runtime:RuntimeIdentity}){
  if(expected.some(p=>p.freezeSha!==current.binding.freezeSha || p.promptSha!==current.binding.promptSha ||
    JSON.stringify(p.binding)!==JSON.stringify(current.binding) || JSON.stringify(p.runtime)!==JSON.stringify(current.runtime)) || !admitExactPackets(expected,receipts))throw Error("Exact-source independent complementary approval required before any panel request");
}
export async function runPanel(options:{sidecar:string;output:string;policy:RootPanelPolicy;policySha:string;
  expected:Array<ExpectedReview & {key:string}>;reviews:ReviewReceipt[]}){
  if(process.env.BRAIN_TRIAGE_PANEL_DISPATCH!=="848-root-approved")throw Error("Explicit root panel admission required");
  const bound=frozenBinding(options.sidecar);validatePanelPolicy(options.policy,bound.binding);
  if(sha(JSON.stringify(options.policy))!==options.policySha)throw Error("Root panel policy changed");
  requireReviewedSource(options.expected,options.reviews,bound);
  if(JSON.stringify(bound.input.corpus)!==JSON.stringify(CORPUS))throw Error("Frozen40-source corpus differs");
  const rubric=readFileSync(join(ROOT,"packages/ui-server/evals/triage/prompt.txt"),"utf8");if(rubric!==bound.input.labelPanel.rubric)throw Error("Unchanged donor rubric differs");
  // Root remaining allocation includes every prior attempt/review and aggregate reservation.
  const priorUpper=options.reviews.reduce((sum,review)=>{
    const execution=JSON.parse(readFileSync(join(review.evidence!.directory,"execution.json"),"utf8"));
    if(!execution.paidAdmission)throw Error("Prior review conservative allocation receipt required");
    return sum+execution.paidAdmission.entries.reduce((n:number,e:PanelReservation)=>n+(e.status==="complete"?e.pricedUpperUsd!:e.reservedUpperUsd),0);
  },0);
  const fakePhysical=bound.input.verification.rawPanelControl?.receipt?.physical;
  if(!Array.isArray(fakePhysical) || fakePhysical.length!==90)throw Error("Frozen literal donor request proof absent");
  const hashes=new Set<string>(fakePhysical.map((r:PanelPhysical)=>{if(!r.requestBody || sha(r.requestBody)!==r.requestSha)throw Error("Malformed frozen donor request");return r.requestSha!;}));
  if(hashes.size!==30)throw Error("Complete model/batch donor request coverage absent");
  if(!Number.isFinite(priorUpper)||priorUpper<0||priorUpper+options.policy.remainingUpperUsd>15)throw Error("Panel remaining allocation ignores prior review spending");
  if(existsSync(options.output))throw Error("Fresh protected panel output required");bound.verify();
  const startedAtUtc=new Date().toISOString(),grant=consumeGrant(options.policy,bound.binding);
  mkdirSync(options.output,{mode:0o700});writeFileSync(join(options.output,"grant.json"),readFileSync(options.policy.consumedMarkerPath),{mode:0o600});
  const physical:PanelPhysical[]=[],execution:any={kind:"provider-raw-panel",transport:"global-fetch",binding:bound.binding,policy:options.policy,policySha:options.policySha,
    priorReviewUpperUsd:priorUpper,reviewEvidence:options.reviews.map(r=>r.evidence),startedAtUtc,grantClaimSha:grant.sha,entries:[],failure:null,finished:false,invoiceUsd:null};
  const save=()=>writeFileSync(join(options.output,"execution.json"),JSON.stringify(execution,null,2),{mode:0o600});
  const budget=new PanelBudget(options.policy,bound.binding,hashes,entries=>{execution.entries=entries;save();});
  if(!budget.priorFits(priorUpper))throw Error("Panel remaining allocation ignores prior review spending");save();
  let active:number|null=null,result:Awaited<ReturnType<typeof collectLabelPanel>>|null=null;
  try{result=await collectLabelPanel(CORPUS,rubric,globalThis.fetch,{
    beforePhysical:r=>{bound.verify();if(!validGrantEvidence(options.policy,bound.binding,readFileSync(join(options.output,"grant.json")),grant.sha,startedAtUtc,Date.now()))throw Error("Consumed exact panel grant changed");active=budget.reserve(r);},
    onPhysical:r=>{physical.push(r);writeFileSync(join(options.output,"physical.json"),JSON.stringify(physical,null,2),{mode:0o600});},
    afterPhysical:r=>{if(active!==null){const index=active;active=null;if(r.transportDispatched)budget.settle(index,r);else budget.unknown(index);}},
  });}catch{execution.failure="Panel stopped after source/auth/model/usage/EOF/budget admission failure";}
  finally{execution.finished=true;execution.entries=budget.entries;save();writeFileSync(join(options.output,"result.json"),JSON.stringify(result,null,2),{mode:0o600});}
  return{execution,result,physical};
}
if(import.meta.main){
  const [sidecar,policyPath,policySha,reviewsPath,output]=process.argv.slice(2);
  if(!sidecar||!policyPath||!policySha||!reviewsPath||!output)throw Error("Frozen sidecar/root panel policy+SHA/review bundle/fresh output required");
  const stat=lstatSync(policyPath);if(!stat.isFile()||stat.isSymbolicLink()||(stat.mode&0o077))throw Error("Root allocation must be private literal file");
  const policy=JSON.parse(readFileSync(policyPath,"utf8")),reviews=JSON.parse(readFileSync(reviewsPath,"utf8"));
  const observed=await runPanel({sidecar,policy,policySha,output,expected:reviews.expected,reviews:reviews.receipts});
  console.log(JSON.stringify({physical:observed.physical.length,complete:observed.result?.coverageComplete??false,failure:observed.execution.failure,invoiceUsd:null}));
  if(observed.execution.failure || !observed.result?.coverageComplete)process.exitCode=1;
}
