import type { SafetyReviewBody, SafetyFuturePrepared } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiServices } from "../root.js";
import { safetyEvidence } from "./safety-evidence.js";

export type SafetyReviewProgress={stage:"pending"|"review"|"committed"|"partial"|"refused"|"unknown";message:string};
/** Ephemeral, explicit user action only. No persistence, retry or optimistic clear. */
export function createSafetyReviewer(root:BrainUiServices,changed:(value:SafetyReviewProgress)=>void) {
  let controller:AbortController|null=null,disposed=false,committing=false;
  const cancel=()=>{
    if(!controller&&!prepared)return;
    controller?.abort();prepared=null;
    if(!disposed)changed({stage:committing?"unknown":"refused",message:committing?"Review cancelled; the result is unknown. Refresh evidence to check. No decision will be sent again.":"Review cancelled because its owner or evidence changed. No decision was sent."});
  };
  const offSafety=root.stores.safety.subscribe((s,old)=>{
    if(s.status!=="ready"||s.requestId!==old.requestId||s.revision!==old.revision||JSON.stringify(s.identity)!==JSON.stringify(old.identity)||!s.capabilities?.review)cancel();
  });
  const offChat=root.stores.chat.subscribe((s,old)=>{if(s.activeSessionId!==old.activeSessionId)cancel();});
  const offAuth=root.authLock.state.subscribe(s=>{if(s.phase!=="active")cancel();});
  let prepared:SafetyFuturePrepared|null=null,preparedEpoch:number|null=null,preparedRevision:string|null=null,preparedTarget:{session:SafetyReviewBody["session"];occurrenceId:string}|null=null;
  return {
    async prepareFuture(occurrenceId:string,recipientWhileRestricted:boolean):Promise<SafetyFuturePrepared|null>{
      const s=root.stores.safety.getState(),identity=s.identity,epoch=root.authLock.epoch();
      if(disposed||controller||s.status!=="ready"||!s.capabilities?.review||!s.capabilities?.originRules||!identity||!("sessionId" in identity)||root.stores.chat.getState().activeSessionId!==identity.sessionId||root.authLock.state.getState().phase!=="active")return null;
      prepared=null;
      const target={session:{...identity},occurrenceId};
      const owned=controller=new AbortController();
      changed({stage:"pending",message:"Preparing the exact future rule…"});
      try{
        const result=await root.api.safetyFuturePrepare({version:1,session:identity,occurrenceId,expectedEvidenceRevision:s.revision,verdict:"safe",future:{incomingContent:true,recipientWhileRestricted}},owned.signal);
        if(disposed||owned.signal.aborted||root.authLock.epoch()!==epoch)return null;
        if(result.occurrenceId!==target.occurrenceId||JSON.stringify(result.session)!==JSON.stringify(target.session)||result.rule.requestId!==result.requestId||!root.stores.safety.getState().capabilities?.originRules||root.stores.safety.getState().requestId!==s.requestId||root.stores.safety.getState().revision!==s.revision){changed({stage:"refused",message:"The evidence changed. Read current evidence before reviewing again."});return null;}
        prepared=result;preparedTarget=target;preparedEpoch=epoch;preparedRevision=s.revision;changed({stage:"review",message:"Review the exact policy change before saving."});return result;
      }catch{if(!owned.signal.aborted)changed({stage:"refused",message:"Could not prepare future trust. Refresh evidence before trying again."});return null;}
      finally{if(controller===owned)controller=null;}
    },
    async commitFuture():Promise<void>{
      const p=prepared,target=preparedTarget;if(disposed||controller||!p||!target)return;
      const s=root.stores.safety.getState();
      if(s.revision!==preparedRevision||root.authLock.epoch()!==preparedEpoch||root.authLock.state.getState().phase!=="active"||s.status!=="ready"||!s.capabilities?.originRules||JSON.stringify(s.identity)!==JSON.stringify(target.session)||root.stores.chat.getState().activeSessionId!==target.session.sessionId){prepared=null;return;}
      const owned=controller=new AbortController();committing=true;prepared=null;
      changed({stage:"pending",message:"Saving the reviewed rule, then recording this trigger's verdict…"});
      try{
        const result=await root.api.safetyFutureCommit(target.session.sessionId,{version:1,requestId:p.requestId,reviewId:p.review.reviewId,reviewedBytesHash:p.review.reviewedBytesHash},owned.signal);
        if(disposed||owned.signal.aborted)return;
        if(result.requestId!==p.requestId||result.occurrenceId!==target.occurrenceId||JSON.stringify(result.session)!==JSON.stringify(target.session)||result.verdict&&(result.verdict.occurrenceId!==target.occurrenceId||JSON.stringify(result.verdict.session)!==JSON.stringify(target.session)))throw new Error("Different future review receipt");
        // Completion is a historical operation fact. Only refreshed status
        // reports current rule presence; only live evidence reports the verdict.
        changed({stage:result.stage==="verdict_committed"?"committed":result.stage==="partial"?"partial":result.stage==="unknown"?"unknown":"refused",message:result.stage==="verdict_committed"?"This operation recorded a safe verdict. Reading current restrictions…":result.rule.publication==="proved"?"The rule was saved; this operation did not complete its verdict. Reading current restrictions…":`Publication was ${result.rule.publication==="unknown"?"not confirmed":"refused"}. This operation did not record a verdict. Fresh review is required.`});
        controller=null;s.refresh();
      }catch{if(!owned.signal.aborted)changed({stage:"unknown",message:"The result is unknown. Refresh evidence and Settings; this operation will not be sent again."});}
      finally{if(controller===owned)controller=null;committing=false;}
    },
    async markSafe(occurrenceId:string):Promise<void> {
      if(disposed||controller)return;
      const s=root.stores.safety.getState(),identity=s.identity,epoch=root.authLock.epoch(),requestId=s.requestId;
      const evidence=safetyEvidence(s.records).get(occurrenceId);
      if(s.status!=="ready"||!s.capabilities?.review||!identity||!("sessionId" in identity)||root.stores.chat.getState().activeSessionId!==identity.sessionId||
        !evidence||evidence.decision||evidence.exposure!=="finalized"||root.authLock.state.getState().phase!=="active")return;
      const body:SafetyReviewBody={version:1,session:identity,occurrenceId,expectedEvidenceRevision:s.revision,verdict:"safe"};
      const owned=controller=new AbortController();
      const live=()=>!disposed&&!owned.signal.aborted&&root.authLock.epoch()===epoch&&root.authLock.state.getState().phase==="active"&&
        root.stores.chat.getState().activeSessionId===identity.sessionId&&root.stores.safety.getState().requestId===requestId&&
        JSON.stringify(root.stores.safety.getState().identity)===JSON.stringify(identity)&&root.stores.safety.getState().capabilities?.review===true;
      const matches=(value:{session:unknown;occurrenceId:string})=>JSON.stringify(value.session)===JSON.stringify(identity)&&value.occurrenceId===occurrenceId;
      changed({stage:"pending",message:"Recording your decision…"});
      let dispatched=false;
      try {
        const prepared=await root.api.safetyPrepare(body,owned.signal);
        if(!live())return;
        if(!matches(prepared.receipt)||prepared.receipt.stage!=="prepared"||!prepared.receipt.requestId||prepared.receipt.reason||
          root.stores.safety.getState().revision!==body.expectedEvidenceRevision){
          changed({stage:"refused",message:"The evidence changed or this trigger cannot be reviewed. Read the current evidence before trying again."});
          controller=null;root.stores.safety.getState().refresh();return;
        }
        dispatched=true;committing=true;
        const result=await root.api.safetyCommit(prepared.receipt.requestId,body,owned.signal);
        if(!live())return;
        if(!matches(result.receipt)||result.receipt.requestId!==prepared.receipt.requestId)throw new Error("Different safety receipt");
        const committed=result.receipt.stage==="verdict_committed"&&result.receipt.verdict==="committed"&&!result.receipt.reason;
        changed({stage:committed?"committed":"refused",message:committed?"Decision recorded. Reading current restrictions…":"The host refused this decision. Read current evidence before trying again."});
        // Historical receipts and even their live projection do not replace
        // newer subscription data. Obtain a complete fresh read instead.
        controller=null;root.stores.safety.getState().refresh();
      } catch {
        if(!live())return;
        changed({stage:dispatched?"unknown":"refused",message:dispatched?"The result is unknown. Refresh evidence to check; this decision will not be sent again.":"Could not prepare this review. Refresh evidence before trying again."});
      } finally {if(controller===owned)controller=null;committing=false;}
    },
    dispose(){disposed=true;cancel();offSafety();offChat();offAuth();},
  };
}
