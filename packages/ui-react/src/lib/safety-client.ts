import type { ClientMessage, ServerMessage, SafetyTarget } from "@schlessera/brain-ui-sdk/protocol";
import { safetySessionKeySchema } from "@schlessera/brain-ui-sdk/schemas";
import type { BrainUiServices } from "../root.js";
/** One selected read subscription per socket. All reconnects start a fresh snapshot. */
export function createSafetyClient(root:BrainUiServices,send:(message:ClientMessage)=>boolean){
  let target:SafetyTarget|null=null,requestId:string|null=null,disposed=false,awaitingPage=false;
  const store=root.stores.safety;
  function read(next:SafetyTarget):void{
    if(disposed||!store.getState().supported)return;
    target=next;requestId=crypto.randomUUID();awaitingPage=true;store.getState().begin(requestId);
    send({type:"safety_unsubscribe",version:1});
    send({type:"safety_read",version:1,requestId,target});
  }
  function selected(): void {
    const id = root.stores.chat.getState().activeSessionId;
    // Host-only voice histories and older persisted keys are chat selections.
    // Validate against the shared wire schema before starting a safety read.
    if (id && safetySessionKeySchema.shape.sessionId.safeParse(id).success) read({ sessionId: id });
    else {
      target = null; requestId = null; awaitingPage = false;
      store.getState().unavailable("unavailable");
      if (store.getState().supported) send({ type: "safety_unsubscribe", version: 1 });
    }
  }
  const detach=root.stores.chat.subscribe((state,previous)=>{if(state.activeSessionId!==previous.activeSessionId)selected();});
  return {
    frame(msg:ServerMessage):boolean{
      if(disposed)return false;
      if(msg.type==="server_hello"){
        requestId=null;store.getState().reset(msg.capabilities?.sessionSafetyHistory===true&&msg.safetyCapabilities?.read===true);selected();return false;
      }
      if(msg.type==="chat_retired"){store.getState().retire(msg.sessionId,msg.historyOwnerIds);if(target&&"sessionId" in target&&target.sessionId===msg.sessionId){requestId=null;target=null;store.getState().unavailable("retired");}return false;}
      if(msg.type==="safety_history"){
        if(msg.requestId!==requestId||!target||!awaitingPage)return true;
        if(msg.page.cursor!==store.getState().nextCursor)return true;
        if(!store.getState().page(msg.requestId,msg.page)){read(target);return true;}
        if(msg.page.nextCursor)send({type:"safety_read",version:1,requestId:msg.requestId,target,cursor:msg.page.nextCursor});
        else{awaitingPage=false;send({type:"safety_subscribe",version:1,requestId:msg.requestId,identity:msg.page.identity,afterRevision:msg.page.highWater,snapshotId:msg.page.snapshotId});}return true;
      }
      if(msg.type==="safety_update"){
        // A previous subscription may still have frames in flight. The new
        // snapshot's final subscription replays everything after its watermark.
        if(awaitingPage)return true;
        if(JSON.stringify(store.getState().identity)!==JSON.stringify(msg.update.identity))return true;
        if(!store.getState().update(msg.update)&&target)read(target);return true;
      }
      if(msg.type==="safety_unavailable"){
        if(msg.requestId&&msg.requestId!==requestId)return true;
        // Expiry/gap needs an explicit fresh snapshot; never replay a mutation.
        const again=target&&["gap","expired","generation_changed"].includes(msg.reason);
        store.getState().unavailable(msg.reason);requestId=null;if(again&&target)read(target);return true;
      }
      return false;
    },
    refresh():void{selected();},
    disconnected():void{requestId=null;store.getState().reset();},
    dispose():void{disposed=true;requestId=null;detach();store.getState().reset();},
  };
}
