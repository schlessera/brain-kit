/** Conservative raw-API panel allocation, independent of donor zero-default costs. */
import { sha } from "./adapter";
import { LABEL_PANEL, type PanelPhysical } from "./label-panel";
import { type ReviewBinding } from "./paid-policy";
import { assertGrantPath, validGrantTime, type GrantPolicy } from "./grant";
export const RAW_AUTHORIZATION = "https://github.com/schlessera/brain-kit/issues/838#issuecomment-6025723682";
export const PANEL_BOUNDS = Object.freeze({
  // Native review uses the separately ruled8/20 bound. API fees here are upper bounds, not list estimates.
  "claude-sonnet-5-5": { inputTokens: 1_000_000, inputRate: 8, outputRate: 20, source: "https://platform.claude.com/docs/en/models/sonnet-5-5/overview" },
  // Long-context write5/output15, Fast2x and regional1.1x. Ultrafast is Responses-only; donor endpoint is Chat Completions.
  "gpt-6.1-sol": { inputTokens: 1_050_000, inputRate: 11, outputRate: 33, source: "https://developers.openai.com/api/docs/models/gpt-6.1-sol" },
  // Includes current priority upper through2026-12-31; no explicit cache-storage/tool endpoint.
  "gemini-3.8-flash": { inputTokens: 1_048_576, inputRate: 1.35, outputRate: 6.75, source: "https://ai.google.dev/gemini-api/docs/pricing" },
});
export interface RootPanelPolicy extends ReviewBinding,GrantPolicy {
  version: 1; issue: 848; authorizationUrl: string; selectionUrl: string; basis: "actual additional billed charges";
  perIssueCapUsd: 15; aggregateCapUsd: 150; remainingUpperUsd: number; expiresAt: string; maxPhysicalRequests: 180;
  boundsSha: string; invoiceUsd: null;
}
const count = (n: unknown): n is number => typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
const equal = (a: unknown,b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function validatePanelPolicy(p: RootPanelPolicy, binding: ReviewBinding, now=Date.now()) {
  assertGrantPath(p);
  if (!p || p.version!==1 || p.issue!==848 || p.authorizationUrl!==RAW_AUTHORIZATION || p.selectionUrl!==LABEL_PANEL.selection ||
    p.basis!=="actual additional billed charges" || p.perIssueCapUsd!==15 || p.aggregateCapUsd!==150 || p.maxPhysicalRequests!==180 || p.invoiceUsd!==null ||
    p.boundsSha!==sha(JSON.stringify(PANEL_BOUNDS)) || !Number.isFinite(p.remainingUpperUsd) || p.remainingUpperUsd<0 || p.remainingUpperUsd>15 ||
    !validGrantTime(p,now) || Date.parse(p.expiresAt)>=Date.parse("2027-01-01T00:00:00Z") ||
    (["freezeSha","inputSha","protocolSha","runtimeSha","proofSha","promptSha"] as const).some(key=>!/^[a-f0-9]{64}$/.test(binding?.[key]) || p[key]!==binding[key])) throw Error("Missing, expired, mismatched or invalid root panel allocation");
}
export interface PanelReservation {
  index:number; at:number; requestSha:string; judge:string; inputBound:number; outputBound:8000; reservedUpperUsd:number;
  status:"reserved"|"complete"|"unknown"; pricedUpperUsd:number|null; rawUsage:unknown; invoiceUsd:null;
}
export class PanelBudget {
  private records:PanelReservation[]=[];private blocked=false;
  get entries(){return structuredClone(this.records);}
  constructor(readonly policy:RootPanelPolicy,readonly binding:ReviewBinding,private readonly requestHashes:ReadonlySet<string>,private readonly persist:(records:PanelReservation[])=>void,private readonly clock=Date.now) {
    validatePanelPolicy(policy,binding,clock());this.policy=Object.freeze(structuredClone(policy));this.binding=Object.freeze(structuredClone(binding));
  }
  usedUpper(){return this.records.reduce((sum,r)=>sum+(r.status==="complete"?r.pricedUpperUsd!:r.reservedUpperUsd),0);}
  reserve(r:PanelPhysical){
    validatePanelPolicy(this.policy,this.binding,this.clock());
    if(this.blocked || this.records.some(r=>r.status==="reserved") || this.records.length>=180)throw Error("Prior unknown/inflight panel call or request bound");
    const model=LABEL_PANEL.models.find(m=>m.id===r.judge),bounds=PANEL_BOUNDS[r.judge as keyof typeof PANEL_BOUNDS];
    if(!model || !bounds || !r.requestBody || sha(r.requestBody)!==r.requestSha || !r.requestSha || !this.requestHashes.has(r.requestSha))throw Error("Exact frozen donor request absent");
    const body=JSON.parse(r.requestBody),limit=model.provider==="anthropic"?body.max_tokens:model.provider==="openai"?body.max_completion_tokens:body.generationConfig?.maxOutputTokens;
    if(limit!==8000 || (model.provider!=="gemini" && body.model!==r.judge) || body.tools?.length || body.service_tier!=null || body.serviceTier!=null || body.inference_geo!=null || body.speed!=null)throw Error("Unsupported donor model/bound/pricing modifier");
    const reservedUpperUsd=(bounds.inputTokens*bounds.inputRate+8000*bounds.outputRate)/1e6;
    if(this.usedUpper()+reservedUpperUsd>this.policy.remainingUpperUsd)throw Error("Next panel physical exceeds remaining allocation");
    const entry:PanelReservation={index:this.records.length,at:this.clock(),requestSha:r.requestSha,judge:r.judge,inputBound:bounds.inputTokens,outputBound:8000,reservedUpperUsd,status:"reserved",pricedUpperUsd:null,rawUsage:null,invoiceUsd:null};
    this.records.push(entry);try{this.persist(this.entries);}catch(e){this.blocked=true;throw e;}return entry.index;
  }
  settle(index:number,r:PanelPhysical){
    const entry=this.records[index];if(!entry || entry.status!=="reserved")throw Error("Unknown panel reservation");
    try {
      const bounds=PANEL_BOUNDS[entry.judge as keyof typeof PANEL_BOUNDS];
      if(!r.transportDispatched || !r.responseComplete || r.readerCleanup!=="natural-eof" || !r.usageComplete || r.servedModel!==entry.judge || r.requestSha!==entry.requestSha ||
        !r.responseBase64 || sha(Buffer.from(r.responseBase64,"base64"))!==r.responseSha || !count(r.tokens.input) || !count(r.tokens.output))throw Error("Unknown required panel usage/model/EOF receipt");
      const body=JSON.parse(Buffer.from(r.responseBase64,"base64").toString("utf8")),nativeModel=entry.judge==="gemini-3.8-flash"?body.modelVersion:body.model;
      const raw=entry.judge==="gemini-3.8-flash"?body.usageMetadata:body.usage;
      if(nativeModel!==entry.judge || !raw || !equal(raw,r.rawUsage))throw Error("Literal panel model/usage differs from claimed receipt");
      let input=entry.judge==="claude-sonnet-5-5"?raw.input_tokens:entry.judge==="gpt-6.1-sol"?raw.prompt_tokens:raw.promptTokenCount;
      const output=entry.judge==="claude-sonnet-5-5"?raw.output_tokens:entry.judge==="gpt-6.1-sol"?raw.completion_tokens:
        count(raw.candidatesTokenCount)&&count(raw.thoughtsTokenCount)?raw.candidatesTokenCount+raw.thoughtsTokenCount:null;
      if(!count(input)||!count(output)||output!==r.tokens.output || input!==r.tokens.input)throw Error("Unknown or inconsistent literal token counts");
      const total=entry.judge==="gemini-3.8-flash"?raw.totalTokenCount:entry.judge==="gpt-6.1-sol"?raw.total_tokens:undefined;
      if(total!==undefined && (!count(total)||total!==input+output))throw Error("Inconsistent literal panel token total");
      if(entry.judge==="claude-sonnet-5-5"){
        if(!count(raw.cache_read_input_tokens)||!count(raw.cache_creation_input_tokens)||raw.cache_read_input_tokens!==r.tokens.cacheRead||raw.cache_creation_input_tokens!==r.tokens.cacheWrite)throw Error("Unknown Anthropic aggregate cache usage");input+=raw.cache_read_input_tokens+raw.cache_creation_input_tokens;
      }
      if(!Number.isSafeInteger(input)||input>entry.inputBound || output>8000)throw Error("Panel usage exceeds reserved bound");
      // Every present modifier must pass before releasing the physical reservation.
      // Literal failed raw response/usage stays in the separately durable physical receipt.
      const tiers=[body.service_tier,raw.service_tier,raw.serviceTier,r.headers["service-tier"]];
      const geographies=[body.inference_geo,raw.inference_geo];
      if(tiers.some(t=>t!=null && !["default","standard","ON_DEMAND","STANDARD"].includes(t)) ||
        geographies.some(g=>g!=null&&! ["global","us","not_available"].includes(g)) ||
        [body.speed,body.fast_mode,raw.speed,raw.fast_mode].some(v=>v!=null))throw Error("Unsupported observed panel pricing modifier");
      // Standard ceilings verified2026-10-08: known US1.1x, longest cache-write TTL.
      // Missing GPT tier remains at the full Fast/context bound; no inferred Standard.
      // https://platform.claude.com/docs/en/about-claude/pricing
      // https://developers.openai.com/api/docs/models/gpt-6.1-sol
      const pricedUpperUsd=entry.judge==="claude-sonnet-5-5"
        ?(raw.input_tokens*2.2+raw.cache_read_input_tokens*.11+raw.cache_creation_input_tokens*4.4+output*11)/1e6
        :entry.judge==="gpt-6.1-sol" && tiers.some(t=>["default","standard"].includes(t))
          ?(input*5.5+output*16.5)/1e6 // All input at longest write rate covers absent cache detail.
          :(input*bounds.inputRate+output*bounds.outputRate)/1e6;
      const completed:PanelReservation={...entry,status:"complete",pricedUpperUsd,rawUsage:structuredClone(raw)};
      this.persist(this.records.map(row=>structuredClone(row.index===index?completed:row)));Object.assign(entry,completed);
    }catch(e){this.blocked=true;if(entry.status==="reserved"){entry.status="unknown";this.persist(this.entries);}throw e;}
  }
  unknown(index:number){const entry=this.records[index];if(!entry || entry.status!=="reserved")throw Error("Unknown panel reservation");entry.status="unknown";this.blocked=true;this.persist(this.entries);}
  priorFits(priorUpper:number){return Number.isFinite(priorUpper)&&priorUpper>=0&&priorUpper+this.policy.remainingUpperUsd<=15;}
}
export function reparsePanelBudget(policy:RootPanelPolicy,binding:ReviewBinding,hashes:ReadonlySet<string>,entries:PanelReservation[],calls:PanelPhysical[]){
  if(!entries.length || entries.length!==calls.filter(c=>c.transportDispatched).length)return false;
  try {let at=entries[0]!.at;const b=new PanelBudget(policy,binding,hashes,()=>{},()=>at);
    for(const call of calls.filter(c=>c.transportDispatched)){const e=entries[b.entries.length]!;if(!Number.isFinite(e.at)||e.at>Date.now())return false;at=e.at;b.settle(b.reserve(call),call);}return equal(b.entries,entries);
  }catch{return false;}
}
