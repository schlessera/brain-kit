import type { SafetyReviewBody } from "@schlessera/brain-ui-sdk/protocol";
import type { BrainUiServices } from "../root.js";
import { safetyEvidence } from "./safety-evidence.js";

export type SafetyReviewProgress={stage:"pending"|"committed"|"refused"|"unknown";message:string};
/** Ephemeral, explicit user action only. No persistence, retry or optimistic clear. */
export function createSafetyReviewer(root:BrainUiServices,changed:(value:SafetyReviewProgress)=>void) {
  let controller:AbortController|null=null,disposed=false,committing=false;
  const cancel=()=>{
    if(!controller||controller.signal.aborted)return;
    controller.abort();
    if(!disposed)changed({stage:committing?"unknown":"refused",message:committing?"Review cancelled; the result is unknown. Refresh evidence to check. No decision will be sent again.":"Review cancelled because its owner or evidence changed. No decision was sent."});
  };
  const offSafety=root.stores.safety.subscribe((s,old)=>{
    if(s.status!=="ready"||s.requestId!==old.requestId||JSON.stringify(s.identity)!==JSON.stringify(old.identity)||!s.capabilities?.review)cancel();
  });
  const offChat=root.stores.chat.subscribe((s,old)=>{if(s.activeSessionId!==old.activeSessionId)cancel();});
  const offAuth=root.authLock.state.subscribe(s=>{if(s.phase!=="active")cancel();});
  return {
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
