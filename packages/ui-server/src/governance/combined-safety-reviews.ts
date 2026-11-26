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
  const selected=await this.settings.safetyStatus(principal.id,input.session,input.occurrenceId);
  if(!selected){this.reviews.delivery(principal,body);return null;}
  const {binding}=selected,rule:Receipt=selected.receipt;
  return this.response(principal,selected.requestId,binding,rule);
 }
 private committed(binding:NonNullable<ReturnType<TrustSettings["safetyReview"]>>){
  const {body}=binding;
  return !!this.db.query("SELECT 1 FROM safety_decisions WHERE request_id=? AND occurrence_id=? AND session_id=? AND history_owner_id=? AND generation=?").get(binding.requestId,body.occurrenceId,body.session.sessionId,body.session.historyOwnerId,body.session.historyGeneration);
 }
 private response(principal:Principal,requestId:string,binding:NonNullable<ReturnType<TrustSettings["safetyReview"]>>,rule:Receipt){
  const stored=this.db.query("SELECT receipt FROM safety_review_requests WHERE id=?").get(binding.requestId) as {receipt:string}|null;
  const verdict=stored?JSON.parse(stored.receipt):null,committed=this.committed(binding);
  const currentProjection=this.reviews.delivery(principal,binding.body);
  return {version:1 as const,requestId,session:binding.body.session,occurrenceId:binding.body.occurrenceId,
    stage:committed?"verdict_committed":rule.publication==="proved"?"partial":rule.publication==="unknown"?"unknown":rule.stage==="prepared"?"prepared":"refused",
    rule,verdict:verdict&&!committed?{...verdict,requestId:null,operationId:null}:verdict,currentProjection};
 }

 async commit(principal:Principal,raw:unknown,signal?:AbortSignal,sessionId?:string){
  const input=combinedCommitSchema.parse(raw),binding=this.settings.safetyReview(principal.id,input.requestId);
  if(!binding || sessionId !== undefined && binding.body.session.sessionId !== sessionId)throw new TrustSettingsError("request_conflict");
  this.reviews.delivery(principal,binding.body);
  const published=await this.settings.commit(principal.id,input,signal,{binding,check:()=>this.check(principal,binding.body)});
  if(published.receipt.publication==="proved"&&!this.committed(binding)){
   // A retry uses the ORIGINAL verdict handle. Already-committed replay is
   // immutable; a refused/expired request never becomes a fresh clear.
   try { await this.reviews.review(principal,binding.body,binding.requestId); }
   catch { /* Publication remains proved; delivery below still fences revoked authority. */ }
  }
  const current=await this.settings.read(principal.id,input.requestId);
  return this.response(principal,input.requestId,binding,current.receipt);
 }
}
