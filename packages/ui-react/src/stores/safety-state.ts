/** Host evidence is kept beside chat state, never in its message objects. */
import { createStore } from "zustand/vanilla";
import type { SafetyCapabilities, SafetyIdentity, SafetyPage, SafetyUpdate, SafetyRecord, SafetyHistoryProjection } from "@schlessera/brain-ui-sdk/protocol";
const same=(a:unknown,b:unknown)=>JSON.stringify(a)===JSON.stringify(b);
export interface SafetyState {
  supported:boolean; status:"unavailable"|"loading"|"partial"|"ready"; reason:string|null;
  identity:SafetyIdentity|null; projection:SafetyHistoryProjection|null; records:Record<string,SafetyRecord>; revision:string;
  snapshotId:string|null; requestId:string|null; normal:boolean; nextCursor:string|null;
  capabilities:SafetyCapabilities|null; historyScopeKey:string|null; entryCorrelation:boolean; refreshTick:number; refresh():void; disconnected():void;
  reset(supported?:boolean,capabilities?:SafetyCapabilities|null,entryCorrelation?:boolean,historyScopeKey?:string|null):void; begin(requestId:string):void; page(requestId:string,page:SafetyPage):boolean;
  update(update:SafetyUpdate):boolean; unavailable(reason:string):void; retire(sessionId?:string,ownerIds?:string[]):void;
}
const empty={status:"unavailable" as const,reason:"unavailable",identity:null,projection:null,records:{},revision:"0",snapshotId:null,requestId:null,normal:false,nextCursor:null};
export function createSafetyStore(){
  return createStore<SafetyState>()((set,get)=>({supported:false,...empty,capabilities:null,historyScopeKey:null,entryCorrelation:false,refreshTick:0,
    refresh(){set({refreshTick:get().refreshTick+1});},
    reset(supported=false,capabilities=null,entryCorrelation=false,historyScopeKey=null){set({...empty,supported,capabilities,entryCorrelation,historyScopeKey});},
    // Retain historical facts while transport is down, without authority or a
    // claim of current normal policy. Auth loss/disposal still use reset.
    disconnected(){set({status:"unavailable",reason:"disconnected",normal:false,capabilities:null,requestId:null,snapshotId:null,nextCursor:null});},
    begin(requestId){set({...empty,supported:get().supported,status:"loading",reason:null,requestId});},
    page(requestId,page){
      const s=get();if(!s.supported||s.requestId!==requestId)return false;
      if((s.status==="ready"||s.reason==="gap")&&s.snapshotId===page.snapshotId&&same(s.identity,page.identity)&&BigInt(page.highWater)<=BigInt(s.revision))return true;
      if(s.snapshotId&&(s.snapshotId!==page.snapshotId||s.revision!==page.highWater||!same(s.identity,page.identity)))return false;
      if(page.cursor!==s.nextCursor||page.snapshotComplete!==(page.nextCursor===null))return false;
      if(page.projection.evidenceRevision!==page.highWater)return false;
      const records:Record<string,SafetyRecord>=Object.assign(Object.create(null),s.records);for(const r of page.records){if(BigInt(r.sequence)>BigInt(page.highWater))return false;const old=records[r.id];if(old&&!same(old,r))return false;records[r.id]=r;}
      set({identity:page.identity,projection:page.projection,records,revision:page.highWater,snapshotId:page.snapshotId,nextCursor:page.nextCursor,
        status:page.snapshotComplete?"ready":"partial",normal:page.snapshotComplete&&page.projection.restriction==="normal",reason:null});return true;
    },
    update(update){
      const s=get();if(!s.supported||!same(s.identity,update.identity))return false;
      if(BigInt(update.toRevision)<BigInt(s.revision))return true;
      if(update.toRevision===s.revision){
        // A host-local outage or pending input need not advance the durable
        // ledger. Keep the more restrictive view until a fresh snapshot.
        if(s.projection&&update.fromRevision===s.revision&&update.projection.evidenceRevision===s.revision&&update.records.length===0&&
          update.projection.restriction==="restricted"&&!same(update.projection,s.projection)){
          const next=update.projection,old=s.projection;
          const projection={...old,restriction:"restricted" as const,unresolvedCount:Math.max(old.unresolvedCount,next.unresolvedCount),
            earliestUnresolvedId:next.unresolvedCount>old.unresolvedCount?next.earliestUnresolvedId:old.earliestUnresolvedId,
            pendingCount:Math.max(old.pendingCount,next.pendingCount),reasons:[...new Set([...old.reasons,...next.reasons])],
            coverage:{...old.coverage,state:old.coverage.state==="complete"?next.coverage.state:old.coverage.state}};
          if(same(projection,old))return true;
          set({projection,normal:false,status:"partial",reason:"gap"});return false;
        }
        return true; // equal/older duplicates cannot loosen the aggregate
      }
      if(s.status!=="ready")return false;
      if(update.fromRevision!==s.revision||update.projection.evidenceRevision!==update.toRevision){set({normal:false,status:"partial",reason:"gap"});return false;}
      const records:Record<string,SafetyRecord>=Object.assign(Object.create(null),s.records);for(const r of update.records){if(BigInt(r.sequence)<=BigInt(update.fromRevision)||BigInt(r.sequence)>BigInt(update.toRevision))return false;
        const old=records[r.id];if(old&&!same(old,r))return false;records[r.id]=r;}
      if(Object.keys(records).length>100000){set({normal:false,status:"partial",reason:"capacity"});return false;}
      set({records,projection:update.projection,revision:update.toRevision,normal:update.projection.restriction==="normal"});return true;
    },
    unavailable(reason){set({...empty,supported:get().supported,reason,...(reason==="unauthorized"?{capabilities:null}:{})});},
    retire(sessionId,ownerIds){const i=get().identity;if(i&&"sessionId" in i&&(i.sessionId===sessionId||ownerIds?.includes(i.historyOwnerId)))set({...empty,supported:get().supported,reason:"retired"});},
  }));
}
