/** Concrete host journal. Submission order is the shared SQLite writer's commit order. */
import { StorageSettlementIndeterminate, withinStorageBudget } from "../db/settlement.js";
import { CONVERSATION_LIMITS } from "@schlessera/brain-ui-sdk/protocol";
import type {
  DialogueEvidence,
  DialoguePage,
  ServerMessage,
} from "@schlessera/brain-ui-sdk/protocol";
import type { SessionCatalog } from "./session-catalog.js";
import type { DialogueOpen, DialogueOwner } from "./dialogue-storage.js";

export class DialogueJournal {
  private readonly sessions = new Map<string, DialogueOwner>();
  private readonly conversations = new Map<string, DialogueOwner>();
  private readonly adopting = new Map<string, DialogueOwner>();
  private readonly offsets = new Map<string, number>();
  private failure: unknown;
  private readonly failedOwners = new Set<string>();
  private readonly pending = new Set<Promise<unknown>>();
  private readonly ownerPending = new Map<DialogueOwner, Set<Promise<unknown>>>();
  private readonly transitions = new Map<string, Promise<unknown>>();
  private readonly scopes = new Map<string, {epoch:number;principalId:string;closed:boolean;owner?:DialogueOwner}>();
  private readonly queues = new Map<DialogueOwner, { count: number; bytes: number }>();
  private readonly withheld = new WeakSet<DialogueOwner>();
  private readonly refusals = new Map<DialogueOwner, Set<() => void>>();
  constructor(
    private readonly catalog: SessionCatalog,
    private readonly publish: (page: DialoguePage, principalId: string) => void,
    private readonly failed: (owner: DialogueOwner, cause: "queue_pressure" | "storage_error" | "storage_indeterminate", kind?: DialogueEvidence["kind"]) => void
  ) {}
  private transition<T>(conversationId: string, run: () => Promise<T>): Promise<T> {
    const prior=this.transitions.get(conversationId);
    const done=(prior ?? Promise.resolve()).then(run);
    this.transitions.set(conversationId,done);
    const release=()=>{
      if(this.transitions.get(conversationId)!==done)return;
      this.transitions.delete(conversationId);
      if(this.scopes.get(conversationId)?.closed)this.scopes.delete(conversationId);
    };
    void done.then(release,release);
    return done;
  }
  async open(input: DialogueOpen): Promise<DialogueOwner | undefined> {
    if (!this.catalog.dialogueOpen) return;
    const scope={epoch:input.epoch,principalId:input.principalId,closed:false,expired:false,owner:undefined as DialogueOwner|undefined};
    this.scopes.set(input.conversationId,scope);
    try {
      const completion=this.transition(input.conversationId,async()=>{
        if(scope.expired) throw new StorageSettlementIndeterminate("Retired dialogue opening");
        const owner=await this.catalog.dialogueOpen!(input);
        scope.owner=owner;
        if (scope.expired) { await this.catalog.dialogueClose?.(input.conversationId,input.principalId,input.epoch,true); return owner; }
        this.failedOwners.delete(owner.id);
        // A close/replacement may already have retired this pending open.
        if(this.scopes.get(input.conversationId)===scope && !scope.closed){
          this.conversations.set(input.conversationId,owner);
          if(owner.session_id)this.rememberSession(owner.session_id,owner);
        }
        return owner;
      });
      this.track(completion.catch(error => { if (scope.expired) this.failure ??= error; }));
      return await withinStorageBudget(completion, "Dialogue opening");
    } catch(error) {
      scope.closed=true;
      if(error instanceof StorageSettlementIndeterminate)scope.expired=true;
      if(this.scopes.get(input.conversationId)===scope)this.scopes.delete(input.conversationId);
      throw error;
    }
  }
  private rememberSession(id: string, owner: DialogueOwner): void {
    this.sessions.delete(id);
    this.sessions.set(id, owner);
    if (this.sessions.size > 128)
      this.sessions.delete(this.sessions.keys().next().value!);
  }
  bind(conversationId: string, principalId: string, sessionId: string): void {
    const owner =
      this.conversations.get(conversationId) ??
      this.catalog.dialogueOwnerForConversation?.(conversationId, principalId);
    if (
      !owner ||
      owner.principal_id !== principalId ||
      !this.catalog.dialogueBind
    )
      return;
    // Reserve routing synchronously. The bind is posted before subsequent appends.
    owner.session_id = sessionId;
    this.rememberSession(sessionId, owner);
    const done = this.catalog
      .dialogueBind(conversationId, principalId, sessionId)
      .then((next) => {
        if (next) {
          this.conversations.set(conversationId, next);
          this.rememberSession(sessionId, next);
        }
      });
    this.track(done, owner);
  }
  voice(
    conversationId: string,
    evidence: Extract<DialogueEvidence, { kind: "voice" }>,
    after: (saved: boolean) => void
  ): boolean {
    const owner = this.conversations.get(conversationId);
    if (!owner) return false;
    const e = evidence.event;
    const identity = JSON.stringify([
      conversationId,
      evidence.epoch,
      e.kind,
      e.kind === "input_fragment"
        ? e.utteranceId
        : e.kind === "output_transcript"
        ? e.outputId
        : null,
      e.sequence,
    ]);
    this.append(owner, identity, evidence, after);
    return true;
  }
  adoptTurn(turnId: string, ownerId: string, principalId: string): void {
    const owner = this.catalog.dialogueOwnerForId?.(ownerId, principalId);
    if (
      !owner ||
      owner.session_id ||
      [...this.adopting.values()].some((o) => o.id === owner.id)
    )
      throw new Error("Retained conversation is not provisional");
    this.adopting.set(turnId, owner);
  }
  /** Exact UI-only draft target of an authorized provisional adoption. */
  draftSource(turnId: string): string | undefined {
    const owner = this.adopting.get(turnId);
    return owner ? `dialogue:${owner.id}` : undefined;
  }
  retireTurn(turnId: string): void {
    this.adopting.delete(turnId);
    this.offsets.delete(turnId);
  }
  backend(msg: ServerMessage): void {
    if (
      msg.type !== "session_info" &&
      msg.type !== "text_delta" &&
      msg.type !== "result"
    )
      return;
    const { sessionId, turnId } = msg as {
      sessionId?: string;
      turnId?: string;
    };
    if (!turnId) return;
    // Count every observed backend character, even before the first voice
    // owner exists. These numbers are positions, never retained prefix text.
    const start = this.offsets.get(turnId) ?? 0;
    const end = msg.type === "text_delta" ? start + msg.text.length : start;
    if(msg.type === "text_delta") this.offsets.set(turnId,end);
    if(msg.type === "result") this.offsets.delete(turnId);
    if (!sessionId) return;
    const adopting = this.adopting.get(turnId);
    if (msg.type === "session_info" && adopting) {
      this.conversations.set(adopting.id, adopting);
      this.bind(adopting.id, adopting.principal_id, sessionId);
      this.adopting.delete(turnId);
      this.conversations.delete(adopting.id);
    }
    const owner =
      this.sessions.get(sessionId) ??
      this.catalog.dialogueOwnerForSession?.(sessionId);
    if (!owner) return;
    this.rememberSession(sessionId,owner);
    if (msg.type === "session_info")
      this.append(owner, `request:${turnId}`, {
        kind: "request",
        turnId: turnId,
        ...(msg.requestId ? { requestId: msg.requestId } : {}),
      });
    if (msg.type === "text_delta") {
      for (let offset = start; offset < end; offset += 2000) {
        const text = msg.text.slice(offset - start, offset - start + 2000);
        this.append(owner, `text:${turnId}:${offset}`, {
          kind: "backend",
          turnId: turnId,
          start: offset,
          end: offset + text.length,
          text,
          digest: Bun.SHA256.hash(text, "hex"),
        });
      }
    }
  }
  close(
    conversationId: string,
    principalId: string,
    epoch: number,
    partial: boolean = false
  ): void {
    const scope=this.scopes.get(conversationId);
    if(!scope || scope.epoch!==epoch || scope.principalId!==principalId)return;
    scope.closed=true;
    // Retire ingress immediately, including an open still waiting on storage.
    this.conversations.delete(conversationId);
    const done=this.transition(conversationId,async()=>{
      const owner=scope.owner;
      if(!owner || !this.catalog.dialogueClose)return;
      // Wait only for this owner's already observed callbacks. The close
      // operation itself is tracked globally, so it cannot wait on itself.
      await Promise.allSettled(this.ownerWrites(owner));
      try {
        await this.catalog.dialogueClose(conversationId,principalId,epoch,partial || owner.coverage === "partial");
      } catch(error) {
        this.notifyFailure(owner,"storage_error");
        throw error;
      }
    });
    this.track(done);
  }

  private append(
    owner: DialogueOwner,
    identity: string,
    evidence: DialogueEvidence,
    after?: (saved: boolean) => void
  ): void {
    if (!this.catalog.dialogueAppend) return;
    const q = this.queues.get(owner) ?? { count: 0, bytes: 0 };
    const bytes = Buffer.byteLength(JSON.stringify(evidence));
    let count = 0, pendingBytes = 0;
    for (const [queuedOwner, queued] of this.queues) if (queuedOwner.id === owner.id) {
      count += queued.count; pendingBytes += queued.bytes;
    }
    if (count >= CONVERSATION_LIMITS.maxPendingDialogueObservations || pendingBytes + bytes > CONVERSATION_LIMITS.maxPendingDialogueBytes) {
      if (evidence.kind !== "backend") owner.coverage = "partial";
      this.failure ??= new Error(
        "Dialogue pending writes exceeded their bound"
      );
      if (after) {
        const refused = this.refusals.get(owner) ?? new Set<() => void>();
        let delivered = false;
        const deliver = () => { if (delivered) return; delivered = true; refused.delete(deliver); if (!refused.size) this.refusals.delete(owner); after(false); };
        refused.add(deliver); this.refusals.set(owner, refused);
        const prior = this.ownerWrites(owner);
        const done = Promise.allSettled(prior).then(deliver);
        this.track(done, owner, evidence.kind);
      }
      this.notifyFailure(owner, "queue_pressure", evidence.kind);
      return;
    }
    q.count++;
    q.bytes += bytes;
    this.queues.set(owner, q);
    const done = this.catalog
      .dialogueAppend({
        ownerId: owner.id,
        principalId: owner.principal_id,
        generation: owner.generation,
        identity,
        evidence,
      })
      .then(
        (record) => {
          if (this.withheld.has(owner)) return;
          this.publish(
            {
              ownerId: owner.id,
              ...(owner.session_id ? { sessionId: owner.session_id } : {}),
              generation: owner.generation,
              through: record.sequence,
              records: [record],
              coverage: owner.coverage,
            },
            owner.principal_id
          );
          after?.(true);
        },
        (error) => {
          // Preserve locally visible, explicitly unsaved evidence on storage failure.
          if (!this.withheld.has(owner)) after?.(false);
          throw error;
        }
      )
      .finally(() => {
        q.count--;
        q.bytes -= bytes;
        if (!q.count) this.queues.delete(owner);
      });
    this.track(done, owner, evidence.kind);
  }
  private notifyFailure(owner:DialogueOwner,cause:"queue_pressure"|"storage_error"|"storage_indeterminate",kind?:DialogueEvidence["kind"]):void {
    if(kind !== "backend") owner.coverage="partial";
    if(this.failedOwners.has(owner.id))return;
    this.failedOwners.add(owner.id);
    // A bounded notice latch, not retained history or a lifetime admission cap.
    if(this.failedOwners.size>128)this.failedOwners.delete(this.failedOwners.values().next().value!);
    this.failed(owner,cause,kind);
  }
  private track(done: Promise<unknown>, owner?: DialogueOwner, kind?: DialogueEvidence["kind"]): void {
    this.pending.add(done);
    const own=owner ? this.ownerPending.get(owner) ?? new Set<Promise<unknown>>() : undefined;
    if(owner && own){own.add(done);this.ownerPending.set(owner,own);}
    const release=()=>{this.pending.delete(done);own?.delete(done);if(owner && own?.size===0)this.ownerPending.delete(owner);};
    if (owner && !this.withheld.has(owner)) {
      // Bound each real operation, not the duration of a healthy continuous stream.
      void withinStorageBudget(done, "Dialogue write").catch(error => {
        if (error instanceof StorageSettlementIndeterminate) {
          this.withholdOwner(owner);
          this.notifyFailure(owner,"storage_indeterminate",kind);
        }
      });
    }
    void done.then(release,(error)=>{
      this.failure ??=error;
      release();
      if(owner)this.notifyFailure(owner,"storage_error",kind);
    });
  }
  private ownerWrites(owner: DialogueOwner): Promise<unknown>[] {
    return [...this.ownerPending].flatMap(([pendingOwner, writes]) => pendingOwner.id === owner.id ? [...writes] : []);
  }
  /** A logical failure boundary; actual write and capacity ownership is unchanged. */
  async settleOwner(owner: DialogueOwner): Promise<void> {
    if (this.withheld.has(owner)) throw new StorageSettlementIndeterminate("Dialogue owner drain");
    try {
      await withinStorageBudget((async () => {
        while (true) { const pending = this.ownerWrites(owner); if (!pending.length) return; await Promise.allSettled(pending); }
      })(), "Dialogue owner drain");
    } catch (error) {
      if (error instanceof StorageSettlementIndeterminate) {
        this.withholdOwner(owner);
      }
      throw error;
    }
  }
  private withholdOwner(owner: DialogueOwner): void {
    for (const pendingOwner of new Set([owner, ...this.ownerPending.keys()])) if (pendingOwner.id === owner.id) {
      this.withheld.add(pendingOwner); pendingOwner.coverage = "partial";
      // Explicit refusals were never submitted, unlike unknown writes.
      for (const deliver of [...(this.refusals.get(pendingOwner) ?? [])]) deliver();
    }
  }
  async settledWithinBudget(reportFailure: boolean = false): Promise<void> {
    await withinStorageBudget(this.settled(reportFailure), "Dialogue drain");
  }
  async settled(reportFailure: boolean = false): Promise<void> {
    while (this.pending.size) await Promise.allSettled([...this.pending]);
    if (reportFailure && this.failure) throw this.failure;
  }
}
