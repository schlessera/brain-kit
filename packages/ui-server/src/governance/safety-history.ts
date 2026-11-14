/** Bounded read snapshots over immutable host evidence. No mutation caller. */
import { Database } from "bun:sqlite";
import type { SafetyIdentity, SafetyTarget, SafetyPage, SafetyRecord, SafetyUpdate, SafetyUnavailable as Unavailable } from "@schlessera/brain-ui-sdk/protocol";
import { safetyPageSchema, safetyUpdateSchema } from "@schlessera/brain-ui-sdk/schemas";
import type { Principal } from "../db/principals.js";
import { sameAccount } from "../middleware/account-partition.js";
import { assertLive } from "../ws/chat-lifecycle.js";
import { safetyProjection } from "./safety-store.js";
import { safetyQueue } from "./safety-queue.js";

type Reason = Unavailable["reason"];
export class SafetyReadUnavailable extends Error {
  constructor(readonly reason: Reason = "unavailable") { super(reason); }
}
interface Snapshot { id:string; principalId:string; target:SafetyTarget; identity:SafetyIdentity; highWater:string;
  projection:SafetyPage["projection"]; membership:string; expiresAt:number; pruned:number; bytes:number; entries:boolean }
interface Row { id:string; sequence:string; observed_at:number; kind:string; occurrence_id:string; source:string|null;
  detector:string|null; state:string|null; payload:string; detail_pruned:number; turn_id:string; collection_id:string }
const same = (a:unknown,b:unknown) => JSON.stringify(a)===JSON.stringify(b);
const fingerprint = (value:unknown) => new Bun.CryptoHasher("sha256").update(JSON.stringify(value)).digest("hex");
const bytes = (value:unknown) => Buffer.byteLength(JSON.stringify(value));
const wireId = (value:string) => {
  if(!/^[A-Za-z0-9_-]{1,128}$/.test(value))throw new SafetyReadUnavailable();
  return value;
};

export class SafetyHistory {
  private readonly subscriptions = new Map<object, { principal:Principal; identity:SafetyIdentity; revision:string; membership:string; projectionHash:string; valid:()=>boolean;
    send:(value:SafetyUpdate|Unavailable)=>void; busy:boolean; entries:boolean }>();
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly cursors = new Map<string, {snapshotId:string; after:string}>();
  private retainedBytes = 0;
  private closed = false;
  private readonly pendingReads = new Map<string,number>();
  constructor(private readonly db:Database, private readonly valid:(principal:Principal)=>boolean,
    private readonly settled:()=>Promise<void>, private readonly now:()=>number=Date.now) {}

  private clock():number {
    const at=this.now();
    if(!Number.isSafeInteger(at)||at<0||at>Number.MAX_SAFE_INTEGER-300000)throw new SafetyReadUnavailable();
    return at;
  }
  private authorize(principal:Principal,target:SafetyTarget):SafetyIdentity {
    if(this.closed)throw new SafetyReadUnavailable();
    if(!this.valid(principal))throw new SafetyReadUnavailable("unauthorized");
    if("sessionId" in target){
      const s=this.db.query("SELECT session_id,history_owner_id,generation,principal_id FROM safety_sessions WHERE session_id=?").get(target.sessionId) as
        {session_id:string;history_owner_id:string;generation:string;principal_id:string|null}|null;
      // Another login of the chat's account reads it; nobody else does (#3952).
      if(!s||!sameAccount(this.db,s.principal_id,principal.id))throw new SafetyReadUnavailable();
      const owner=this.db.query("SELECT principal_id,generation FROM dialogue_owners WHERE id=?").get(s.history_owner_id) as {principal_id:string;generation:number}|null;
      if(owner&&(!sameAccount(this.db,owner.principal_id,principal.id)||String(owner.generation)!==s.generation))throw new SafetyReadUnavailable("generation_changed");
      try{assertLive(this.db,[["session",s.session_id],["dialogue_owner",s.history_owner_id]]);}catch{throw new SafetyReadUnavailable();}
      return {sessionId:s.session_id,historyOwnerId:s.history_owner_id,historyGeneration:s.generation};
    }
    const c=this.db.query("SELECT session_id,principal_id,history_owner_id,generation FROM safety_collections WHERE id=? AND turn_id=?").get(target.bindingId,target.turnId) as
      {session_id:string|null;principal_id:string|null;history_owner_id:string;generation:string}|null;
    if(!c||!sameAccount(this.db,c.principal_id,principal.id)||this.db.query("SELECT 1 FROM safety_retired_turns WHERE turn_id=?").get(target.turnId))throw new SafetyReadUnavailable();
    if(c.session_id)return this.authorize(principal,{sessionId:c.session_id});
    const owner=this.db.query("SELECT generation,principal_id FROM dialogue_owners WHERE id=?").get(c.history_owner_id) as {generation:number;principal_id:string}|null;
    if(owner&&(String(owner.generation)!==c.generation||!sameAccount(this.db,owner.principal_id,principal.id)))throw new SafetyReadUnavailable("generation_changed");
    try{assertLive(this.db,[["dialogue_owner",c.history_owner_id]]);}catch{throw new SafetyReadUnavailable();}
    return {turnId:target.turnId,bindingId:target.bindingId};
  }
  private scope(identity:SafetyIdentity):{sql:string;args:string[]} {
    return "sessionId" in identity ? {sql:`(c.session_id=? OR (c.generation=? AND (c.history_owner_id=? OR c.history_owner_id IN (SELECT id FROM dialogue_aliases WHERE owner_id=?))))`,
      args:[identity.sessionId,identity.historyGeneration,identity.historyOwnerId,identity.historyOwnerId]}
      : {sql:"c.turn_id=? AND c.id=?",args:[identity.turnId,identity.bindingId]};
  }
  /** Adoption can expose old rows without changing the canonical SessionKey.
   * New collections above the watermark do not change the pinned membership. */
  private membership(identity:SafetyIdentity,through:string):string {
    const {sql,args}=this.scope(identity);
    const rows=this.db.query(`SELECT c.id FROM safety_collections c WHERE ${sql}
      AND (length(c.start_revision)<length(?) OR (length(c.start_revision)=length(?) AND c.start_revision<=?))
      ORDER BY c.id LIMIT 129`).all(...args,through,through,through) as {id:string}[];
    if(rows.length>128)throw new SafetyReadUnavailable("capacity");
    return new Bun.CryptoHasher("sha256").update(JSON.stringify(rows)).digest("hex");
  }
  private anchor(principal:Principal,identity:SafetyIdentity,revision:string,snapshotId:string):Snapshot {
    const s=this.snapshots.get(snapshotId);
    if(!s||this.clock()>=s.expiresAt)throw new SafetyReadUnavailable("expired");
    if(s.principalId!==principal.id||!same(s.identity,identity)||s.highWater!==revision)throw new SafetyReadUnavailable("gap");
    return s;
  }
  private pruned(identity:SafetyIdentity):number {
    const {sql,args}=this.scope(identity);
    return (this.db.query(`SELECT COUNT(*) n FROM safety_records r JOIN safety_collections c ON c.id=r.collection_id WHERE ${sql} AND r.detail_pruned=1`).get(...args) as {n:number}).n;
  }
  private localState(identity:SafetyIdentity):{pending:number;failed:boolean} {
    const local=safetyQueue(this.db),{sql,args}=this.scope(identity);
    const rows=this.db.query(`SELECT c.turn_id FROM safety_collections c WHERE ${sql} LIMIT 129`).all(...args) as {turn_id:string}[];
    if(rows.length>128)throw new SafetyReadUnavailable("capacity");
    const turns=new Set(rows.map(r=>r.turn_id));
    const pending=[...local.pending].filter(r=>r.turnId!==null&&turns.has(r.turnId)||"sessionId" in identity&&r.sessionId===identity.sessionId).length;
    return {pending,failed:local.failed};
  }
  private projection(identity:SafetyIdentity):SafetyPage["projection"] {
    const p=safetyProjection(this.db,"turnId" in identity?identity.turnId:null,"sessionId" in identity?identity.sessionId:null);
    const {pending,failed}=this.localState(identity);
    if(pending||failed){p.restriction="restricted";p.pendingCount=Math.max(p.pendingCount,pending);
      if(pending&&!p.reasons.includes("recording_pending"))p.reasons.push("recording_pending");
      if(failed){p.coverage.state="incomplete";if(!p.reasons.includes("recording_failed"))p.reasons.push("recording_failed");}}
    return p as SafetyPage["projection"];
  }
  private records(identity:SafetyIdentity,after:string,through:string,limit:number,entries:boolean):SafetyRecord[] {
    const {sql,args}=this.scope(identity);
    const rows=this.db.query(`SELECT * FROM (
      SELECT r.*,c.turn_id FROM safety_records r JOIN safety_collections c ON c.id=r.collection_id WHERE ${sql}
      UNION ALL SELECT d.id,r.collection_id,d.sequence,d.decided_at,'safe_decision',d.occurrence_id,NULL,NULL,NULL,
        json_object('session',json_object('sessionId',d.session_id,'historyOwnerId',d.history_owner_id,'historyGeneration',d.generation),
        'principalId',d.principal_id,'requestId',d.request_id,'channel',d.channel),0,0,0,0,c.turn_id
      FROM safety_decisions d JOIN safety_records r ON r.id=d.occurrence_id JOIN safety_collections c ON c.id=r.collection_id WHERE ${sql}
    ) WHERE (length(sequence)>length(?) OR (length(sequence)=length(?) AND sequence>?))
      AND (length(sequence)<length(?) OR (length(sequence)=length(?) AND sequence<=?))
    ORDER BY length(sequence),sequence LIMIT ?`).all(...args,...args,after,after,after,through,through,through,limit) as Row[];
    return rows.map(r=>{
      const common={id:wireId(r.id),sequence:r.sequence,observedAt:r.observed_at,turnId:r.turn_id,bindingId:r.collection_id,occurrenceId:wireId(r.occurrence_id),detailPruned:!!r.detail_pruned};
      const p=JSON.parse(r.payload);
      if(r.kind==="safe_decision")return {...common,kind:"safe_decision",session:p.session,requestId:p.requestId,principalId:p.principalId,verdict:"safe",channel:p.channel} as SafetyRecord;
      if(r.kind==="exposure")return {...common,kind:"exposure",state:r.state} as SafetyRecord;
      const o=r.detail_pruned?null:p.occurrence;
      // Allowlisted metadata only. No raw commands, URLs, paths, credentials,
      // model text, prompt or page body cross this read boundary.
      return {...common,kind:"occurrence",epochId:o?.epochId??r.collection_id,detector:r.detector,source:r.source??"legacy_unknown",operationId:o?.operationId??null,
        signalId:o?.signalId??null,exposureId:o?.exposureId??null,exposure:r.state??"interrupted_unknown",summary:r.source==="egress_connection"?"Network input; operation attribution unavailable":"Recorded input exposure",
        provenance:o?.provenance??null,...(entries&&(o?.entry??p.entry)?{entry:o?.entry??p.entry}:{})} as SafetyRecord;
    });
  }
  private drop(id:string):void {
    const snapshot=this.snapshots.get(id);if(!snapshot)return;
    this.retainedBytes-=snapshot.bytes;this.snapshots.delete(id);
    for(const [cursor,value] of this.cursors)if(value.snapshotId===id)this.cursors.delete(cursor);
  }
  private prune():void {const at=this.clock();for(const s of this.snapshots.values())if(at>=s.expiresAt)this.drop(s.id);}
  private reserveRead(principal:Principal):()=>void {
    const count=this.pendingReads.get(principal.id)??0;
    if(count>=32||[...this.pendingReads.values()].reduce((a,b)=>a+b,0)>=256)throw new SafetyReadUnavailable("capacity");
    this.pendingReads.set(principal.id,count+1);
    return ()=>{const left=this.pendingReads.get(principal.id)!-1;if(left)this.pendingReads.set(principal.id,left);else this.pendingReads.delete(principal.id);};
  }
  /** Every await precedes fresh authority, identity and clock checks. */
  async read(principal:Principal,target:SafetyTarget,cursor:string|null=null,limit:number=50,entries=false):Promise<SafetyPage> {
    if(!Number.isInteger(limit)||limit<1||limit>100||cursor!==null&&cursor.length>512)throw new SafetyReadUnavailable();
    this.authorize(principal,target);
    const release=this.reserveRead(principal);
    try { await this.settled();
    return Database.prototype.transaction.call(this.db,()=>{
      const identity=this.authorize(principal,target);this.prune();
      let snapshot:Snapshot,after="0";
      if(cursor!==null){
        const position=this.cursors.get(cursor),s=position&&this.snapshots.get(position.snapshotId);
        if(!s||s.principalId!==principal.id||!same(s.target,target)||s.entries!==entries)throw new SafetyReadUnavailable("expired");
        snapshot=s;after=position!.after;
        if(!same(identity,s.identity))throw new SafetyReadUnavailable("generation_changed");
        if(this.membership(identity,s.highWater)!==s.membership)throw new SafetyReadUnavailable("gap");
        if(this.pruned(identity)!==s.pruned)throw new SafetyReadUnavailable("expired");
      }else{
        if(this.snapshots.size>=256||[...this.snapshots.values()].filter(s=>s.principalId===principal.id).length>=32)throw new SafetyReadUnavailable("capacity");
        const projection=this.projection(identity),size=bytes(projection)+2048;
        if(this.retainedBytes+size>4194304)throw new SafetyReadUnavailable("capacity");
        snapshot={id:crypto.randomUUID(),principalId:principal.id,target,identity,projection,highWater:projection.evidenceRevision,membership:this.membership(identity,projection.evidenceRevision),expiresAt:this.clock()+300000,pruned:this.pruned(identity),bytes:size,entries};
        this.snapshots.set(snapshot.id,snapshot);this.retainedBytes+=size;
      }
      const fetched=this.records(identity,after,snapshot.highWater,limit+1,snapshot.entries),records:SafetyRecord[]=[];
      const page:SafetyPage={version:1,identity,snapshotId:snapshot.id,cursor,highWater:snapshot.highWater,projection:snapshot.projection,records,nextCursor:null,snapshotComplete:false,detailPruned:snapshot.pruned>0};
      for(const record of fetched.slice(0,limit)){if(bytes({...page,records:[...records,record]})>261000)break;records.push(record);}
      if(fetched.length&&!records.length)throw new SafetyReadUnavailable("capacity");
      page.snapshotComplete=records.length===fetched.length;
      if(!page.snapshotComplete){
        // One reusable position token per snapshot page; retries cannot grow
        // an unbounded cursor table. At most 100000 ledger rows per snapshot.
        const last=records.at(-1)!.sequence;
        const old=[...this.cursors].find(([,v])=>v.snapshotId===snapshot.id&&v.after===last)?.[0];
        if(!old&&this.cursors.size>=4096)throw new SafetyReadUnavailable("capacity");
        page.nextCursor=old??crypto.randomUUID();this.cursors.set(page.nextCursor,{snapshotId:snapshot.id,after:last});
      }
      if(this.clock()>=snapshot.expiresAt)throw new SafetyReadUnavailable("expired");
      if(!same(identity,this.authorize(principal,target)))throw new SafetyReadUnavailable("generation_changed");
      return safetyPageSchema.parse(page);
    }).deferred() as SafetyPage;
    }finally{release();}
  }
  async delta(principal:Principal,identity:SafetyIdentity,after:string,snapshotId:string):Promise<SafetyUpdate> {
    const anchor=this.anchor(principal,identity,after,snapshotId);
    const result=await this.readDelta(principal,identity,after,anchor.membership,anchor.entries);
    this.anchor(principal,identity,after,snapshotId);
    this.delivery(principal,identity,snapshotId,result.update.projection);
    if(this.membership(identity,result.update.toRevision)!==result.membership)throw new SafetyReadUnavailable("gap");
    return result.update;
  }
  private async readDelta(principal:Principal,identity:SafetyIdentity,after:string,membership:string,entries:boolean):Promise<{update:SafetyUpdate;membership:string}> {
    const target:SafetyTarget="sessionId" in identity?{sessionId:identity.sessionId}:identity;
    this.authorize(principal,target);const release=this.reserveRead(principal);
    try{await this.settled();
    return Database.prototype.transaction.call(this.db,()=>{
      if(!same(this.authorize(principal,target),identity))throw new SafetyReadUnavailable("generation_changed");
      if(this.membership(identity,after)!==membership)throw new SafetyReadUnavailable("gap");
      const projection=this.projection(identity);
      if(BigInt(after)>BigInt(projection.evidenceRevision))throw new SafetyReadUnavailable("gap");
      const records=this.records(identity,after,projection.evidenceRevision,101,entries);
      const update:SafetyUpdate={version:1,identity,fromRevision:after,toRevision:projection.evidenceRevision,projection,records};
      if(records.length>100||bytes(update)>262000)throw new SafetyReadUnavailable("capacity");
      this.authorize(principal,target);this.clock();
      return {update:safetyUpdateSchema.parse(update),membership:this.membership(identity,projection.evidenceRevision)};
    }).deferred() as {update:SafetyUpdate;membership:string};
    }finally{release();}
  }
  subscribe(key:object,principal:Principal,identity:SafetyIdentity,revision:string,snapshotId:string,valid:()=>boolean,send:(value:SafetyUpdate|Unavailable)=>void):void {
    if(!this.subscriptions.has(key)&&this.subscriptions.size>=256)throw new SafetyReadUnavailable("capacity");
    const anchor=this.anchor(principal,identity,revision,snapshotId);
    this.subscriptions.set(key,{principal,identity,revision,membership:anchor.membership,projectionHash:fingerprint(anchor.projection),valid,send,busy:false,entries:anchor.entries});this.poll();
  }
  unsubscribe(key:object):void {this.subscriptions.delete(key);}
  revoke(principalIds:readonly string[]):void {
    for(const s of this.snapshots.values())if(principalIds.includes(s.principalId))this.drop(s.id);
    for(const [key,s] of this.subscriptions)if(principalIds.includes(s.principal.id))this.subscriptions.delete(key);
  }
  retire(sessions:readonly string[],owners:readonly string[]):void {
    const matches=(i:SafetyIdentity)=>{
      if("sessionId" in i)return sessions.includes(i.sessionId)||owners.includes(i.historyOwnerId);
      const c=this.db.query("SELECT session_id,history_owner_id FROM safety_collections WHERE id=? AND turn_id=?").get(i.bindingId,i.turnId) as {session_id:string|null;history_owner_id:string}|null;
      return !c||!!c.session_id&&sessions.includes(c.session_id)||owners.includes(c.history_owner_id);
    };
    for(const s of this.snapshots.values())if(matches(s.identity))this.drop(s.id);
    for(const [key,s] of this.subscriptions)if(matches(s.identity)){this.subscriptions.delete(key);if(s.valid()&&this.valid(s.principal))s.send({version:1,reason:"unavailable"});}
  }
  /** Synchronous final delivery fence, after the caller's awaited read. */
  delivery(principal:Principal,identity:SafetyIdentity,snapshotId?:string,projection?:SafetyPage["projection"]):void {
    const target:SafetyTarget="sessionId" in identity?{sessionId:identity.sessionId}:identity;
    if(!same(identity,this.authorize(principal,target)))throw new SafetyReadUnavailable("generation_changed");
    if(snapshotId){const s=this.snapshots.get(snapshotId);if(!s||s.principalId!==principal.id||this.clock()>=s.expiresAt||s.pruned!==this.pruned(identity))throw new SafetyReadUnavailable("expired");
      projection??=s.projection;
      if(this.membership(identity,s.highWater)!==s.membership)throw new SafetyReadUnavailable("gap");}
    const local=this.localState(identity);
    if(projection&&(local.failed&&!projection.reasons.includes("recording_failed")||local.pending>projection.pendingCount))throw new SafetyReadUnavailable("gap");
  }
  /** Shares the host's existing authorization sweep; no per-read timer. */
  poll():void {
    this.prune();
    for(const [key,s] of this.subscriptions){
      if(!s.valid()||!this.valid(s.principal)){this.subscriptions.delete(key);continue;}
      if(s.busy)continue;s.busy=true;
      void this.readDelta(s.principal,s.identity,s.revision,s.membership,s.entries).then(({update,membership})=>{
        if(this.subscriptions.get(key)!==s||!s.valid()||!this.valid(s.principal))return;
        try{this.delivery(s.principal,s.identity,undefined,update.projection);
          if(this.membership(s.identity,update.toRevision)!==membership)throw new SafetyReadUnavailable("gap");
        }catch(error){this.subscriptions.delete(key);s.send({version:1,reason:error instanceof SafetyReadUnavailable?error.reason:"unavailable"});return;}
        // Local pending/loss latches can change even when their durable write
        // rolled back. Equal durable revisions do not prove equal read state.
        const projectionHash=fingerprint(update.projection);
        if(update.toRevision===s.revision&&projectionHash!==s.projectionHash){
          this.subscriptions.delete(key);s.send({version:1,reason:"gap"});return;
        }
        if(update.toRevision!==s.revision){s.send(update);s.revision=update.toRevision;s.membership=membership;s.projectionHash=projectionHash;}
      },error=>{
        if(this.subscriptions.get(key)!==s||!s.valid()||!this.valid(s.principal))return;
        this.subscriptions.delete(key);s.send({version:1,reason:error instanceof SafetyReadUnavailable?error.reason:"unavailable"});
      }).finally(()=>{s.busy=false;});
    }
  }
  close():void {this.closed=true;this.subscriptions.clear();this.snapshots.clear();this.cursors.clear();this.retainedBytes=0;}
}
