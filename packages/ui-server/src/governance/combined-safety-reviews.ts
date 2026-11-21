/** Ordered cross-authority review. The Settings payload durably binds the exact
 * single-verdict request before publication; neither authority claims atomicity. */
import type { Database } from "bun:sqlite";
import { z } from "zod";
import { safetyReviewBodySchema, safetyFuturePrepareSchema, safetyFutureCommitSchema, safetyFutureStatusSchema } from "@schlessera/brain-ui-sdk/schemas";
import type { Principal } from "../db/principals.js";
import { TrustSettingsError, type TrustSettings, type Receipt } from "../brain/trust-settings.js";
import { OwnerSafetyReviews } from "./owner-safety-reviews.js";
import { eligible } from "./safety-reviews.js";
export const combinedPrepareSchema=safetyFuturePrepareSchema;
export const combinedCommitSchema=safetyFutureCommitSchema;
export class CombinedSafetyReviews {
 constructor(private readonly db:Database,private readonly reviews:OwnerSafetyReviews,private readonly settings:TrustSettings){}
 private check(principal:Principal,body:z.infer<typeof safetyReviewBodySchema>){
  const projection=this.reviews.delivery(principal,body);
  const reason=eligible(this.db,body,{principalId:principal.id,channel:"owner_history"});
  if(reason)throw new TrustSettingsError(reason);
  if(projection.evidenceRevision!==body.expectedEvidenceRevision)throw new TrustSettingsError("stale_revision");
  if(projection.pendingCount||projection.reasons.some(r=>r==="recording_failed"||r==="capacity"))throw new TrustSettingsError("recording_pending");
 }
 async prepare(principal:Principal,raw:unknown,signal?:AbortSignal){
  const {future,...body}=combinedPrepareSchema.parse(raw);this.check(principal,body);
  const row=this.db.query("SELECT payload,detector FROM safety_records WHERE id=? AND kind='occurrence'").get(body.occurrenceId) as {payload:string;detector:string}|null;
  const payload=row?JSON.parse(row.payload):null,provenance=payload?.occurrence?.provenance??payload?.provenance;
  // Only transport-attested inputs qualify. Browser targets and display URLs
  // never establish provenance, nor does a mutable repository name.
  if(row?.detector!=="proxy_input"||!provenance||!(provenance.kind==="web_origin"&&provenance.verifiedBy==="host_transport"||provenance.kind==="tunnel_authority"&&provenance.verifiedBy==="host_proxy"))throw new TrustSettingsError("provenance_unavailable");
  const selector=provenance.kind==="web_origin"?{kind:"web_origin",...provenance.origin}:{kind:"tunnel_authority",...provenance.authority};
  const policy=await this.settings.list(principal.id);this.check(principal,body);
  if(!policy.capabilities.originRules||future.recipientWhileRestricted&&!policy.capabilities.recipientRules)throw new TrustSettingsError("enforcement_unavailable");
  const verdict=await this.reviews.review(principal,body,null);
  if(verdict.receipt.stage!=="prepared"||!verdict.receipt.requestId)throw new TrustSettingsError(verdict.receipt.reason??"unavailable");
  const prepared=await this.settings.prepare(principal.id,{version:1,expectedTrustRevision:policy.revision,expectedPolicyHash:policy.policyHash,
    change:{action:"create",rule:{id:crypto.randomUUID(),label:"Reviewed source",selector,...future}}},signal,{body,requestId:verdict.receipt.requestId});
  const currentProjection=this.reviews.delivery(principal,body);
  return {version:1 as const,requestId:prepared.receipt.requestId,session:body.session,occurrenceId:body.occurrenceId,review:prepared.review,rule:prepared.receipt,currentProjection};
 }
 async status(principal:Principal,raw:unknown){
  const input=safetyFutureStatusSchema.parse(raw),body={...input,expectedEvidenceRevision:"0",verdict:"safe" as const};
  this.reviews.delivery(principal,body);
  const row=this.db.query(`SELECT request_id FROM trust_settings_operations WHERE principal_id=?
    AND json_extract(payload,'$.safetyReview.body.occurrenceId')=?
    AND json_extract(payload,'$.safetyReview.body.session.sessionId')=?
    AND json_extract(payload,'$.safetyReview.body.session.historyOwnerId')=?
    AND json_extract(payload,'$.safetyReview.body.session.historyGeneration')=?
    ORDER BY expires_at DESC,rowid DESC LIMIT 1`).get(principal.id,input.occurrenceId,input.session.sessionId,input.session.historyOwnerId,input.session.historyGeneration) as {request_id:string}|null;
  if(!row)return null;
  const binding=this.settings.safetyReview(principal.id,row.request_id);
  if(!binding)throw new TrustSettingsError("unavailable");
  const rule:Receipt=(await this.settings.read(principal.id,row.request_id)).receipt;
  const stored=this.db.query("SELECT receipt FROM safety_review_requests WHERE id=?").get(binding.requestId) as {receipt:string}|null;
  const verdict=stored?JSON.parse(stored.receipt):null;
  const currentProjection=this.reviews.delivery(principal,body);
  return {version:1 as const,requestId:row.request_id,session:input.session,occurrenceId:input.occurrenceId,
    stage:verdict?.verdict==="committed"?"verdict_committed":rule.publication==="proved"?"partial":rule.publication==="unknown"?"unknown":rule.stage==="prepared"?"prepared":"refused",
    rule,verdict,currentProjection};
 }
 async commit(principal:Principal,raw:unknown,signal?:AbortSignal,sessionId?:string){
  const input=combinedCommitSchema.parse(raw),binding=this.settings.safetyReview(principal.id,input.requestId);
  if(!binding || sessionId !== undefined && binding.body.session.sessionId !== sessionId)throw new TrustSettingsError("request_conflict");
  this.reviews.delivery(principal,binding.body);
  const published=await this.settings.commit(principal.id,input,signal,{binding,check:()=>this.check(principal,binding.body)});
  let verdict:Awaited<ReturnType<OwnerSafetyReviews["review"]>>|null=null;
  if(published.receipt.publication==="proved"){
   // A retry uses the ORIGINAL verdict handle. Already-committed replay is
   // immutable; a refused/expired request never becomes a fresh clear.
   try { verdict=await this.reviews.review(principal,binding.body,binding.requestId); }
   catch { /* Publication remains proved; delivery below still fences revoked authority. */ }
  }
  const current=await this.settings.read(principal.id,input.requestId);
  const currentProjection=this.reviews.delivery(principal,binding.body);
  const committed=verdict?.receipt.verdict==="committed";
  return {version:1 as const,requestId:input.requestId,session:binding.body.session,occurrenceId:binding.body.occurrenceId,
   stage:committed?"verdict_committed":current.receipt.publication==="proved"?"partial":current.receipt.publication==="unknown"?"unknown":"refused",
   rule:current.receipt,verdict:verdict?.receipt??null,currentProjection};
 }
}
