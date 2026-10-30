/** Chat-owned text evidence; independent of provider-native history and recovery-cache retention. */
import type { Database } from "bun:sqlite";
import type {
  DialogueEvidence,
  DialoguePage,
  DialogueRecord,
} from "@schlessera/brain-ui-sdk/protocol";
import {
  dialogueEvidenceSchema,
  dialogueRecordSchema,
} from "@schlessera/brain-ui-sdk/schemas";

export interface DialogueOwner {
  id: string;
  principal_id: string;
  session_id: string | null;
  generation: number;
  coverage: DialoguePage["coverage"];
}
export interface DialogueOpen {
  conversationId: string;
  principalId: string;
  epoch: number;
  providerId: string;
  sessionId?: string;
  historyOwnerId?: string;
}
export interface DialogueTarget {
  cursor?: string;
  sessionId?: string;
  ownerId?: string;
  generation?: number;
  through?: number;
  before?: number;
}
const MAX_PAGE_BYTES = 128 * 1024;
export function dialogueOwner(
  db: Database,
  target: DialogueTarget,
  principalId: string
): DialogueOwner | null {
  const row = target.sessionId
    ? db
        .query("SELECT * FROM dialogue_owners WHERE session_id=?")
        .get(target.sessionId)
    : db
        .query(
          "SELECT * FROM dialogue_owners WHERE id=COALESCE((SELECT owner_id FROM dialogue_aliases WHERE id=?),?)"
        )
        .get(target.ownerId ?? "", target.ownerId ?? "");
  if (!row) return null;
  const owner = row as DialogueOwner;
  if (owner.principal_id !== principalId)
    throw new Error("Dialogue ownership mismatch");
  if (target.generation !== undefined && owner.generation !== target.generation)
    throw new Error("Dialogue generation changed");
  return owner;
}
/** Retained native voice recovery is evidence; an ordinary session ID is not. */
export function hasUnretainedVoice(db: Database, principalId: string, sessionId: string): boolean {
  return !!db.query(`SELECT 1 FROM conversation_epochs e
    WHERE e.principal_id=? AND e.session_id=?
    AND NOT EXISTS (SELECT 1 FROM dialogue_conversations c WHERE c.id=e.id) LIMIT 1`).get(principalId, sessionId);
}
export interface ActiveDialogueEpoch {
  owner: DialogueOwner;
  epoch: number;
}
/** Host-submitted open not yet acknowledged by the worker; never supplied by a wire target. */
export interface PendingDialogueEpoch {
  input: DialogueOpen;
  generation: number;
  ownerId?: string;
  previousEpoch?: number;
}
function pendingEpochFor(db:Database, owner:DialogueOwner, row:{id:string;epoch:number;provider_id:string}, pending:readonly PendingDialogueEpoch[]):boolean {
  return pending.some(scope=>{
    const input=scope.input;
    if(input.conversationId!==row.id || input.epoch!==row.epoch || input.providerId!==row.provider_id
      || input.epoch <= (scope.previousEpoch ?? 0) || input.principalId!==owner.principal_id || scope.generation!==owner.generation) return false;
    // A pending submission is liveness only for the exact row its successful
    // earlier transaction could have opened, under the same durable owner.
    if(input.sessionId && input.sessionId!==owner.session_id) return false;
    // Provisional admission was validated when this exact row committed.
    // Adoption may since have bound it; only its canonical identity must persist.
    if(input.historyOwnerId && (input.sessionId || dialogueOwner(db,{ownerId:input.historyOwnerId},input.principalId)?.id!==owner.id)) return false;
    if(scope.ownerId) return dialogueOwner(db,{ownerId:scope.ownerId},input.principalId)?.id===owner.id;
    return input.sessionId || input.historyOwnerId ? true : dialogueOwner(db,{ownerId:input.conversationId},input.principalId)?.id===owner.id;
  });
}
function activeEpochFor(db:Database, owner:DialogueOwner, principalId:string, row:{id:string;epoch:number}, activeEpochs?:ReadonlyMap<string,ActiveDialogueEpoch>):ActiveDialogueEpoch|undefined {
  const active=activeEpochs?.get(row.id);
  if(!active || active.epoch!==row.epoch || active.owner.principal_id!==principalId || active.owner.generation!==owner.generation) return;
  // Adoption may commit before the catalog receives its acknowledgement.
  // Resolve only the durable alias; never infer a new generation or principal.
  return active.owner.id===owner.id || dialogueOwner(db,{ownerId:active.owner.id},principalId)?.id===owner.id ? active : undefined;
}
export function openDialogue(db: Database, input: DialogueOpen, activeEpochs?:ReadonlyMap<string,ActiveDialogueEpoch>, pending:readonly PendingDialogueEpoch[]=[]): DialogueOwner {
  return db
    .transaction(() => {
      const known = db
        .query("SELECT * FROM dialogue_conversations WHERE id=?")
        .get(input.conversationId) as {
        owner_id: string;
        epoch: number;
        provider_id: string;
        closed: number;
      } | null;
      if (
        known &&
        (input.epoch <= known.epoch || input.providerId !== known.provider_id)
      )
        throw new Error("Dialogue epoch or engine mismatch");
      let owner = dialogueOwner(
        db,
        known
          ? { ownerId: known.owner_id }
          : input.historyOwnerId
          ? { ownerId: input.historyOwnerId }
          : { sessionId: input.sessionId },
        input.principalId
      );
      if (
        input.historyOwnerId &&
        (!owner ||
          input.sessionId ||
          owner.session_id ||
          dialogueOwner(
            db,
            { ownerId: input.historyOwnerId },
            input.principalId
          )?.id !== owner.id)
      )
        throw new Error("Dialogue provisional owner unavailable");
      if (!owner) {
        const id = input.conversationId;
        db.prepare(
          "INSERT INTO dialogue_owners(id,principal_id,session_id,coverage,created_at) VALUES(?,?,?,?,?)"
        ).run(
          id,
          input.principalId,
          input.sessionId ?? null,
          input.sessionId && hasUnretainedVoice(db, input.principalId, input.sessionId) ? "legacy" : "complete",
          Date.now()
        );
        owner = dialogueOwner(db, { ownerId: id }, input.principalId)!;
      }
      const unfinished = (db.query("SELECT id,epoch,provider_id FROM dialogue_conversations WHERE owner_id=? AND closed=0 LIMIT ?").all(owner.id,(activeEpochs?.size ?? 0)+pending.length+1) as Array<{id:string;epoch:number;provider_id:string}>).some(row=>{
        const active=activeEpochFor(db,owner!,input.principalId,row,activeEpochs);
        // The same native ID must have a real close-before-open boundary.
        // Other exact healthy live IDs are not evidence of interruption.
        return row.id===input.conversationId || (active ? active.owner.coverage === "partial" : !pendingEpochFor(db,owner!,row,pending));
      });
      if (unfinished) {
        db.prepare(
          "UPDATE dialogue_owners SET coverage='partial' WHERE id=?"
        ).run(owner.id);
        owner = { ...owner, coverage: "partial" };
      }
      if (input.sessionId && owner.session_id !== input.sessionId)
        throw new Error("Dialogue session mismatch");
      db.prepare(
        "INSERT INTO dialogue_conversations(id,owner_id,epoch,provider_id) VALUES(?,?,?,?) ON CONFLICT(id) DO UPDATE SET epoch=excluded.epoch,closed=0"
      ).run(input.conversationId, owner.id, input.epoch, input.providerId);
      return owner;
    })
    .immediate();
}
export function bindDialogue(
  db: Database,
  conversationId: string,
  principalId: string,
  sessionId: string
): DialogueOwner | null {
  return db
    .transaction(() => {
      const c = db
        .query("SELECT owner_id FROM dialogue_conversations WHERE id=?")
        .get(conversationId) as { owner_id: string } | null;
      if (!c) return null;
      const owner = dialogueOwner(db, { ownerId: c.owner_id }, principalId)!;
      if (owner.session_id && owner.session_id !== sessionId)
        throw new Error("Dialogue session cannot change");
      const target = dialogueOwner(db, { sessionId }, principalId);
      if (target && target.id !== owner.id) {
        db.prepare(
          "UPDATE dialogue_records SET owner_id=? WHERE owner_id=?"
        ).run(target.id, owner.id);
        db.prepare(
          "UPDATE dialogue_conversations SET owner_id=? WHERE owner_id=?"
        ).run(target.id, owner.id);
        db.prepare(
          "UPDATE dialogue_aliases SET owner_id=? WHERE owner_id=?"
        ).run(target.id, owner.id);
        db.prepare("INSERT INTO dialogue_aliases VALUES(?,?)").run(
          owner.id,
          target.id
        );
        db.prepare(
          "UPDATE dialogue_owners SET coverage=CASE WHEN coverage='partial' OR ?='partial' THEN 'partial' ELSE coverage END WHERE id=?"
        ).run(owner.coverage, target.id);
        db.prepare("DELETE FROM dialogue_owners WHERE id=?").run(owner.id);
        return target;
      }
      db.prepare("UPDATE dialogue_owners SET session_id=? WHERE id=?").run(
        sessionId,
        owner.id
      );
      return { ...owner, session_id: sessionId };
    })
    .immediate();
}
export interface DialogueAppend {
  ownerId: string;
  principalId: string;
  generation: number;
  identity: string;
  evidence: DialogueEvidence;
}
export function appendDialogue(
  db: Database,
  input: DialogueAppend
): DialogueRecord {
  const evidence = dialogueEvidenceSchema.parse(input.evidence);
  if (
    evidence.kind === "backend" &&
    (evidence.end - evidence.start !== evidence.text.length ||
      Bun.SHA256.hash(evidence.text, "hex") !== evidence.digest)
  )
    throw new Error("Invalid dialogue range witness");
  const payload = JSON.stringify(evidence);
  if (
    Buffer.byteLength(payload) > 32 * 1024 ||
    !input.identity ||
    input.identity.length > 2048
  )
    throw new Error("Dialogue record exceeds bounds");
  return db
    .transaction(() => {
      const owner = dialogueOwner(db, input, input.principalId);
      if (!owner) throw new Error("Dialogue owner unavailable");
      if (evidence.kind === "voice") {
        const c = db
          .query(
            "SELECT owner_id,epoch,provider_id FROM dialogue_conversations WHERE id=?"
          )
          .get(evidence.conversationId) as {
          owner_id: string;
          epoch: number;
          provider_id: string;
        } | null;
        if (
          !c ||
          c.owner_id !== owner.id ||
          c.epoch !== evidence.epoch ||
          c.provider_id !== evidence.providerId
        )
          throw new Error("Dialogue source scope mismatch");
      }
      const old = db
        .query(
          "SELECT sequence,payload FROM dialogue_records WHERE owner_id=? AND identity=?"
        )
        .get(owner.id, input.identity) as {
        sequence: number;
        payload: string;
      } | null;
      if (old && old.payload !== payload)
        throw new Error("Conflicting dialogue identity");
      const sequence =
        old?.sequence ??
        Number(
          db
            .prepare(
              "INSERT INTO dialogue_records(owner_id,identity,payload) VALUES(?,?,?)"
            )
            .run(owner.id, input.identity, payload).lastInsertRowid
        );
      return { sequence, identity: input.identity, evidence };
    })
    .immediate();
}
/** Indexed newest-page read at an immutable high-water; no whole-chat materialization. */
export function readDialogue(
  db: Database,
  principalId: string,
  target: DialogueTarget,
  activeEpochs?: ReadonlyMap<string, ActiveDialogueEpoch>
): DialoguePage | null {
  const owner = dialogueOwner(db, target, principalId);
  if (!owner) return null;
  if (target.cursor) {
    if (target.cursor.length > 2048) throw new Error("Invalid dialogue cursor");
    const cursor = JSON.parse(
      Buffer.from(target.cursor, "base64url").toString("utf8")
    ) as {
      ownerId: string;
      generation: number;
      through: number;
      before: number;
    };
    const source = dialogueOwner(
      db,
      { ownerId: cursor.ownerId, generation: cursor.generation },
      principalId
    );
    if (
      source?.id !== owner.id ||
      ![cursor.through, cursor.before].every(
        (n) => Number.isSafeInteger(n) && n >= 0
      ) ||
      cursor.before > cursor.through
    )
      throw new Error("Dialogue cursor scope mismatch");
    target = {
      ...target,
      generation: cursor.generation,
      through: cursor.through,
      before: cursor.before,
    };
  } else if (target.before !== undefined)
    throw new Error("Dialogue cursor required");
  const high = db
    .query("SELECT MAX(sequence) AS n FROM dialogue_records WHERE owner_id=?")
    .get(owner.id) as { n: number | null };
  const through = target.through ?? high.n ?? 0;
  if (through > (high.n ?? 0))
    throw new Error("Dialogue cursor exceeds retained history");
  const rows = db
    .query(
      "SELECT sequence,identity,payload FROM dialogue_records WHERE owner_id=? AND sequence<=? AND sequence<? ORDER BY sequence DESC LIMIT 201"
    )
    .all(owner.id, through, target.before ?? Number.MAX_SAFE_INTEGER) as {
    sequence: number;
    identity: string;
    payload: string;
  }[];
  const records: DialogueRecord[] = [];
  let bytes = 1024;
  for (const row of rows.slice(0, 200)) {
    const record = dialogueRecordSchema.parse({
      sequence: row.sequence,
      identity: row.identity,
      evidence: JSON.parse(row.payload),
    });
    const e = record.evidence;
    if (
      e.kind === "backend" &&
      (e.end - e.start !== e.text.length ||
        Bun.SHA256.hash(e.text, "hex") !== e.digest)
    )
      throw new Error("Invalid retained dialogue range witness");
    const size = Buffer.byteLength(JSON.stringify(record)) + 1;
    if (bytes + size > MAX_PAGE_BYTES) break;
    records.push(record);
    bytes += size;
  }
  // One more row than live scopes proves interruption without a lifetime scan.
  const unclosed = db.query("SELECT id,epoch FROM dialogue_conversations WHERE owner_id=? AND closed=0 LIMIT ?").all(owner.id,(activeEpochs?.size ?? 0)+1) as Array<{id:string;epoch:number}>;
  const exactActive = (row:{id:string;epoch:number}) => activeEpochFor(db,owner,principalId,row,activeEpochs);
  const failedActive=unclosed.some(row=>exactActive(row)?.owner.coverage === "partial");
  const more = rows.length > records.length;
  return {
    ownerId: owner.id,
    ...(owner.session_id ? { sessionId: owner.session_id } : {}),
    generation: owner.generation,
    through,
    records: records.reverse(),
    ...(more
      ? {
          before: records[0]!.sequence,
          cursor: Buffer.from(
            JSON.stringify({
              ownerId: owner.id,
              generation: owner.generation,
              through,
              before: records[0]!.sequence,
            })
          ).toString("base64url"),
        }
      : {}),
    // An unclosed voice source cannot prove its final observations survived a
    // crash, even if a recovery UPDATE cannot commit. Backend text completeness
    // is reconciled against native messages by the existing range projection.
    // The catalog supplies only successfully opened, exact runtime scopes;
    // wire targets cannot supply liveness or override a failed owner.
    coverage: failedActive || owner.coverage === "complete" && unclosed.some(row=>!exactActive(row)) ? "partial" : owner.coverage,
  };
}

/** Terminal marker is evidence of a clean local close, never effect completion. */
export function closeDialogue(
  db: Database,
  conversationId: string,
  principalId: string,
  epoch: number,
  partial = false
): void {
  db.transaction(() => {
    const c = db
      .query("SELECT owner_id FROM dialogue_conversations WHERE id=?")
      .get(conversationId) as { owner_id: string } | null;
    if (!c) return;
    if (!dialogueOwner(db, { ownerId: c.owner_id }, principalId))
      throw new Error("Dialogue owner unavailable");
    if (partial)
      db.prepare(
        "UPDATE dialogue_owners SET coverage='partial' WHERE id=?"
      ).run(c.owner_id);
    db.prepare(
      "UPDATE dialogue_conversations SET closed=1 WHERE id=? AND epoch=?"
    ).run(conversationId, epoch);
  }).immediate();
}
